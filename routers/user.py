from fastapi import APIRouter
from pydantic import BaseModel
from database import get_profile, set_profile, get_factors, add_factor, delete_factor, clear_factors

router = APIRouter()


class ProfileBody(BaseModel):
    text: str


class FactorBody(BaseModel):
    text: str


@router.get("/user/profile")
async def read_profile():
    return {"text": await get_profile()}


@router.put("/user/profile")
async def write_profile(body: ProfileBody):
    await set_profile(body.text)
    return {"ok": True}


@router.get("/user/factors")
async def read_factors():
    return await get_factors()


@router.post("/user/factors")
async def create_factor(body: FactorBody):
    return await add_factor(body.text.strip())


@router.delete("/user/factors/{factor_id}")
async def remove_factor(factor_id: int):
    await delete_factor(factor_id)
    return {"ok": True}


@router.delete("/user/factors")
async def remove_all_factors():
    await clear_factors()
    return {"ok": True}
