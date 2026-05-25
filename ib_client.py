import asyncio
import logging
import os
from ib_insync import IB, Stock, util
from dotenv import load_dotenv

logger = logging.getLogger(__name__)

load_dotenv()


class IBManager:
    def __init__(self):
        self.ib: IB | None = None
        self.connected = False
        self._subscriptions: dict = {}

    async def connect(self):
        # ib_insync's getLoop() uses get_event_loop_policy().get_event_loop() rather
        # than get_running_loop(); sync the policy to the running loop so they agree.
        asyncio.set_event_loop(asyncio.get_running_loop())
        self.ib = IB()
        host = os.getenv("IB_HOST", "127.0.0.1")
        port = int(os.getenv("IB_PORT", "4002"))
        client_id = int(os.getenv("IB_CLIENT_ID", "1"))
        try:
            await self.ib.connectAsync(host, port, clientId=client_id)
            self.connected = True
            logger.info("Connected to IB Gateway at %s:%s", host, port)
        except Exception as e:
            logger.warning("IB Gateway connection failed: %s", e)
            self.connected = False

    async def disconnect(self):
        if self.connected and self.ib is not None:
            self.ib.disconnect()
            self.connected = False

    async def get_account_summary(self) -> dict:
        if not self.connected:
            return {}
        tags = {"NetLiquidation", "TotalCashValue", "UnrealizedPnL", "RealizedPnL", "BuyingPower"}

        # ib_insync subscribes to account updates at startup (reqAccountUpdates is called
        # automatically by connectAsync). accountValues() reads from that live cache.
        values = self.ib.accountValues()

        # If cache is empty on first call, fetch via accountSummary path.
        if not values:
            values = await self.ib.accountSummaryAsync()

        # USD-denominated values only, to avoid double-counting multi-currency rows
        result = {}
        for v in values:
            if v.tag in tags and v.currency in ("USD", "BASE", ""):
                try:
                    result[v.tag] = float(v.value)
                except ValueError:
                    pass
        return result

    async def get_positions(self) -> list[dict]:
        if not self.connected:
            return []
        positions = await self.ib.reqPositionsAsync()
        return [
            {
                "symbol": pos.contract.symbol,
                "secType": pos.contract.secType,
                "position": pos.position,
                "avgCost": pos.avgCost,
                "account": pos.account,
            }
            for pos in positions
        ]

    async def get_historical_bars(self, symbol: str, duration: str = "30 D", bar_size: str = "1 day") -> list[dict]:
        if not self.connected:
            return []
        contract = Stock(symbol, "SMART", "USD")
        await self.ib.qualifyContractsAsync(contract)
        bars = await self.ib.reqHistoricalDataAsync(
            contract,
            endDateTime="",
            durationStr=duration,
            barSizeSetting=bar_size,
            whatToShow="TRADES",
            useRTH=True,
        )
        return [
            {"time": bar.date.isoformat(), "open": bar.open, "high": bar.high,
             "low": bar.low, "close": bar.close, "volume": bar.volume}
            for bar in bars
        ]

    async def subscribe_quotes(self, symbol: str, callback):
        if not self.connected or symbol in self._subscriptions:
            return
        contract = Stock(symbol, "SMART", "USD")
        await self.ib.qualifyContractsAsync(contract)
        self.ib.reqMktData(contract, "", False, False)

        def on_pending(tickers):
            for t in tickers:
                if t.contract.symbol == symbol:
                    asyncio.create_task(callback({
                        "symbol": symbol,
                        "bid": t.bid,
                        "ask": t.ask,
                        "last": t.last,
                        "volume": t.volume,
                    }))

        self.ib.pendingTickersEvent += on_pending
        self._subscriptions[symbol] = (contract, on_pending)

    def unsubscribe_quotes(self, symbol: str):
        if symbol not in self._subscriptions:
            return
        contract, handler = self._subscriptions.pop(symbol)
        self.ib.cancelMktData(contract)
        self.ib.pendingTickersEvent -= handler

    async def reconnect_loop(self):
        while True:
            await asyncio.sleep(30)
            try:
                if self.connected and self.ib is not None:
                    if not self.ib.isConnected():
                        self.connected = False
                        logger.warning("IB Gateway connection lost; will attempt reconnect")
                elif not self.connected:
                    await self.connect()
            except Exception as e:
                logger.warning("reconnect_loop error: %s", e)


ib_manager = IBManager()
