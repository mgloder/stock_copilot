# ADR-0005: Static Frontend Served Directly from FastAPI via StaticFiles

## Status
Accepted

## Date
2026-05-25

## Context
The dashboard needs a browser-based UI. The primary question is how to deliver the frontend assets (HTML, CSS, JavaScript) and how tightly they should be coupled to the backend server. Options range from a fully decoupled frontend framework with its own build pipeline, to framework-generated server-side rendering, to plain static files co-located with and served by the FastAPI process.

This is a personal, single-developer tool. The UI requirements are straightforward: a three-panel layout, a candlestick chart (via TradingView Lightweight Charts loaded from CDN), WebSocket integration for live prices, and REST calls to the FastAPI backend. There is no requirement for server-side rendering, SEO, or a component-driven UI at scale.

## Decision Drivers
- Single developer, personal tool — operational simplicity is the dominant constraint
- No build step in the development workflow means no Node.js toolchain dependency
- The frontend is already written in plain HTML/CSS/JS; a rewrite is out of scope
- The backend and frontend are always deployed together as one process on a local machine — a separate frontend server provides no isolation benefit
- TradingView Lightweight Charts is loaded from CDN; no bundler is needed to consume third-party JS

## Considered Options

### Option 1: Plain static files served by FastAPI StaticFiles (chosen)
`app.mount("/static", StaticFiles(directory="static"), name="static")` serves the `static/` directory. The root route (`GET /`) returns `static/index.html` via `FileResponse`. No build step, no Node.js, no separate process.

**Pros:**
- Zero additional toolchain: `pip install -r requirements.txt` and `uvicorn main:app` is all that is needed
- No CORS configuration required — frontend and API share the same origin
- Hot-edit workflow: change `app.js` or `style.css`, reload the browser, done
- Deployment is a single Python process with no sidecar

**Cons:**
- No module bundling, tree-shaking, or transpilation — every JS feature used must be natively supported by the target browser
- No TypeScript, JSX, or any compile-to-JS language
- As the UI grows, a single `app.js` with no module system becomes harder to maintain

### Option 2: Separate SPA (React/Vue) with its own dev server and build step
Build the frontend with a modern framework (e.g., Vite + React). Serve the built dist via StaticFiles or a separate web server.

**Pros:**
- Component model scales well to complex UIs
- TypeScript support, hot module replacement, ecosystem of UI libraries
- Clear separation of concerns between frontend and backend codebases

**Cons:**
- Requires Node.js and npm/yarn in addition to Python
- Build step (`npm run build`) must run before the server can serve the latest frontend
- Development requires either running two processes (dev server + FastAPI) or configuring a proxy
- Significant complexity increase for a UI that currently fits in three files

### Option 3: Server-side rendering with Jinja2 templates
Use FastAPI's `Jinja2Templates` to render HTML server-side.

**Pros:**
- No client-side JavaScript framework needed
- Server can inject initial data directly into the page, eliminating the first API round-trip

**Cons:**
- Real-time updates (WebSocket live prices, dynamic chart range switching) still require client-side JavaScript
- Mixes template logic into the backend; a pure static frontend is simpler to reason about
- Adds `jinja2` as a dependency for marginal benefit

## Decision
The frontend is delivered as plain static HTML/CSS/JS files mounted on the FastAPI application via `StaticFiles`. This eliminates all frontend toolchain dependencies and keeps the entire application bootable with a single `uvicorn` command. The tradeoff — no module system, no TypeScript, no component framework — is accepted given the UI's current scope and the single-developer personal context. If the UI grows significantly in complexity, migrating to a Vite-based SPA that produces a built `static/` directory would be compatible with this mount point without changing the backend.

## Consequences

### Positive
- Development setup is `pip install` + `uvicorn main:app --reload` with no other prerequisites
- No CORS headers needed; the API and frontend are the same origin
- Browser cache invalidation is manual (query strings or hard reload), but this is acceptable for a local tool

### Negative / Trade-offs
- The `app.js` file will accumulate complexity without a module system to enforce boundaries
- Any third-party JS library that requires a bundler (e.g., does not ship an ESM CDN build) cannot be used

### Risks & Mitigations
- **Risk:** `static/app.js` grows large and becomes unmanageable as features are added. **Mitigation:** Split into multiple `<script type="module">` ES module files using native browser module support (no bundler needed). The `StaticFiles` mount serves them transparently.
- **Risk:** Browser compatibility issues with modern JS features used without transpilation. **Mitigation:** This is a personal tool running in the developer's own browser; compatibility scope is effectively one browser.

## References
- [FastAPI StaticFiles](https://fastapi.tiangolo.com/tutorial/static-files/)
- [TradingView Lightweight Charts](https://tradingview.github.io/lightweight-charts/) — loaded from CDN, no bundler needed
- `main.py` — `app.mount` and root `FileResponse`
