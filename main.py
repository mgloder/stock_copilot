import asyncio
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from ib_client import ib_manager
from routers import portfolio, quotes, news, explore, user
from database import init_db


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    await ib_manager.connect()
    _reconnect_task = asyncio.create_task(ib_manager.reconnect_loop())
    yield
    _reconnect_task.cancel()
    await ib_manager.disconnect()


app = FastAPI(title="Stock Monitor", lifespan=lifespan)

app.include_router(portfolio.router, prefix="/api")
app.include_router(quotes.router, prefix="/api")
app.include_router(news.router, prefix="/api")
app.include_router(explore.router, prefix="/api")
app.include_router(user.router, prefix="/api")

app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
async def root():
    return FileResponse("static/index.html")


@app.get("/api/status")
async def status():
    return {"connected": ib_manager.connected}
