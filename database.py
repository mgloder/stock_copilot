import asyncio
import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).parent / "data.db"


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def _init(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS profile (
            id         INTEGER PRIMARY KEY CHECK (id = 1),
            text       TEXT NOT NULL DEFAULT '',
            updated_at TEXT
        );

        INSERT OR IGNORE INTO profile (id, text) VALUES (1, '');

        CREATE TABLE IF NOT EXISTS factors (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            text       TEXT NOT NULL,
            position   INTEGER NOT NULL DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now'))
        );
    """)
    conn.commit()


async def init_db() -> None:
    def _run():
        with _connect() as conn:
            _init(conn)
    await asyncio.to_thread(_run)


# ── Profile ───────────────────────────────────────────────────────────────────

async def get_profile() -> str:
    def _run():
        with _connect() as conn:
            row = conn.execute("SELECT text FROM profile WHERE id = 1").fetchone()
            return row["text"] if row else ""
    return await asyncio.to_thread(_run)


async def set_profile(text: str) -> None:
    def _run():
        with _connect() as conn:
            conn.execute(
                "UPDATE profile SET text = ?, updated_at = datetime('now') WHERE id = 1",
                (text,),
            )
            conn.commit()
    await asyncio.to_thread(_run)


# ── Factors ───────────────────────────────────────────────────────────────────

async def get_factors() -> list[dict]:
    def _run():
        with _connect() as conn:
            rows = conn.execute(
                "SELECT id, text FROM factors ORDER BY position, id"
            ).fetchall()
            return [dict(r) for r in rows]
    return await asyncio.to_thread(_run)


async def add_factor(text: str) -> dict:
    def _run():
        with _connect() as conn:
            cur = conn.execute(
                "INSERT INTO factors (text, position) VALUES (?, COALESCE((SELECT MAX(position)+1 FROM factors), 0))",
                (text,),
            )
            conn.commit()
            row = conn.execute("SELECT id, text FROM factors WHERE id = ?", (cur.lastrowid,)).fetchone()
            return dict(row)
    return await asyncio.to_thread(_run)


async def delete_factor(factor_id: int) -> None:
    def _run():
        with _connect() as conn:
            conn.execute("DELETE FROM factors WHERE id = ?", (factor_id,))
            conn.commit()
    await asyncio.to_thread(_run)


async def clear_factors() -> None:
    def _run():
        with _connect() as conn:
            conn.execute("DELETE FROM factors")
            conn.commit()
    await asyncio.to_thread(_run)
