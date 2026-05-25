# ADR-0004: Singleton IBManager with FastAPI Lifespan-Managed Connection Lifecycle

## Status
Accepted

## Date
2026-05-25

## Context
The application requires exactly one connection to IB Gateway at any given time. IB Gateway enforces a `clientId` uniqueness constraint: two connections with the same `clientId` are rejected. Multiple concurrent connections would also multiply IB API pacing consumption and complicate subscription tracking.

FastAPI needs to share the IB connection across all routers (`portfolio.py`, `quotes.py`). The connection must be established before any request is handled and torn down cleanly when the server exits. FastAPI's lifespan context manager (introduced in Starlette 0.20) provides a first-class hook for exactly this initialization/teardown pattern and is the recommended replacement for the deprecated `on_event` startup/shutdown handlers.

## Decision Drivers
- IB Gateway allows only one connection per `clientId`; a single instance is a hard requirement
- All three routers need access to the same `IBManager` instance
- The connection must be established before FastAPI begins accepting requests
- The connection must be cleanly closed on server shutdown to release the IB Gateway slot
- Dependency injection (FastAPI `Depends`) adds boilerplate for what is effectively a process-wide singleton

## Considered Options

### Option 1: Module-level singleton with FastAPI lifespan (chosen)
`IBManager` is instantiated once at module load in `ib_client.py` as `ib_manager`. `main.py` imports it and wires connect/disconnect into the `@asynccontextmanager lifespan` function passed to `FastAPI(lifespan=lifespan)`. All routers import `ib_manager` directly from `ib_client`.

**Pros:**
- Simple and explicit: one import, one instance, one lifecycle hook
- Lifespan is the current FastAPI/Starlette idiom; `on_event` is deprecated
- No dependency injection wiring required; routers import the singleton directly
- Connection failure at startup is non-fatal (caught and logged); the server starts in a degraded state with fallback data sources available

**Cons:**
- The singleton is a global mutable object; unit testing any router requires patching `ib_client.ib_manager` or running a real IB connection
- Routers are tightly coupled to `ib_client` by direct import — the dependency is invisible to FastAPI's dependency graph

### Option 2: FastAPI Dependency Injection via Depends
`IBManager` is exposed through a `get_ib_manager()` dependency function and injected into route handlers via `Depends(get_ib_manager)`.

**Pros:**
- Makes the dependency explicit in route signatures
- Enables test overrides via `app.dependency_overrides`
- Consistent with FastAPI conventions for shared resources like database sessions

**Cons:**
- Adds boilerplate for a resource that is genuinely process-wide and never varies per request
- `Depends` is designed for per-request scoping (e.g., DB sessions); a singleton does not benefit from that model
- The lifespan hook still needs to hold a reference to the instance for connect/disconnect, creating a two-reference pattern that is more complex, not less

### Option 3: Application state via app.state
Store the `IBManager` instance on `app.state` in the lifespan function. Routers access it via `request.app.state.ib_manager`.

**Pros:**
- Explicit app-scoped state; no module-level global
- Avoids direct inter-module imports between routers and `ib_client`

**Cons:**
- Requires passing `Request` into every route handler that needs IB access, even handlers that do not otherwise use the request object
- More verbose than a direct import with no practical benefit for a single-process application

## Decision
`IBManager` is a module-level singleton in `ib_client.py`. Its connection lifecycle is managed by a FastAPI lifespan context manager in `main.py`. Routers import the singleton directly. This is the simplest approach that satisfies all constraints: single instance, correct startup/shutdown ordering, and connection failure that degrades gracefully rather than crashing the server.

## Consequences

### Positive
- Zero boilerplate in routers — `from ib_client import ib_manager` is sufficient
- Startup connection failure is non-fatal; the server starts and serves degraded data via yfinance fallback (see ADR-0001)
- Clean shutdown ensures the IB Gateway `clientId` slot is released, preventing a "client ID in use" error on the next server start

### Negative / Trade-offs
- Routers cannot be tested in isolation without either a live IB connection or patching the module-level singleton
- The `connected` flag on `IBManager` is the sole concurrency signal; there is no reconnection logic if IB drops mid-session

### Risks & Mitigations
- **Risk:** IB Gateway drops the connection after startup (network blip, Gateway restart). The `connected` flag stays `True` while subsequent IB calls will raise exceptions. **Mitigation:** Add a reconnection loop or a periodic health check that updates `connected`. For now, the user must restart the server to reconnect.
- **Risk:** Two server processes start with the same `IB_CLIENT_ID`. **Mitigation:** The connection attempt will raise an exception, which is caught and logged. Configure distinct `IB_CLIENT_ID` values per process via the `.env` file.

## References
- [FastAPI Lifespan Events](https://fastapi.tiangolo.com/advanced/events/)
- [ib_insync connectAsync](https://ib-insync.readthedocs.io/api.html#ib_insync.ib.IB.connectAsync)
- `main.py` — lifespan definition and router inclusion
- `ib_client.py` — `IBManager` class and `ib_manager` singleton
- ADR-0001 — degraded-mode fallback behavior when `connected` is false
