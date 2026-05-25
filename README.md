# Stock Monitor

A web dashboard for Interactive Brokers — portfolio positions, candlestick charts, and AI-analyzed news, all in one browser tab.

The backend is FastAPI with `ib_insync` connecting to IB Gateway or TWS. The frontend is plain HTML/JS (no build step) using TradingView Lightweight Charts for candlestick rendering. News analysis is handled by Claude Haiku via the Anthropic API. When IB is disconnected, chart and news data fall back automatically to Yahoo Finance.

---

## Quick Start

### 1. Prerequisites

- Python 3.11+
- IB Gateway or TWS running locally with API access enabled (see [Enabling API access](#enabling-api-access) below)
- An Anthropic API key if you want AI news impact labels (optional — the rest works without it)

### 2. Clone and install

```bash
cd stock_monitoring
pip install -r requirements.txt
```

### 3. Configure

```bash
cp .env.example .env
```

Open `.env` and set your values:

```
IB_HOST=127.0.0.1
IB_PORT=4002
IB_CLIENT_ID=1
ANTHROPIC_API_KEY=your_key_here
```

See [Configuration](#configuration) for what each variable does and [Common IB ports](#common-ib-ports) for the right port number.

### 4. Start the server

```bash
uvicorn main:app --reload
```

Open **http://localhost:8000** in your browser.

You should see the dashboard load. If IB Gateway is running and connected, the portfolio panel populates automatically. If IB is not running, the dashboard still loads and falls back to Yahoo Finance for chart and news data.

---

## Configuration

| Variable | Default | Description |
|---|---|---|
| `IB_HOST` | `127.0.0.1` | Hostname or IP of the machine running IB Gateway / TWS |
| `IB_PORT` | `4002` | Port IB Gateway / TWS is listening on (see table below) |
| `IB_CLIENT_ID` | `1` | Identifies this connection to IB. **Must be unique** if you have multiple clients connecting simultaneously (e.g., this dashboard plus TWS's own connection, or two browser sessions running the server). Reusing an ID while another client holds it will cause the new connection to be rejected. |
| `ANTHROPIC_API_KEY` | _(unset)_ | Enables the AI news impact feature. If unset, the "AI Impact" button is silently disabled — no error is raised. |

### Common IB ports

| Application | Account type | Port |
|---|---|---|
| IB Gateway | Paper trading | `4002` |
| IB Gateway | Live trading | `4001` |
| TWS | Paper trading | `7497` |
| TWS | Live trading | `7496` |

The default `.env.example` uses `4002` (IB Gateway, paper trading). Change it to match your setup.

### Enabling API access

You must explicitly enable socket API connections in IB Gateway or TWS before this app can connect.

**IB Gateway:** Configure → Settings → API → Enable ActiveX and Socket Clients

**TWS:** Edit → Global Configuration → API → Settings → Enable ActiveX and Socket Clients

Both also let you restrict which IP addresses may connect. If you run the dashboard on the same machine as Gateway/TWS, `127.0.0.1` (the default) is sufficient.

---

## Running without IB (Yahoo Finance fallback)

The server starts and remains functional even if IB Gateway is not running or the connection is refused. In that mode:

- `GET /api/status` returns `{"connected": false}`
- `GET /api/portfolio` and `/api/positions` return empty results (no IB data source to fall back to)
- `GET /api/chart/{symbol}` falls back to Yahoo Finance automatically
- `GET /api/news/{symbol}` always uses Yahoo Finance (it is never sourced from IB)
- The WebSocket live quote stream (`/api/ws/quotes/{symbol}`) sends keepalive pings but no price data

This makes the chart and news panels fully usable without an IB connection, which is useful for development or for checking news on a symbol you don't hold.

---

## Features

### Portfolio panel (left)

- Account summary: Net Liquidation, Cash, Unrealized P&L, Realized P&L
- Positions table — click any row to load its chart and news

### Chart panel (center)

- Candlestick chart powered by TradingView Lightweight Charts
- Time ranges: 5D, 1M, 3M, 1Y
- Bar sizes: 1H, 1D
- Live last-price ticker via WebSocket (requires active IB connection)
- Falls back to Yahoo Finance data when IB is disconnected

### News panel (right)

- Latest headlines for the selected ticker (via Yahoo Finance)
- **AI Impact** button sends headlines to Claude Haiku and labels each article:
  - **Bullish** — likely positive price impact
  - **Bearish** — likely negative price impact
  - **Neutral** — minimal expected impact
- Requires `ANTHROPIC_API_KEY` to be set

---

## Project structure

```
stock_monitoring/
├── main.py              # FastAPI app entry point + IB connection lifecycle
├── ib_client.py         # IBManager singleton: connect, positions, quotes, historical bars, WebSocket subscriptions
├── routers/
│   ├── portfolio.py     # GET /api/portfolio, /api/positions
│   ├── quotes.py        # GET /api/quote/{sym}, /api/chart/{sym}
│   │                    # WS  /api/ws/quotes/{sym}
│   └── news.py          # GET /api/news/{sym}?analyze=true
├── static/
│   ├── index.html
│   ├── style.css
│   └── app.js
├── .env.example
├── requirements.txt
└── README.md
```

---

## API endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/api/status` | IB connection health check — returns `{"connected": true\|false}` |
| GET | `/api/portfolio` | Account summary + all positions |
| GET | `/api/positions` | Positions list only |
| GET | `/api/quote/{symbol}` | Snapshot bid / ask / last / volume for a symbol (requires IB) |
| GET | `/api/chart/{symbol}` | OHLCV bars; query params: `duration` (e.g. `30 D`), `bar_size` (e.g. `1 day`) |
| WS | `/api/ws/quotes/{symbol}` | Live quote stream; sends a `{"ping": true}` keepalive every 30 s when idle |
| GET | `/api/news/{symbol}` | News headlines; add `?analyze=true` to include AI impact labels |

---

## Development tips

### Auto-reload

`--reload` is already included in the Quick Start command. Uvicorn watches for file changes and restarts automatically. There is no frontend build step — edits to `static/` are served immediately on the next browser refresh.

### Testing endpoints without IB

Use `/api/status` first to confirm whether IB is connected:

```bash
curl http://localhost:8000/api/status
```

The chart and news endpoints work regardless of IB status:

```bash
# Chart data (falls back to Yahoo Finance if IB is down)
curl "http://localhost:8000/api/chart/AAPL?duration=5%20D&bar_size=1%20day"

# News without AI analysis
curl http://localhost:8000/api/news/AAPL

# News with AI impact labels (requires ANTHROPIC_API_KEY)
curl "http://localhost:8000/api/news/AAPL?analyze=true"
```

---

## Troubleshooting

### Connection refused on startup

```
IB Gateway connection failed: ...Connection refused...
```

The server starts normally and logs this message — it is not fatal. Verify that IB Gateway or TWS is running and that API connections are enabled (see [Enabling API access](#enabling-api-access)). Also check that `IB_PORT` in your `.env` matches the actual port the application is listening on.

### `util.patchAsyncio()` warning

`ib_insync` calls `util.patchAsyncio()` at import time in `ib_client.py`. This patches the running event loop so that `ib_insync`'s synchronous helpers work alongside FastAPI's async framework. The call is intentional — you may see a log message about it, which is normal and safe to ignore.

### Client ID conflict

If you see an error like `There is no valid client with clientId X` or a connection that immediately drops, another process is already connected to IB with the same `IB_CLIENT_ID`. Change the value in `.env` to any unused integer (e.g., `2`) and restart.

### Live quotes not updating

The WebSocket stream only pushes data when IB fires a `pendingTickersEvent` for the subscribed symbol. Outside market hours, or if IB's market data subscription for that symbol is not active, the stream will be silent except for the 30-second keepalive pings. Verify the symbol has market data enabled in your IB account.

### Yahoo Finance returns empty data

`yfinance` occasionally rate-limits or fails for less-liquid symbols. This manifests as an empty chart or no news articles. There is no authentication required — retrying after a short wait usually resolves it.
