import os
import asyncio
from datetime import datetime, timedelta
from collections import defaultdict, deque
from typing import Dict, Set

from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware
import clickhouse_connect

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # local dev; tighten later if you want
    allow_methods=["*"],
    allow_headers=["*"],
)

TOKEN = os.getenv("ORDERFLOW_TOKEN", "orderflow-secret")

# ClickHouse creds via env vars (no plaintext in code)
client = clickhouse_connect.get_client(
    host=os.getenv("CLICKHOUSE_HOST", "localhost"),
    port=int(os.getenv("CLICKHOUSE_PORT", 8123)),
    username=os.getenv("CLICKHOUSE_USER"),
    password=os.getenv("CLICKHOUSE_PASSWORD"),
    database=os.getenv("CLICKHOUSE_DATABASE", "binance_trades"),
)

QUERY = """
SELECT
    event_time,
    price,
    quantity,
    side,
    delta,
    volume_delta
FROM orderflow
WHERE coin = %(coin)s
  AND event_time > %(since)s
ORDER BY event_time
"""

# Subscribers per coin
clients_by_coin: Dict[str, Set[WebSocket]] = defaultdict(set)

# Cursor per coin (so we only fetch new rows)
last_ts_by_coin: Dict[str, datetime] = defaultdict(lambda: datetime.utcnow() - timedelta(seconds=30))

# Small ring buffer per coin (so new clients get an instant “warm start”)
buffer_by_coin: Dict[str, deque] = defaultdict(lambda: deque(maxlen=2000))

POLL_INTERVAL_SEC = 0.2


def serialize_rows(cols, rows):
    """Convert ClickHouse rows to JSON-safe dicts (datetime -> ISO string)."""
    out = []
    idx_event_time = cols.index("event_time")

    for r in rows:
        d = dict(zip(cols, r))
        et = d.get("event_time")
        if isinstance(et, datetime):
            d["event_time"] = et.isoformat()
        out.append(d)

    last_event_time = rows[-1][idx_event_time]
    return out, last_event_time


async def broadcaster():
    """Poll ClickHouse ONCE per active coin and broadcast to all connected clients."""
    while True:
        active_coins = [c for c, subs in clients_by_coin.items() if subs]

        for coin in active_coins:
            since = last_ts_by_coin[coin]

            try:
                result = client.query(QUERY, parameters={"coin": coin, "since": since})
            except Exception:
                continue

            rows = result.result_rows
            cols = result.column_names

            if not rows:
                continue

            payload, last_event_time = serialize_rows(cols, rows)

            if isinstance(last_event_time, datetime):
                last_ts_by_coin[coin] = last_event_time
            else:
                last_ts_by_coin[coin] = datetime.utcnow()

            # store in ring buffer
            for item in payload:
                buffer_by_coin[coin].append(item)

            # broadcast
            dead = []
            for ws in list(clients_by_coin[coin]):
                try:
                    await ws.send_json(payload)
                except Exception:
                    dead.append(ws)

            for ws in dead:
                clients_by_coin[coin].discard(ws)

        await asyncio.sleep(POLL_INTERVAL_SEC)


@app.on_event("startup")
async def on_startup():
    asyncio.create_task(broadcaster())


@app.websocket("/ws/orderflow/{coin}")
async def orderflow_ws(websocket: WebSocket, coin: str, token: str):
    if token != TOKEN:
        await websocket.close(code=1008)
        return

    await websocket.accept()

    coin = coin.lower()  # your DB stores coin like 'btcusdt'

    clients_by_coin[coin].add(websocket)

    # Warm start: send buffered recent events immediately
    if buffer_by_coin[coin]:
        try:
            await websocket.send_json(list(buffer_by_coin[coin]))
        except Exception:
            clients_by_coin[coin].discard(websocket)
            await websocket.close()
            return

    try:
        # Keep the connection open; broadcaster pushes data
        while True:
            await asyncio.sleep(60)
    finally:
        clients_by_coin[coin].discard(websocket)

