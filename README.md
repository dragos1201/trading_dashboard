# trading_dashboard

        (FREE)
  Binance WebSocket
           ↓
    Python Ingestion
  (async websockets)
           ↓
  ClickHouse (local)
   ───────────────────────────────
   Tables:
   • trades
   • orderflow
   • 1s bars
   • 1min bars
   • cvd
   • footprint
   Materialized Views compute all
   ───────────────────────────────
           ↓
   Cloudflare Tunnel (free)
           ↓
   Streamlit Cloud (free)
   Real-time dashboard
           ↓
      Grafana OSS (local)
  Pro analytics + heatmaps
           ↓
   Python Alerts (Telegram)


# Orderflow Dashboard

Real-time crypto orderflow visualization using:
- Binance trades
- ClickHouse
- FastAPI WebSockets
- Vanilla JS (DOM + Canvas)

## Components
- backend/: FastAPI WebSocket server
- frontend/: Footprint ladder, heatmap, CVD

## Status
Early research / prototyping stage.
Focus: correctness > visuals > signals.


