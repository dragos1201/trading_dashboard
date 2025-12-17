// =========================
// CONFIG
// =========================
const TOKEN = "orderflow-secret";
const API_HOST = "localhost:8000";
const COIN = "BTCUSDT";

const TICK_SIZE = 0.5;
const LEVELS = 25;
const ROWS = LEVELS * 2 + 1;

const CVD_MAX_POINTS = 320;

// Detection params
const DELTA_SPIKE_MULT = 3;
const ABSORPTION_VOL_THRESHOLD = 3;
const ABSORPTION_TICKS = 8;

// =========================
// DOM
// =========================
const pairEl = document.getElementById("pair");
const priceEl = document.getElementById("price");
const statusEl = document.getElementById("status");
const statusText = document.getElementById("statusText");

const statTotalBuys = document.getElementById("totalBuys");
const statTotalSells = document.getElementById("totalSells");
const statNetDelta = document.getElementById("netDelta");
const statCvd = document.getElementById("cvdValue");
const statLastUpdate = document.getElementById("lastUpdate");

const fpEl = document.getElementById("footprint");
const tapeEl = document.getElementById("tape");

const heatmap = document.getElementById("heatmap");
const hctx = heatmap ? heatmap.getContext("2d") : null;

const cvdCanvas = document.getElementById("cvdChart");
const cctx = cvdCanvas ? cvdCanvas.getContext("2d") : null;

// =========================
// STATE
// =========================
let ws = null;

let lastPriceBucket = null;
let lastPriceRaw = null;
let stableTicks = 0;

const footprint = new Map(); // price -> { buyQty, sellQty, deltaHistory, vol }

let cvd = 0;
const cvdSeries = [];

let totalBuys = 0;
let totalSells = 0;
let lastUpdate = null;

let needsRender = false;

// =========================
// HELPERS
// =========================
function wsUrl() {
  return `ws://${API_HOST}/ws/orderflow/${COIN}?token=${encodeURIComponent(TOKEN)}`;
}

function bucketPrice(p) {
  return Math.round(p / TICK_SIZE) * TICK_SIZE;
}

function ensureLevel(price) {
  if (!footprint.has(price)) {
    footprint.set(price, {
      buyQty: 0,
      sellQty: 0,
      deltaHistory: [],
      vol: 0
    });
  }
}

