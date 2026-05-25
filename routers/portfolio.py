from fastapi import APIRouter
from ib_client import ib_manager

router = APIRouter()


@router.get("/portfolio")
async def get_portfolio():
    summary = await ib_manager.get_account_summary()
    positions = await ib_manager.get_positions()
    return {"connected": ib_manager.connected, "summary": summary, "positions": positions}


@router.get("/positions")
async def get_positions():
    return await ib_manager.get_positions()
