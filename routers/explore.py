import os
import logging
import yfinance as yf
from fastapi import APIRouter
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


@router.get("/explore/{symbol}/analysis")
async def explore_analysis(symbol: str):
    sym = symbol.upper()
    ticker = yf.Ticker(sym)
    fast = ticker.fast_info
    current = getattr(fast, "last_price", None)
    price_str = f"${current:.2f}" if current else "N/A"

    raw_news = ticker.news or []
    headlines = "\n".join(
        f"- {item.get('content', {}).get('title', '')}"
        for item in raw_news[:8]
        if item.get("content", {}).get("title")
    )

    client = _get_deepseek()
    if not client:
        return {"analysis": "DEEPSEEK_API_KEY is not configured."}

    try:
        response = await client.chat.completions.create(
            model="deepseek-chat",
            max_tokens=700,
            messages=[
                {
                    "role": "system",
                    "content": "You are a professional financial analyst. Be concise, objective, and structured.",
                },
                {
                    "role": "user",
                    "content": (
                        f"Analyze {sym} (current price: {price_str}) based on these recent news headlines:\n\n"
                        f"{headlines}\n\n"
                        "Provide a structured analysis with these four sections:\n"
                        "**Bull Thesis** (2-3 sentences on positive catalysts)\n"
                        "**Bear Thesis** (2-3 sentences on key risks)\n"
                        "**Near-Term Outlook** (what to watch in the next 2-4 weeks)\n"
                        "**Overall Sentiment** (bullish / neutral / bearish with a one-sentence justification)\n\n"
                        "Be data-driven and reference specific news items where relevant."
                    ),
                },
            ],
        )
        return {"analysis": response.choices[0].message.content}
    except Exception as e:
        logger.warning("DeepSeek explore analysis failed for %s: %s", sym, e)
        return {"analysis": "Analysis unavailable at this time."}