function avg(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function minMax(arr) {
  let mn = Infinity, mx = -Infinity;
  for (const v of arr) {
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  if (!Number.isFinite(mn) || !Number.isFinite(mx)) return [0, 1];
  if (mn === mx) {
    mn -= 1;
    mx += 1;
  }
  return [mn, mx];
}

// =========================
// RENDER SCHEDULER
// =========================
function scheduleRender() {
  if (needsRender) return;
  needsRender = true;

  requestAnimationFrame(() => {
    renderFootprint();
    renderHeatmap();
    renderCVD();
    renderStats();
    needsRender = false;
  });
}

// =========================
// FOOTPRINT LADDER (WITH SIGNALS)
// =========================
function renderFootprint() {
  if (lastPriceBucket === null || !fpEl) return;

  fpEl.innerHTML = "";

  // Build fixed price ladder around lastPriceBucket
  const prices = [];
  for (let i = LEVELS; i >= -LEVELS; i--) {
    const p = lastPriceBucket + i * TICK_SIZE;
    prices.push(p);
    ensureLevel(p);
  }

  // Max volume for cell intensity
  let maxVol = 1;
  for (const p of prices) {
    const l = footprint.get(p);
    maxVol = Math.max(maxVol, l.buyQty, l.sellQty);
  }

  for (const p of prices) {
    const l = footprint.get(p);

    const delta = l.buyQty - l.sellQty;
    const avgDelta = avg(l.deltaHistory);

    const spike =
      l.deltaHistory.length > 6 &&
      Math.abs(delta) > Math.max(1e-9, Math.abs(avgDelta)) * DELTA_SPIKE_MULT;

    // NOTE: this is a naive absorption heuristic (we’ll improve later)
    const absorption =
      l.vol >= ABSORPTION_VOL_THRESHOLD &&
      stableTicks >= ABSORPTION_TICKS &&
      p === lastPriceBucket;

    const row = document.createElement("div");
    row.className = "fp-row";

    if (p === lastPriceBucket) row.classList.add("fp-mid");
    if (spike && delta > 0) row.classList.add("fp-spike-buy");
    if (spike && delta < 0) row.classList.add("fp-spike-sell");
    if (absorption) row.classList.add("fp-absorption");

    const bi = l.buyQty / maxVol;
    const si = l.sellQty / maxVol;

    row.innerHTML = `
      <div class="fp-buy" style="background:rgba(63,185,80,${bi})">
        ${l.buyQty ? l.buyQty.toFixed(3) : ""}
      </div>
      <div class="fp-price">${p.toFixed(2)}</div>
      <div class="fp-sell" style="background:rgba(248,81,73,${si})">
        ${l.sellQty ? l.sellQty.toFixed(3) : ""}
      </div>
    `;

    fpEl.appendChild(row);
  }
}

// =========================
// HEATMAP (DELTA DOMINANCE)
// =========================
function renderHeatmap() {
  if (lastPriceBucket === null || !heatmap || !hctx) return;

  const rowH = heatmap.height ? heatmap.height / ROWS : 0;
  if (!rowH) return;

  const prices = [];
  let maxAbsDelta = 1;

  for (let i = LEVELS; i >= -LEVELS; i--) {
    const p = lastPriceBucket + i * TICK_SIZE;
    prices.push(p);
    ensureLevel(p);
    const l = footprint.get(p);
    maxAbsDelta = Math.max(maxAbsDelta, Math.abs(l.buyQty - l.sellQty));
  }

  hctx.clearRect(0, 0, heatmap.width, heatmap.height);

  prices.forEach((p, i) => {
    const l = footprint.get(p);
    const delta = l.buyQty - l.sellQty;
    const intensity = Math.min(Math.abs(delta) / maxAbsDelta, 1);
    const y = i * rowH;

    if (delta > 0) {
      hctx.fillStyle = `rgba(63,185,80,${intensity})`;
      hctx.fillRect(0, y, heatmap.width, rowH);
    } else if (delta < 0) {
      hctx.fillStyle = `rgba(248,81,73,${intensity})`;
      hctx.fillRect(0, y, heatmap.width, rowH);
    }

    if (p === lastPriceBucket) {
      hctx.fillStyle = "rgba(255,255,255,0.10)";
      hctx.fillRect(0, y, heatmap.width, rowH);
    }
  });
}

// =========================
// CVD CHART
// =========================
function renderCVD() {
  if (!cctx || !cvdCanvas || cvdSeries.length < 2) return;

  const w = cvdCanvas.width;
  const h = cvdCanvas.height;
  cctx.clearRect(0, 0, w, h);

  const [mn, mx] = minMax(cvdSeries);

  // light grid
  cctx.strokeStyle = "rgba(255,255,255,0.06)";
  cctx.lineWidth = 1;
  cctx.beginPath();
  for (let i = 1; i < 4; i++) {
    const y = (h / 4) * i;
    cctx.moveTo(0, y);
    cctx.lineTo(w, y);
  }
  cctx.stroke();

  // line
  cctx.strokeStyle = "#58a6ff";
  cctx.lineWidth = 2;
  cctx.beginPath();
  cvdSeries.forEach((v, i) => {
    const x = (i / (cvdSeries.length - 1)) * w;
    const y = h - ((v - mn) / (mx - mn)) * h;
    if (i === 0) cctx.moveTo(x, y);
    else cctx.lineTo(x, y);
  });
  cctx.stroke();
}

// =========================
// STATS BAR
// =========================
function renderStats() {
  if (!statTotalBuys || !statTotalSells || !statNetDelta || !statCvd || !statLastUpdate) return;

  statTotalBuys.textContent = totalBuys.toFixed(2);
  statTotalSells.textContent = totalSells.toFixed(2);

  const delta = totalBuys - totalSells;
  statNetDelta.textContent = (delta >= 0 ? "+" : "") + delta.toFixed(2);
  statNetDelta.style.color = delta >= 0 ? "#3fb950" : "#f85149";

  statCvd.textContent = cvd.toFixed(2);
  statLastUpdate.textContent = lastUpdate ? new Date(lastUpdate).toLocaleTimeString() : "--";
}

// =========================
// WEBSOCKET
// =========================
function connect() {
  if (pairEl) pairEl.textContent = COIN;
  updateStatus("CONNECTING...", "warn");

  ws = new WebSocket(wsUrl());

  ws.onopen = () => updateStatus("CONNECTED", "ok");
  ws.onclose = () => updateStatus("DISCONNECTED", "");
  ws.onerror = () => updateStatus("ERROR", "");

  ws.onmessage = (event) => {
    const trades = JSON.parse(event.data);

    for (const t of trades) {
      const pRaw = Number(t.price);
      const q = Number(t.quantity);
      if (!Number.isFinite(pRaw) || !Number.isFinite(q)) continue;

      const pBucket = bucketPrice(pRaw);
      ensureLevel(pBucket);

      if (lastPriceRaw !== null && pRaw === lastPriceRaw) stableTicks++;
      else stableTicks = 0;

      lastPriceRaw = pRaw;
      lastPriceBucket = pBucket;

      if (priceEl) priceEl.textContent = pRaw.toFixed(2);
      lastUpdate = Date.now();

      const l = footprint.get(pBucket);

      if (t.side === "BUY") {
        l.buyQty += q;
        totalBuys += q;
      } else {
        l.sellQty += q;
        totalSells += q;
      }

      const d = l.buyQty - l.sellQty;
      l.deltaHistory.push(d);
      if (l.deltaHistory.length > 20) l.deltaHistory.shift();

      l.vol += q;

      cvd += Number(t.delta) || 0;

      // Tape
      if (tapeEl) {
        const row = document.createElement("div");
        row.innerHTML = `
          <span>${t.side}</span>
          <span class="meta">${q.toFixed(3)} @</span>
          <span class="price-only">${pRaw.toFixed(2)}</span>
        `;
        row.style.color = t.side === "BUY" ? "#3fb950" : "#f85149";
        tapeEl.prepend(row);
        if (tapeEl.children.length > 120) tapeEl.removeChild(tapeEl.lastChild);
      }
    }

    cvdSeries.push(cvd);
    if (cvdSeries.length > CVD_MAX_POINTS) cvdSeries.shift();

    scheduleRender();
  };
}

function updateStatus(text, className) {
  if (statusText) statusText.textContent = text;
  if (statusEl) statusEl.className = `status ${className}`.trim();
}

// Start
renderStats();
connect();

