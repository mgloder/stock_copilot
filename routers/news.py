import os
import json
import logging
import yfinance as yf
from fastapi import APIRouter
from openai import AsyncOpenAI

logger = logging.getLogger(__name__)

router = APIRouter()
_deepseek = None


def get_deepseek():
    global _deepseek
    if _deepseek is None and os.getenv("DEEPSEEK_API_KEY"):
        _deepseek = AsyncOpenAI(
            api_key=os.getenv("DEEPSEEK_API_KEY"),
            base_url="https://api.deepseek.com",
        )
    return _deepseek


@router.get("/news/{symbol}")
async def get_news(symbol: str, analyze: bool = False):
    ticker = yf.Ticker(symbol.upper())
    raw_news = ticker.news or []

    articles = [
        {
            "title": item.get("content", {}).get("title", ""),
            "summary": item.get("content", {}).get("summary", ""),
            "url": item.get("content", {}).get("canonicalUrl", {}).get("url", ""),
            "publisher": item.get("content", {}).get("provider", {}).get("displayName", ""),
            "publishedAt": item.get("content", {}).get("pubDate", ""),
            "impact": None,
        }
        for item in raw_news[:10]
    ]

    client = get_deepseek()
    if analyze and client and articles:
        headlines = "\n".join(
            f"{i+1}. {a['title']}" for i, a in enumerate(articles) if a["title"]
        )
        response = await client.chat.completions.create(
            model="deepseek-chat",
            max_tokens=512,
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are a financial analyst. For each news headline, rate the likely market impact "
                        "on the stock as: bullish, bearish, or neutral. Reply with a JSON array of objects "
                        "with keys 'index' (1-based) and 'impact' (one of: bullish, bearish, neutral) and "
                        "'reason' (one brief sentence). No markdown."
                    ),
                },
                {"role": "user", "content": f"Stock: {symbol.upper()}\n\nHeadlines:\n{headlines}"},
            ],
        )
        try:
            impacts = json.loads(response.choices[0].message.content)
            impact_map = {item["index"]: item for item in impacts}
            for i, article in enumerate(articles):
                info = impact_map.get(i + 1, {})
                article["impact"] = info.get("impact", "neutral")
                article["reason"] = info.get("reason", "")
        except (json.JSONDecodeError, IndexError, KeyError):
            logger.warning("Failed to parse DeepSeek impact analysis response: %r", response.choices[0].message.content)

    return {"symbol": symbol.upper(), "articles": articles, "analyzed": analyze and client is not None}
