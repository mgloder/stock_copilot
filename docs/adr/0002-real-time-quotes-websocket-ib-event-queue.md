# ADR-0002: Real-Time Quotes via WebSocket Backed by IB Event Subscription and asyncio.Queue

## Status
Accepted

## Date
2026-05-25

## Context
The dashboard needs to display a live price ticker for the currently selected symbol. Polling the REST endpoint (`GET /api/quote/{symbol}`) on a short interval is the simplest approach, but it introduces unnecessary IB API calls and latency spikes between poll cycles. IB Gateway delivers market data via a push model: the `ib_insync` library fires a `pendingTickersEvent` whenever new tick data arrives for subscribed contracts.

FastAPI supports WebSockets natively. A persistent WebSocket connection from the browser to the server eliminates polling, and the server-side event handler can push data to the client the moment IB delivers it. The challenge is bridging the synchronous-style IB event callback (`pendingTickersEvent`) with an async WebSocket send, within the same asyncio event loop that `ib_insync` is patched to run on.

## Decision Drivers
- IB delivers market data via a push event, not a pull API — the architecture should match this model
- Polling the REST quote endpoint would create redundant IB subscriptions and introduce polling lag
- The bridge between the IB event system and the WebSocket must not block the event loop
- A single WebSocket connection per symbol per client is sufficient for the single-user use case
- A keepalive mechanism is needed so browsers and proxies do not time out idle connections when markets are closed

## Considered Options

### Option 1: Client-side polling of GET /api/quote/{symbol}
The frontend polls the existing REST endpoint every N seconds.

**Pros:**
- Zero new server-side complexity; the REST endpoint already exists
- Stateless — no subscription lifecycle to manage

**Cons:**
- Each poll creates a new IB `reqMktData` request and immediately cancels it (see `get_quote` in `ib_client.py`), which is wasteful and introduces a fixed 1.5-second sleep per call
- Minimum latency is bounded by the poll interval, not by IB event delivery
- Higher IB API pacing risk under frequent polling

### Option 2: WebSocket endpoint with asyncio.Queue bridge (chosen)
A `WS /api/ws/quotes/{symbol}` endpoint is added. On connection, it registers a callback with `IBManager.subscribe_quotes`, which hooks into `ib.pendingTickersEvent`. The callback enqueues tick data into a per-connection `asyncio.Queue`. The WebSocket handler loop dequeues and sends. A 30-second `wait_for` timeout triggers a `{"ping": true}` keepalive when no tick arrives.

**Pros:**
- Data is pushed to the client as fast as IB delivers it — no polling lag
- The `asyncio.Queue` decouples the synchronous-style IB event from the `await websocket.send_text` call cleanly and without thread synchronization primitives
- A single `reqMktData` subscription persists for the duration of the connection; IB pacing consumption is minimal
- The 30-second ping keepalive prevents proxy and browser timeouts during low-activity periods (after-hours, weekends)
- Subscription cleanup in the `finally` block of the WebSocket handler ensures IB market data is cancelled and the event handler is deregistered on any disconnect

**Cons:**
- Subscription state (`_subscriptions` dict on `IBManager`) must be managed carefully; a second WebSocket for the same symbol will silently skip subscription due to the `if symbol in self._subscriptions` guard, meaning the second client gets no data
- `asyncio.create_task` inside the synchronous `on_pending` callback assumes the IB event loop is the same event loop as FastAPI's — this works because `util.patchAsyncio()` is called at module load, but is an implicit coupling
- The queue is unbounded; a very fast ticker with a slow client could accumulate backpressure in memory

### Option 3: Server-Sent Events (SSE)
Use HTTP SSE instead of WebSockets for unidirectional server-to-client streaming.

**Pros:**
- SSE is simpler than WebSockets (no upgrade handshake, browser reconnects automatically)
- Works through HTTP/1.1 proxies that struggle with WebSocket upgrades

**Cons:**
- FastAPI SSE support requires additional wiring (`EventSourceResponse` via `sse-starlette`)
- SSE does not support client-to-server messages; any future bidirectional need would require a separate HTTP request
- Less idiomatic given that FastAPI ships WebSocket support out of the box

## Decision
The real-time quote stream is implemented as a WebSocket endpoint (`/api/ws/quotes/{symbol}`). On connection, a per-connection `asyncio.Queue` is created. `IBManager.subscribe_quotes` hooks into `ib.pendingTickersEvent` and enqueues ticks via `asyncio.create_task`. The WebSocket loop consumes the queue with a 30-second timeout and sends a ping frame when idle. Subscriptions are cleaned up in a `finally` block. This matches the IB push model directly, minimizes IB API pacing consumption, and delivers sub-second latency to the browser.

## Consequences

### Positive
- Price updates arrive as fast as IB emits them, with no polling overhead
- A single persistent IB `reqMktData` subscription per symbol is reused for the full WebSocket session duration
- Keepalive pings prevent silent connection drops during low-activity market hours

### Negative / Trade-offs
- The current `_subscriptions` guard means only the first WebSocket client per symbol receives live data; a second concurrent client would silently receive nothing. This is acceptable for a single-user dashboard but would need redesign for multi-user use
- The `asyncio.create_task` in the synchronous IB event callback relies on the shared event loop established by `util.patchAsyncio()` — this is a non-obvious coupling that must be preserved

### Risks & Mitigations
- **Risk:** Unbounded queue growth if the client cannot consume ticks fast enough. **Mitigation:** For a single ticker with 1-second tick frequency and a local browser, this is not a practical concern. A `Queue(maxsize=N)` with `put_nowait` and drop-on-full policy would address it if tick rates increase.
- **Risk:** IB subscription not cleaned up if the server process crashes. **Mitigation:** IB Gateway automatically drops subscriptions when the API client disconnects; no orphaned subscriptions persist across server restarts.

## References
- [ib_insync Events documentation](https://ib-insync.readthedocs.io/api.html#events)
- [FastAPI WebSockets](https://fastapi.tiangolo.com/advanced/websockets/)
- `ib_client.py` — `subscribe_quotes` / `unsubscribe_quotes` implementation
- `routers/quotes.py` — `quote_stream` WebSocket handler
