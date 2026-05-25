# ADR-0003: AI News Impact Analysis as an Optional, Query-Flag-Gated Feature

## Status
Accepted

## Date
2026-05-25

## Context
The news panel surfaces recent headlines for the selected symbol. A natural enhancement is to label each headline with a predicted market impact (bullish, bearish, neutral) so the user can quickly assess sentiment without reading every article. The Anthropic API (Claude Haiku) can perform this classification cheaply per request.

However, this feature has two meaningful constraints. First, it requires a paid API key (`ANTHROPIC_API_KEY`) that not all users will have or want to configure. Second, the AI call adds latency to the news endpoint and incurs a per-request cost that should only be paid when the user explicitly requests it. The default news load should be fast and free.

## Decision Drivers
- The `ANTHROPIC_API_KEY` is optional; the application must be fully functional without it
- AI analysis adds latency and per-call cost — it should only execute on explicit user intent
- The news endpoint must remain usable and return well-formed data regardless of whether the API key is set or the `analyze` flag is passed
- The Anthropic client should not be initialized at startup if the key is absent — fail-open, not fail-closed

## Considered Options

### Option 1: Always analyze news if the API key is set
Every call to `GET /api/news/{symbol}` runs the Claude analysis when `ANTHROPIC_API_KEY` is present.

**Pros:**
- Simpler API surface — no query parameter needed
- Users always get impact labels without clicking anything

**Cons:**
- Every page navigation to a new symbol incurs an Anthropic API call and its latency, even when the user is not interested in sentiment analysis
- Cost accumulates invisibly for a feature the user did not actively invoke
- Harder to use the endpoint programmatically without triggering AI cost

### Option 2: Separate endpoint (e.g., GET /api/news-analysis/{symbol})
Analysis is a distinct endpoint; the base news endpoint never calls Claude.

**Pros:**
- Clean REST semantics — resources are clearly separated
- The base endpoint has no dependency on Anthropic at all

**Cons:**
- The frontend must make two requests and merge results, adding complexity and a waterfall
- Caching the news list while only invalidating the analysis is more complex

### Option 3: Query parameter `?analyze=bool` on the news endpoint (chosen)
`GET /api/news/{symbol}` returns articles with `impact: null` by default. When `?analyze=true` is passed and the Anthropic client is available, each article's `impact` and `reason` fields are populated by Claude Haiku. The response always includes an `analyzed` boolean so the frontend knows whether impact labels are present.

**Pros:**
- Single endpoint, single response shape — the frontend always deals with the same JSON structure
- Analysis is only triggered by explicit user action (the "AI Impact" button in the UI)
- The Anthropic client is lazily initialized on first use; if the key is absent it remains `None` and the analysis block is skipped silently
- The `analyzed` field in the response allows the frontend to distinguish "analysis was requested and succeeded" from "analysis was requested but key is missing"

**Cons:**
- A `GET` request with a side effect (API call, cost) is slightly unconventional; a `POST` would be more semantically correct for an operation that consumes an external resource
- JSON parsing of the Claude response (`json.loads(message.content[0].text)`) is fragile — if the model deviates from the instructed format, the `except` block silently swallows the error and leaves all `impact` fields as `null`

## Decision
AI news impact analysis is gated behind the `?analyze=true` query parameter and requires `ANTHROPIC_API_KEY` to be set in the environment. The Anthropic client is lazily instantiated on first use. Articles always carry an `impact` field (defaulting to `null`) and the response always carries an `analyzed` boolean, giving the frontend a consistent schema to render regardless of whether analysis ran. This design makes the feature zero-cost and zero-latency when not requested, and completely inert when the API key is absent.

## Consequences

### Positive
- The dashboard installs and runs without any Anthropic credential; the feature is a true optional add-on
- Analysis latency is never incurred on page load — only on an explicit user action
- The consistent response schema means the frontend does not need conditional rendering logic based on whether analysis is enabled

### Negative / Trade-offs
- The silent failure mode on Claude response parse errors means a malformed model output results in articles with no impact labels and no error signal to the user or logs
- Using `GET` for an operation with external side effects is a minor REST convention violation

### Risks & Mitigations
- **Risk:** Claude Haiku returns malformed JSON, causing silent null impact labels. **Mitigation:** The current `except (json.JSONDecodeError, IndexError, KeyError)` is correct to catch, but should log the raw response at DEBUG level so failures are diagnosable. A schema validation step (e.g., checking that `index` values are in range) would improve robustness.
- **Risk:** API key is accidentally committed. **Mitigation:** `.env` is loaded via `python-dotenv`; `.env.example` (without the key) is committed, and `.env` should be in `.gitignore`.
- **Risk:** Anthropic model name (`claude-haiku-4-5-20251001`) becomes deprecated. **Mitigation:** Update the model string in `routers/news.py`; no other change required.

## References
- [Anthropic API documentation](https://docs.anthropic.com/)
- [python-dotenv](https://github.com/theskumar/python-dotenv)
- `routers/news.py` — full implementation
- ADR-0001 — yfinance as the always-on news source; Claude only annotates, never fetches
