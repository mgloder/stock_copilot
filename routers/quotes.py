import asyncio
import json
import yfinance as yf
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from ib_client import ib_manager

router = APIRouter()

_PERIOD_MAP = {"5 D": "5d", "30 D": "1mo", "90 D": "3mo", "1 Y": "1y"}
_INTERVAL_MAP = {"1 min": "1m", "5 mins": "5m", "1 hour": "1h", "1 day": "1d"}


@router.get("/quote/{symbol}")
async def get_quote(symbol: str):
    return await ib_manager.get_historical_bars(symbol.upper())


@router.get("/chart/{symbol}")
async def get_chart(symbol: str, duration: str = "30 D", bar_size: str = "1 day"):
    bars = await ib_manager.get_historical_bars(symbol.upper(), duration, bar_size)
    if not bars:
        period = _PERIOD_MAP.get(duration, "1mo")
        interval = _INTERVAL_MAP.get(bar_size, "1d")
        df = yf.download(symbol.upper(), period=period, interval=interval, progress=False)
        if df.empty:
            return []
        if hasattr(df.columns, "levels"):
            df.columns = df.columns.get_level_values(0)
        df.index = df.index.astype(str)
        bars = [
            {"time": str(idx)[:10], "open": row["Open"], "high": row["High"],
             "low": row["Low"], "close": row["Close"], "volume": int(row["Volume"])}
            for idx, row in df.iterrows()
        ]
    return bars


@router.websocket("/ws/quotes/{symbol}")
async def quote_stream(websocket: WebSocket, symbol: str):
    await websocket.accept()
    symbol = symbol.upper()
    queue: asyncio.Queue = asyncio.Queue()

    async def push(data: dict):
        await queue.put(data)

    await ib_manager.subscribe_quotes(symbol, push)
    try:
        while True:
            try:
                data = await asyncio.wait_for(queue.get(), timeout=30)
                await websocket.send_text(json.dumps(data))
            except asyncio.TimeoutError:
                await websocket.send_text(json.dumps({"ping": True}))
    except WebSocketDisconnect:
        pass
    finally:
        ib_manager.unsubscribe_quotes(symbol)
