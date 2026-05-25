# ADR-0001: Dual Data Source — IB Gateway Primary, yfinance Fallback

## Status
Accepted

## Date
2026-05-25

## Context
The dashboard's primary value is displaying live, accurate portfolio and market data sourced directly from Interactive Brokers via `ib_insync`. IB Gateway or TWS must be running locally and have API connections enabled for this to work. This is a hard external dependency: if Gateway is not running, or if the user is traveling and cannot reach it, the entire application would be unusable without a fallback.

Two specific surfaces need market data that is not portfolio-specific and therefore does not require a live IB session to be meaningful: the candlestick chart (`/api/chart/{symbol}`) and the news feed (`/api/news/{symbol}`). Both of these can reasonably be served with free, publicly available data when IB is unavailable.

The alternative — returning empty responses or 503 errors when IB is disconnected — would make the dashboard completely useless as a research tool unless the user has their local trading software running.

## Decision Drivers
- IB Gateway is a locally-installed desktop application; it is not always running
- Chart data and financial news are not account-sensitive and can be sourced publicly
- Portfolio data (positions, account summary) is inherently IB-specific and has no meaningful public equivalent
- The target is a single-user personal dashboard; complexity budget is low — a silent fallback is preferable to an elaborate retry or multi-source abstraction layer
- yfinance is already a transitive concern for news (which always uses it); pulling it in for chart fallback adds no new dependency

## Considered Options

### Option 1: IB-only, fail with an error when disconnected
All endpoints return empty data or an HTTP error when `ib_manager.connected` is false.

**Pros:**
- No secondary data source to maintain or reason about
- Data consistency: the user always knows they are seeing IB data or nothing

**Cons:**
- The dashboard becomes unusable as a research tool whenever IB Gateway is closed
- Chart and news views serve no account-sensitive data yet are blocked by a connectivity check

### Option 2: yfinance as a silent fallback for chart and news (chosen)
IB is attempted first. If IB returns an empty result (because it is disconnected), the chart endpoint transparently falls back to yfinance. News always uses yfinance because yfinance provides a reliable, structured news API that IB does not.

**Pros:**
- Dashboard remains useful for market research when IB is offline
- Fallback is silent and requires no user action or configuration
- No new runtime dependency; yfinance is already present

**Cons:**
- Two codepaths per endpoint increases surface area for subtle data inconsistencies (e.g., yfinance and IB may differ in timezone handling, adjusted vs. unadjusted prices)
- The fallback condition is `if not bars` (empty return from IB), not an explicit `connected` check in the chart endpoint — this means a future IB error that returns an empty list rather than raising an exception would silently trigger the fallback without indicating a problem
- yfinance is an unofficial API with no SLA; it can break on Yahoo Finance schema changes

### Option 3: Dedicated market data microservice (e.g., Polygon.io, Alpha Vantage)
Replace yfinance with a paid or free-tier market data API to serve non-portfolio data unconditionally.

**Pros:**
- Stable, documented API with versioning guarantees
- Decouples market data from IB entirely

**Cons:**
- Introduces API key management and cost for a personal project
- Over-engineered relative to the scope and single-user audience

## Decision
The application uses IB Gateway as the primary source for all portfolio and market data, and falls back to yfinance silently when IB returns no data. News always uses yfinance, since IB does not provide a news API. This matches the degraded-mode design goal: the dashboard degrades gracefully to a read-only research tool when the broker connection is unavailable, without any configuration change or user intervention.

## Consequences

### Positive
- The chart and news panels remain functional during the majority of use cases where IB Gateway is closed
- Zero additional dependencies or configuration for the fallback path
- The `connected` field on `/api/portfolio` gives the frontend a clear signal to indicate broker status to the user

### Negative / Trade-offs
- Chart data from yfinance may not match IB data exactly (adjusted close prices, timezone offsets for intraday bars)
- The implicit fallback trigger (`if not bars`) in `quotes.py` is fragile; an IB error that produces an empty list is indistinguishable from a disconnected state

### Risks & Mitigations
- **Risk:** yfinance breaks due to an undocumented Yahoo Finance API change. **Mitigation:** yfinance is actively maintained; for a personal tool, a brief outage is acceptable. The IB path is unaffected.
- **Risk:** Users see different data depending on whether IB is connected, creating confusion. **Mitigation:** The `/api/status` endpoint and the `connected` flag in `/api/portfolio` allow the frontend to surface a clear "IB disconnected — showing public data" indicator.

## References
- [yfinance GitHub](https://github.com/ranaroussi/yfinance)
- [ib_insync documentation](https://ib-insync.readthedocs.io/)
- `routers/quotes.py` — chart endpoint fallback implementation
- `routers/news.py` — always-yfinance news implementation
