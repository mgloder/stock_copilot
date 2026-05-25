import asyncio
import json
import os
import logging
import re
from datetime import datetime, timezone
import httpx
import yfinance as yf
from typing import List
from fastapi import APIRouter, Query
from fastapi.responses import StreamingResponse
from openai import AsyncOpenAI

logger = logging.getLogger(__name__)
router = APIRouter()

_deepseek = None


def _get_deepseek():
    global _deepseek
    if _deepseek is None and os.getenv("DEEPSEEK_API_KEY"):
        _deepseek = AsyncOpenAI(
            api_key=os.getenv("DEEPSEEK_API_KEY"),
            base_url="https://api.deepseek.com",
        )
    return _deepseek


def _calc_rsi(closes: list[float], period: int = 14) -> float | None:
    if len(closes) < period + 1:
        return None
    deltas = [closes[i] - closes[i - 1] for i in range(1, len(closes))]
    gains = [max(d, 0.0) for d in deltas]
    losses = [max(-d, 0.0) for d in deltas]
    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period
    for i in range(period, len(gains)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period
    if avg_loss == 0:
        return 100.0
    return round(100 - 100 / (1 + avg_gain / avg_loss), 1)


def _sma_series(dates: list[str], closes: list[float], period: int) -> list[dict]:
    return [
        {"time": dates[i], "value": round(sum(closes[i - period + 1: i + 1]) / period, 2)}
        for i in range(period - 1, len(closes))
    ]


@router.get("/explore/{symbol}")
async def explore(symbol: str):
    sym = symbol.upper()
    ticker = yf.Ticker(sym)
    fast = ticker.fast_info

    current = getattr(fast, "last_price", None)
    prev_close = getattr(fast, "previous_close", None)
    change = round(current - prev_close, 2) if current and prev_close else None
    change_pct = round((current - prev_close) / prev_close * 100, 2) if current and prev_close else None

    df = yf.download(sym, period="90d", interval="1d", progress=False, auto_adjust=True)

    bars, sma20_series, sma50_series = [], [], []
    sma20 = sma50 = rsi = trend = signal = None

    if not df.empty:
        if hasattr(df.columns, "levels"):
            df.columns = df.columns.get_level_values(0)

        dates = [str(idx)[:10] for idx in df.index]
        closes = [float(v) for v in df["Close"].tolist()]

        bars = [
            {
                "time": dates[i],
                "open": float(df["Open"].iloc[i]),
                "high": float(df["High"].iloc[i]),
                "low": float(df["Low"].iloc[i]),
                "close": float(df["Close"].iloc[i]),
                "volume": int(df["Volume"].iloc[i]),
            }
            for i in range(len(dates))
        ]

        if len(closes) >= 20:
            sma20 = round(sum(closes[-20:]) / 20, 2)
            sma20_series = _sma_series(dates, closes, 20)
        if len(closes) >= 50:
            sma50 = round(sum(closes[-50:]) / 50, 2)
            sma50_series = _sma_series(dates, closes, 50)

        rsi = _calc_rsi(closes)

        if closes:
            price = closes[-1]
            if sma20 and sma50:
                if price > sma20 > sma50:
                    trend = "bullish"
                elif price < sma20 < sma50:
                    trend = "bearish"
                else:
                    trend = "neutral"

            if trend == "bullish" and (rsi is None or rsi < 70):
                signal = "buy"
            elif trend == "bearish" or (rsi is not None and rsi > 75):
                signal = "sell"
            else:
                signal = "hold"

    raw_news = ticker.news or []
    news = [
        {
            "title": item.get("content", {}).get("title", ""),
            "url": item.get("content", {}).get("canonicalUrl", {}).get("url", ""),
            "publisher": item.get("content", {}).get("provider", {}).get("displayName", ""),
            "publishedAt": item.get("content", {}).get("pubDate", ""),
            "summary": item.get("content", {}).get("summary", ""),
        }
        for item in raw_news[:12]
        if item.get("content", {}).get("title")
    ]

    return {
        "symbol": sym,
        "price": {
            "current": current,
            "prev_close": prev_close,
            "change": change,
            "change_pct": change_pct,
            "year_high": getattr(fast, "year_high", None),
            "year_low": getattr(fast, "year_low", None),
            "market_cap": getattr(fast, "market_cap", None),
            "volume": getattr(fast, "last_volume", None),
        },
        "technicals": {
            "sma20": sma20,
            "sma50": sma50,
            "rsi": rsi,
            "trend": trend,
            "signal": signal,
        },
        "bars": bars,
        "sma20_series": sma20_series,
        "sma50_series": sma50_series,
        "news": news,
    }


@router.get("/explore/{symbol}/technical")
async def explore_technical(symbol: str, rsi: float | None = None, sma20: float | None = None,
                            sma50: float | None = None, price: float | None = None,
                            trend: str | None = None, signal: str | None = None,
                            lang: str = "en"):
    client = _get_deepseek()
    if not client:
        return {"text": ""}

    parts = []
    if price is not None:
        parts.append(f"Current price: ${price:.2f}")
    if sma20 is not None:
        rel20 = "above" if price and price > sma20 else "below"
        parts.append(f"SMA20: ${sma20:.2f} (price is {rel20})")
    if sma50 is not None:
        rel50 = "above" if price and price > sma50 else "below"
        parts.append(f"SMA50: ${sma50:.2f} (price is {rel50})")
    if rsi is not None:
        zone = "overbought" if rsi > 70 else "oversold" if rsi < 30 else "neutral"
        parts.append(f"RSI-14: {rsi} ({zone})")
    if trend:
        parts.append(f"Trend: {trend}")
    if signal:
        parts.append(f"Signal: {signal}")

    if not parts:
        return {"text": "No technical data available."}

    lang_instr = "用简体中文回答。" if lang == "zh" else "Reply in English."
    summary = ", ".join(parts)
    try:
        resp = await client.chat.completions.create(
            model="deepseek-chat",
            max_tokens=200,
            messages=[
                {"role": "system", "content": f"You are a trading assistant. Explain technical indicators in 2-3 plain sentences. No bullet points, no headers. Be direct. {lang_instr}"},
                {"role": "user", "content": f"Interpret these technicals for {symbol.upper()}: {summary}"},
            ],
        )
        return {"text": resp.choices[0].message.content.strip()}
    except Exception as e:
        logger.warning("DeepSeek technical failed for %s: %s", symbol, e)
        return {"text": ""}


async def _brave_news(query: str, count: int = 6) -> list[dict]:
    api_key = os.getenv("BRAVE_SEARCH_API_KEY", "")
    proxy = os.getenv("ALL_PROXY") or os.getenv("HTTPS_PROXY") or os.getenv("HTTP_PROXY")
    try:
        async with httpx.AsyncClient(proxy=proxy, timeout=10) as client:
            resp = await client.get(
                "https://api.search.brave.com/res/v1/news/search",
                headers={
                    "Accept": "application/json",
                    "Accept-Encoding": "gzip",
                    "X-Subscription-Token": api_key,
                },
                params={"q": query, "count": count},
            )
            resp.raise_for_status()
            data = resp.json()
        results = data.get("results", [])
        return [
            {
                "title": r.get("title", ""),
                "url": r.get("url", ""),
                "body": r.get("description", ""),
                "source": r.get("meta_url", {}).get("hostname", ""),
                "date": r.get("age", ""),
            }
            for r in results
        ]
    except Exception as e:
        logger.warning("Brave search failed: %s", e)
        return []


async def _decompose_query(client: AsyncOpenAI, sym: str, q: str, lang: str) -> list[str]:
    """Ask DeepSeek to break the user query into 2-4 targeted sub-queries."""
    lang_instr = "用简体中文生成子查询。" if lang == "zh" else "Generate sub-queries in English."
    try:
        resp = await client.chat.completions.create(
            model="deepseek-chat",
            max_tokens=200,
            messages=[
                {
                    "role": "system",
                    "content": (
                        f"You are a financial research assistant. {lang_instr} "
                        "Return ONLY a JSON array of 2-4 concise search query strings, no explanation. "
                        "Example: [\"AAPL Q3 2024 earnings results\", \"Apple revenue guidance 2024\"]"
                    ),
                },
                {
                    "role": "user",
                    "content": f"Decompose this query about {sym} into 2-4 targeted web search queries: {q}",
                },
            ],
        )
        raw = resp.choices[0].message.content.strip()
        # Extract JSON array from the response (handles markdown code fences)
        match = re.search(r"\[.*?\]", raw, re.DOTALL)
        if match:
            sub_queries = json.loads(match.group())
            if isinstance(sub_queries, list) and sub_queries:
                return [str(sq) for sq in sub_queries[:4]]
    except Exception as e:
        logger.warning("DeepSeek decompose failed for %s: %s", sym, e)
    # Fallback: single query
    return [f"{sym} {q}"]


async def _aggregate(client: AsyncOpenAI, sym: str, q: str, results: list[dict], lang: str) -> str:
    """Ask DeepSeek to synthesize all search results into a final answer."""
    context = "\n\n".join(
        f"[{i + 1}] {r['title']}\n{r.get('body', '')}"
        for i, r in enumerate(results)
    ) if results else "No search results found."

    lang_instr = "用简体中文回答。" if lang == "zh" else "Reply in English."
    resp = await client.chat.completions.create(
        model="deepseek-chat",
        max_tokens=500,
        messages=[
            {
                "role": "system",
                "content": (
                    f"You are a financial research assistant. Answer the question using only the "
                    f"provided sources. Cite sources as [1], [2], etc. Be concise. {lang_instr}"
                ),
            },
            {
                "role": "user",
                "content": f"Question about {sym}: {q}\n\nSources:\n{context}",
            },
        ],
    )
    return resp.choices[0].message.content.strip()


def _sse(payload: dict) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


@router.get("/explore/{symbol}/query")
async def explore_query(symbol: str, q: str, lang: str = "en"):
    sym = symbol.upper()

    async def stream():
        client = _get_deepseek()
        if not client:
            yield _sse({"type": "result", "answer": "DEEPSEEK_API_KEY not configured.", "sources": []})
            return

        # Step 1: decompose
        thinking_decompose = "Decomposing query into sub-searches…" if lang == "en" else "将查询分解为子搜索…"
        yield _sse({"type": "thinking", "text": thinking_decompose})

        sub_queries = await _decompose_query(client, sym, q, lang)

        sq_preview = " | ".join(f'"{sq}"' for sq in sub_queries)
        yield _sse({"type": "thinking", "text": f"Sub-queries: {sq_preview}" if lang == "en" else f"子查询：{sq_preview}"})

        # Step 2: parallel Brave searches
        thinking_search = f"Running {len(sub_queries)} searches in parallel…" if lang == "en" else f"并行执行 {len(sub_queries)} 次搜索…"
        yield _sse({"type": "thinking", "text": thinking_search})

        search_tasks = [_brave_news(sq, count=5) for sq in sub_queries]
        batch_results = await asyncio.gather(*search_tasks)

        # Step 3: deduplicate by URL and stream per-query counts
        seen_urls: set[str] = set()
        all_results: list[dict] = []
        for sq, batch in zip(sub_queries, batch_results):
            new_count = 0
            for r in batch:
                url = r.get("url", "")
                if url and url not in seen_urls:
                    seen_urls.add(url)
                    all_results.append(r)
                    new_count += 1
            found_msg = (
                f'"{sq}" → {new_count} result{"s" if new_count != 1 else ""} found'
                if lang == "en"
                else f'"{sq}" → 找到 {new_count} 条结果'
            )
            yield _sse({"type": "thinking", "text": found_msg})

        total_msg = (
            f"Aggregating {len(all_results)} unique sources…"
            if lang == "en"
            else f"正在汇总 {len(all_results)} 条独立来源…"
        )
        yield _sse({"type": "thinking", "text": total_msg})

        # Step 4: aggregate
        try:
            answer = await _aggregate(client, sym, q, all_results, lang)
        except Exception as e:
            logger.warning("DeepSeek aggregate failed for %s: %s", sym, e)
            answer = "Analysis unavailable." if lang == "en" else "分析暂不可用。"

        sources = [
            {"title": r["title"], "url": r["url"], "source": r["source"], "date": r["date"]}
            for r in all_results
        ]
        yield _sse({"type": "result", "answer": answer, "sources": sources})

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/explore/{symbol}/analysis")
async def explore_analysis(
    symbol: str,
    lang: str = "en",
    factors: List[str] = Query(default=[]),
    price: float | None = None,
    year_high: float | None = None,
    year_low: float | None = None,
    market_cap: float | None = None,
    sma20: float | None = None,
    sma50: float | None = None,
    rsi: float | None = None,
    trend: str | None = None,
    signal: str | None = None,
    profile_text: str | None = None,
):
    sym = symbol.upper()

    async def stream():
        # ── Collect news ─────────────────────────────────────────────────────
        t1 = "正在获取最新新闻…" if lang == "zh" else "Fetching latest news headlines…"
        yield _sse({"type": "thinking", "text": t1})

        ticker = yf.Ticker(sym)
        raw_news = ticker.news or []
        headlines = "\n".join(
            f"- {item.get('content', {}).get('title', '')}"
            for item in raw_news[:8]
            if item.get("content", {}).get("title")
        )
        n_news = len([i for i in raw_news[:8] if i.get("content", {}).get("title")])
        t2 = f"找到 {n_news} 条新闻标题。" if lang == "zh" else f"Found {n_news} news headlines."
        yield _sse({"type": "thinking", "text": t2})

        client = _get_deepseek()
        if not client:
            yield _sse({"type": "result", "weighing": "", "analysis": "DEEPSEEK_API_KEY is not configured."})
            return

        lang_instr = "用简体中文回答。" if lang == "zh" else "Reply in English."

        # ── Build context blocks ─────────────────────────────────────────────
        tech_parts = []
        if price is not None:
            tech_parts.append(f"Current price: ${price:.2f}")
        if year_high is not None and year_low is not None:
            pct_from_high = round((price - year_high) / year_high * 100, 1) if price else None
            range_str = f"52-week range: ${year_low:.2f} – ${year_high:.2f}"
            if pct_from_high is not None:
                range_str += f" ({pct_from_high:+.1f}% from high)"
            tech_parts.append(range_str)
        if market_cap is not None:
            mc = market_cap
            mc_str = f"${mc/1e12:.2f}T" if mc >= 1e12 else f"${mc/1e9:.1f}B" if mc >= 1e9 else f"${mc/1e6:.0f}M"
            tech_parts.append(f"Market cap: {mc_str}")
        if sma20 is not None and price is not None:
            tech_parts.append(f"SMA20: ${sma20:.2f} (price is {'above' if price > sma20 else 'below'})")
        if sma50 is not None and price is not None:
            tech_parts.append(f"SMA50: ${sma50:.2f} (price is {'above' if price > sma50 else 'below'})")
        if rsi is not None:
            zone = "overbought" if rsi > 70 else "oversold" if rsi < 30 else "neutral zone"
            tech_parts.append(f"RSI-14: {rsi} ({zone})")
        if trend:
            tech_parts.append(f"Trend: {trend}")
        if signal:
            tech_parts.append(f"Technical signal: {signal}")

        tech_block = ("**Technical indicators:**\n" + "\n".join(f"- {p}" for p in tech_parts) + "\n\n") if tech_parts else ""

        factors_section = ("\n".join(f"- {f}" for f in factors)) if factors else ("None provided." if lang == "en" else "用户未提供。")

        now_utc = datetime.now(timezone.utc)
        date_str = now_utc.strftime("%A, %B %d, %Y")
        time_str = now_utc.strftime("%H:%M UTC")

        if profile_text:
            profile_block = (
                f" You are advising an investor who describes themselves as follows: \"{profile_text}\". "
                "Frame your entire analysis — factor weighting, risk assessment, and final recommendation — "
                "from this investor's perspective. Tailor the conclusion to their goals and constraints."
            )
        else:
            profile_block = ""

        system_msg = (
            f"You are a professional financial analyst. Be concise, objective, and structured. "
            f"Today is {date_str}, {time_str}.{profile_block} {lang_instr}"
        )

        if lang == "zh":
            stage1_prompt = (
                f"请分别评估以下三类信息源对 {sym} 的影响，并为每类给出：\n"
                "① 2-3句客观评估  ② 方向：看多 / 中性 / 看空  ③ 权重：高 / 中 / 低\n\n"
                f"**[1] 技术指标**\n{tech_block or '无数据。'}\n"
                f"**[2] 近期新闻标题**\n{headlines or '无新闻。'}\n\n"
                f"**[3] 用户提供的事实**\n{factors_section}\n\n"
                "请保持简洁，此输出将作为第二阶段结论的输入。"
            )
            stage2_prompt = (
                f"根据以上因子权重评估，为 {sym} 生成最终结构化建议。权重高的因子应主导结论。\n\n"
                "**多头逻辑**（2-3句，聚焦高权重正向催化剂）\n"
                "**空头逻辑**（2-3句，聚焦高权重风险）\n"
                "**近期展望**（未来2-4周的关注点）\n"
                "**整体情绪**（看多 / 中性 / 看空，附一句权重加权理由）"
            )
        else:
            stage1_prompt = (
                f"Assess the following three input sources for {sym}. For each provide:\n"
                "① 2-3 sentence assessment  ② Direction: Bullish / Neutral / Bearish"
                "  ③ Weight: High / Medium / Low (signal strength and reliability)\n\n"
                f"**[1] Technical Indicators**\n{tech_block or 'No data available.'}\n"
                f"**[2] Recent News Headlines**\n{headlines or 'No news available.'}\n\n"
                f"**[3] User-Provided Facts**\n{factors_section}\n\n"
                "Be concise. This output feeds a second-stage conclusion."
            )
            stage2_prompt = (
                f"Based on the factor-weighting above, generate the final structured recommendation for {sym}. "
                "High-weight factors must dominate the conclusion.\n\n"
                "**Bull Thesis** (2-3 sentences — driven by high-weight bullish factors)\n"
                "**Bear Thesis** (2-3 sentences — driven by high-weight risk factors)\n"
                "**Near-Term Outlook** (what to watch in the next 2-4 weeks)\n"
                "**Overall Sentiment** (bullish / neutral / bearish with a one-sentence justification "
                "that reflects the relative factor weights)"
            )

        # ── Stage 1: factor weighting ────────────────────────────────────────
        t3 = "阶段一：对各信息源进行权重评估…" if lang == "zh" else "Stage 1: weighing all factor sources…"
        yield _sse({"type": "thinking", "text": t3})
        try:
            stage1_resp = await client.chat.completions.create(
                model="deepseek-chat",
                max_tokens=600,
                messages=[
                    {"role": "system", "content": system_msg},
                    {"role": "user",   "content": stage1_prompt},
                ],
            )
            weighing = stage1_resp.choices[0].message.content.strip()
        except Exception as e:
            logger.warning("DeepSeek stage1 failed for %s: %s", sym, e)
            yield _sse({"type": "result", "weighing": "", "analysis": "Analysis unavailable at this time."})
            return

        t4 = "阶段一完成，正在生成加权结论…" if lang == "zh" else "Stage 1 complete — generating weighted conclusion…"
        yield _sse({"type": "thinking", "text": t4})

        # ── Stage 2: conclusion ──────────────────────────────────────────────
        try:
            stage2_resp = await client.chat.completions.create(
                model="deepseek-chat",
                max_tokens=700,
                messages=[
                    {"role": "system",    "content": system_msg},
                    {"role": "user",      "content": stage1_prompt},
                    {"role": "assistant", "content": weighing},
                    {"role": "user",      "content": stage2_prompt},
                ],
            )
            analysis = stage2_resp.choices[0].message.content.strip()
        except Exception as e:
            logger.warning("DeepSeek stage2 failed for %s: %s", sym, e)
            yield _sse({"type": "result", "weighing": weighing, "analysis": "Conclusion unavailable at this time."})
            return

        yield _sse({"type": "result", "weighing": weighing, "analysis": analysis})

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
