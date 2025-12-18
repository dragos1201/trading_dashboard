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
const CHART_BUCKET_MS = 100; // 10 points per second
const CHART_WINDOW_MS = 5 * 60 * 1000; // 5 minutes visible


// Detection params (kept simple for now)
const DELTA_SPIKE_MULT = 3;
const ABSORPTION_VOL_THRESHOLD = 3;
const ABSORPTION_TICKS = 8;

// =========================
// DOM
// =========================
const pairEl = document.getElementById("pair");
const priceEl = document.getElementById("price");
const statusText = document.getElementById("statusText");

const statTotalBuys = document.getElementById("totalBuys");
const statTotalSells = document.getElementById("totalSells");
const statNetDelta = document.getElementById("netDelta");
const statCvd = document.getElementById("cvdValue");
const statLastUpdate = document.getElementById("lastUpdate");

const fpEl = document.getElementById("footprint");
const tapeEl = document.getElementById("tape");

const ladderViewport = document.getElementById("ladderViewport");

const heatmap = document.getElementById("heatmap");
const hctx = heatmap ? heatmap.getContext("2d") : null;

const cvdCanvas = document.getElementById("cvdChart");
const cctx = cvdCanvas ? cvdCanvas.getContext("2d") : null;

const priceCanvas = document.getElementById("priceChart");
const pctx = priceCanvas ? priceCanvas.getContext("2d") : null;

const cvdTooltip = document.getElementById("cvdTooltip");
const priceTooltip = document.getElementById("priceTooltip");

// =========================
// STATE
// =========================
let ws = null;

let lastPriceBucket = null;
let lastPriceRaw = null;
let stableTicks = 0;

// price -> { buyQty, sellQty, deltaHistory, vol }
const footprint = new Map();
let lastChartBucket = null;
let cvd = 0;
const cvdSeries = [];
const priceSeries = [];
const timeSeries = []; // one timestamp per appended point (shared for price & cvd)

let totalBuys = 0;
let totalSells = 0;
let lastUpdate = null;

let needsRender = false;

// authoritative ladder geometry
let viewportPx = 620;
let rowHeightPx = viewportPx / ROWS;

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
    footprint.set(price, { buyQty: 0, sellQty: 0, deltaHistory: [], vol: 0 });
  }
}

function smoothSeries(series, windowSize = 5) {
  if (series.length < windowSize) return series;

  const out = [];
  for (let i = 0; i < series.length; i++) {
    const start = Math.max(0, i - windowSize + 1);
    const slice = series.slice(start, i + 1);
    const avg = slice.reduce((a, b) => a + b, 0) / slice.length;
    out.push(avg);
  }
  return out;
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
  if (mn === mx) { mn -= 1; mx += 1; }
  return [mn, mx];
}

function setCanvasSize(canvas, ctx) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  const w = Math.max(1, Math.floor(cssW * dpr));
  const h = Math.max(1, Math.floor(cssH * dpr));

  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // draw in CSS pixels
  }
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

// =========================
// AUTHORITATIVE GRID (alignment fix)
// =========================
function updateGridGeometry() {
  // viewport height is controlled by CSS (620px), but we measure actual px:
  viewportPx = ladderViewport ? ladderViewport.clientHeight : 620;
  rowHeightPx = viewportPx / ROWS;

  // ladder rows use this height:
  if (fpEl) fpEl.style.setProperty("--fp-row-height", `${rowHeightPx}px`);

  // heatmap canvas must match viewport exactly:
  if (heatmap && hctx) {
    heatmap.style.height = `${viewportPx}px`;
    setCanvasSize(heatmap, hctx);
  }
}

// =========================
// RENDER SCHEDULER
// =========================
function scheduleRender() {
  if (needsRender) return;
  needsRender = true;

  requestAnimationFrame(() => {
    updateGridGeometry();
    renderFootprint();
    renderHeatmap();
    renderCVD();
    renderPriceChart();
    renderStats();
    needsRender = false;
  });
}

// =========================
// FOOTPRINT LADDER
// =========================
function ladderPrices() {
  const prices = [];
  for (let i = LEVELS; i >= -LEVELS; i--) {
    const p = lastPriceBucket + i * TICK_SIZE;
    prices.push(p);
    ensureLevel(p);
  }
  return prices;
}

