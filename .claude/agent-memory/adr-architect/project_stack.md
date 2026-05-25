---
name: Stock Monitoring Project Architecture
description: Core technology stack and ADR index for the stock_monitoring personal dashboard project
type: project
---

FastAPI (Python) + ib_insync personal stock monitoring dashboard. Five ADRs accepted as of 2026-05-25.

**Why:** Capturing decisions already implemented in the codebase to provide an authoritative record for future changes.
**How to apply:** When writing new ADRs for this project, start at 0006. Reference existing ADRs by number where decisions are related.

## Tech Stack
- FastAPI + uvicorn — web framework and ASGI server
- ib_insync — IB Gateway API client (primary data source)
- yfinance — fallback for charts and news when IB is disconnected
- Anthropic API (Claude Haiku) — optional AI news sentiment analysis (key: ANTHROPIC_API_KEY)
- Plain HTML/CSS/JS static frontend mounted via StaticFiles
- python-dotenv for env config; aiohttp as indirect dep

## Existing ADRs
- 0001: Dual data source (IB primary, yfinance fallback)
- 0002: Real-time quotes via WebSocket + asyncio.Queue bridging IB pendingTickersEvent
- 0003: AI news analysis gated behind ?analyze=true query flag, silently skipped without API key
- 0004: Singleton IBManager, lifespan-managed connection
- 0005: Static frontend served from FastAPI StaticFiles, no build step

## Key Constraints
- Single-user personal tool — simplicity over scalability
- IB Gateway clientId uniqueness enforced by broker; singleton is a hard requirement
- No Node.js/frontend build toolchain — deliberately avoided