function renderFootprint() {
  if (lastPriceBucket === null || !fpEl) return;

  fpEl.innerHTML = "";
  const prices = ladderPrices();

  // normalize ladder cell intensity by max BUY/SELL qty in window
  let maxCell = 1;
  for (const p of prices) {
    const l = footprint.get(p);
    maxCell = Math.max(maxCell, l.buyQty, l.sellQty);
  }

  for (const p of prices) {
    const l = footprint.get(p);

    const delta = l.buyQty - l.sellQty;
    const avgDelta = avg(l.deltaHistory);
    const spike =
      l.deltaHistory.length > 6 &&
      Math.abs(delta) > Math.max(1e-9, Math.abs(avgDelta)) * DELTA_SPIKE_MULT;

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

    const bi = l.buyQty / maxCell;
    const si = l.sellQty / maxCell;

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
// HEATMAP (now matches ladder semantics)
// - uses delta ratio (delta/total) so color intensity "corresponds" to ladder
// - gated by total volume so tiny totals don't look loud
// =========================
function renderHeatmap() {
  if (lastPriceBucket === null || !heatmap || !hctx) return;

  setCanvasSize(heatmap, hctx);

  const prices = ladderPrices();
  const w = heatmap.clientWidth;
  const h = heatmap.clientHeight;

  // total volume max in window (for gating)
  let maxTotal = 1;
  for (const p of prices) {
    const l = footprint.get(p);
    const total = l.buyQty + l.sellQty;
    maxTotal = Math.max(maxTotal, total);
  }

  hctx.clearRect(0, 0, w, h);

  prices.forEach((p, idx) => {
    const l = footprint.get(p);
    const buy = l.buyQty;
    const sell = l.sellQty;
    const total = buy + sell;

    const delta = buy - sell;
    const deltaRatio = total > 0 ? (delta / total) : 0;  // [-1..1]
    const dominance = Math.abs(deltaRatio);              // [0..1]

    // gate by total so tiny prints stay subtle
    const volGate = total > 0 ? Math.sqrt(total / maxTotal) : 0; // [0..1]
    const alpha = clamp(dominance * volGate, 0, 1);

    const y = idx * rowHeightPx;

    if (deltaRatio > 0) {
      hctx.fillStyle = `rgba(63,185,80,${alpha})`;
      hctx.fillRect(0, y, w, rowHeightPx);
    } else if (deltaRatio < 0) {
      hctx.fillStyle = `rgba(248,81,73,${alpha})`;
      hctx.fillRect(0, y, w, rowHeightPx);
    } else {
      // neutral background grid line feel
      hctx.fillStyle = "rgba(255,255,255,0.015)";
      hctx.fillRect(0, y, w, rowHeightPx);
    }

    if (p === lastPriceBucket) {
      hctx.fillStyle = "rgba(255,255,255,0.10)";
      hctx.fillRect(0, y, w, rowHeightPx);
    }
  });
}

// =========================
// CHART DRAWING (labels + tooltip support)
// =========================
function drawLineChart(ctx, canvas, series, opts) {
  setCanvasSize(canvas, ctx);

  const w = canvas.clientWidth;
  const h = canvas.clientHeight;

  ctx.clearRect(0, 0, w, h);

  // grid
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 1; i < 4; i++) {
    const y = (h / 4) * i;
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
  }
  ctx.stroke();

  if (!series || series.length < 2) return;

  const [mn, mx] = minMax(series);

  // labels (min/max)
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.font = "10px monospace";
  ctx.fillText(`${opts.labelMax}${mx.toFixed(opts.decimals)}`, 8, 12);
  ctx.fillText(`${opts.labelMin}${mn.toFixed(opts.decimals)}`, 8, h - 6);

  // line
  ctx.strokeStyle = opts.stroke;
  ctx.lineWidth = 2;
  ctx.beginPath();

  for (let i = 0; i < series.length; i++) {
    const v = series[i];
    const x = (i / (series.length - 1)) * (w - 1);
    const y = h - ((v - mn) / (mx - mn)) * h;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function renderCVD() {
  if (!cctx || !cvdCanvas) return;
  drawLineChart(cctx, cvdCanvas, cvdSeries, {
    stroke: "#58a6ff",
    decimals: 2,
    labelMax: "max ",
    labelMin: "min "
  });
}

function renderPriceChart() {
  if (!pctx || !priceCanvas) return;
  const smoothPrice = smoothSeries(priceSeries, 6);
  drawLineChart(pctx, priceCanvas, smoothPrice, {
    stroke: "#9b8cff",
    decimals: 2,
    labelMax: "max ",
    labelMin: "min "
  });
}

function attachTooltip(canvas, tooltipEl, series, formatter) {
  if (!canvas || !tooltipEl) return;

  canvas.addEventListener("mousemove", (e) => {
    if (!series || series.length < 2) return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const w = rect.width;

    const idx = clamp(Math.round((x / Math.max(1, w - 1)) * (series.length - 1)), 0, series.length - 1);

    const v = series[idx];
    const ts = timeSeries[idx];
    tooltipEl.innerHTML = formatter(v, ts);

    tooltipEl.style.left = `${x}px`;
    tooltipEl.style.top = `${e.clientY - rect.top}px`;
    tooltipEl.style.display = "block";
  });

  canvas.addEventListener("mouseleave", () => {
    tooltipEl.style.display = "none";
  });
}

// =========================
// STATS
// =========================
function renderStats() {
  if (!statTotalBuys || !statTotalSells || !statNetDelta || !statCvd || !statLastUpdate) return;

  statTotalBuys.textContent = totalBuys.toFixed(2);
  statTotalSells.textContent = totalSells.toFixed(2);

  const delta = totalBuys - totalSells;
  statNetDelta.textContent = (delta >= 0 ? "+" : "") + delta.toFixed(2);
  statNetDelta.style.color = delta >= 0 ? "#3fb950" : "#f85149";

  statCvd.textContent = cvd.toFixed(2);
  statLastUpdate.textContent = lastUpdate ? new Date(lastUpdate).toLocaleTimeString() : "—";
}

// =========================
// WEBSOCKET
// =========================
function connect() {
  if (pairEl) pairEl.textContent = COIN;
  updateStatus("CONNECTING…", "warn");

  ws = new WebSocket(wsUrl());

  ws.onopen = () => updateStatus("CONNECTED", "ok");
  ws.onclose = () => updateStatus("DISCONNECTED", "bad");
  ws.onerror = () => updateStatus("ERROR", "bad");

  ws.onmessage = (event) => {
    const trades = JSON.parse(event.data);

    // batch time (prefer event_time if present)
    const now = Date.now();

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
      lastUpdate = now;

      // accumulate ladder
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

      // tape (narrow rows)
      if (tapeEl) {
        const row = document.createElement("div");
        row.className = "tapeRow";

        const side = document.createElement("span");
        side.className = "side";
        side.textContent = t.side;

        const qty = document.createElement("span");
        qty.className = "qty";
        qty.textContent = q.toFixed(3);

        const px = document.createElement("span");
        px.className = "px";
        px.textContent = pRaw.toFixed(2);

        row.appendChild(side);
        row.appendChild(qty);
        row.appendChild(px);

        row.style.color = t.side === "BUY" ? "#3fb950" : "#f85149";
        tapeEl.prepend(row);
        if (tapeEl.children.length > 220) tapeEl.removeChild(tapeEl.lastChild);
      }

      // =========================
      // TIME-BUCKETED CHART UPDATE
      // =========================
      const bucket = Math.floor(now / CHART_BUCKET_MS) * CHART_BUCKET_MS;

      if (lastChartBucket === null || bucket > lastChartBucket) {
        lastChartBucket = bucket;

        // carry-forward latest known values
        priceSeries.push(lastPriceRaw);
        cvdSeries.push(cvd);
        timeSeries.push(bucket);

        // trim by TIME, not by number of points
        while (
          timeSeries.length &&
          (bucket - timeSeries[0]) > CHART_WINDOW_MS
        ) {
          timeSeries.shift();
          priceSeries.shift();
          cvdSeries.shift();
        }
      }

    }

    scheduleRender();
  };
}

function updateStatus(text, level) {
  if (!statusText) return;

  statusText.textContent = text;

  // also set dot color by toggling classes on the dot (optional)
  const dot = document.querySelector(".dot");
  if (!dot) return;

  dot.classList.remove("ok", "warn", "bad");
  if (level === "ok") dot.classList.add("ok");
  else if (level === "warn") dot.classList.add("warn");
  else dot.classList.add("bad");
}

// =========================
// INIT
// =========================
updateGridGeometry();

attachTooltip(cvdCanvas, cvdTooltip, cvdSeries, (v, ts) => {
  const t = ts ? new Date(ts).toLocaleTimeString() : "—";
  return `<b>CVD</b>: ${v.toFixed(2)}<br><span style="opacity:.7">${t}</span>`;
});

attachTooltip(priceCanvas, priceTooltip, priceSeries, (v, ts) => {
  const t = ts ? new Date(ts).toLocaleTimeString() : "—";
  return `<b>Price</b>: ${v.toFixed(2)}<br><span style="opacity:.7">${t}</span>`;
});

renderStats();
connect();

// keep charts crisp on resize
window.addEventListener("resize", () => scheduleRender());

