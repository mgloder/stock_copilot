// ── State ─────────────────────────────────────────────────────────────────────
let chart, candleSeries;
let exploreChart, exploreCandleSeries, exploreSma20, exploreSma50;
let activeSymbol = "";
let exploreSymbol = "";
let quoteWs = null;
let currentMode = "positions"; // "positions" | "explore"

// ── Chart (position mode) ────────────────────────────────────────────────────
function initChart() {
  const container = document.getElementById("chart");
  chart = LightweightCharts.createChart(container, {
    layout: { background: { color: "#0d1117" }, textColor: "#e6edf3" },
    grid: { vertLines: { color: "#21262d" }, horzLines: { color: "#21262d" } },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    rightPriceScale: { borderColor: "#30363d" },
    timeScale: { borderColor: "#30363d", timeVisible: true },
  });
  candleSeries = chart.addCandlestickSeries({
    upColor: "#3fb950", downColor: "#f85149",
    borderUpColor: "#3fb950", borderDownColor: "#f85149",
    wickUpColor: "#3fb950", wickDownColor: "#f85149",
  });
  new ResizeObserver(() =>
    chart.applyOptions({ width: container.offsetWidth, height: container.offsetHeight })
  ).observe(container);
}

async function loadChart(symbol) {
  const duration = document.getElementById("duration-select").value;
  const barSize  = document.getElementById("bar-select").value;
  const res = await fetch(`/api/chart/${symbol}?duration=${encodeURIComponent(duration)}&bar_size=${encodeURIComponent(barSize)}`);
  if (!res.ok) return;
  const bars = await res.json();
  if (!bars.length) return;
  candleSeries.setData(bars.map(b => ({ time: b.time.slice(0, 10), open: b.open, high: b.high, low: b.low, close: b.close })));
  chart.timeScale().fitContent();
}

// ── Portfolio ────────────────────────────────────────────────────────────────
async function loadPortfolio() {
  const res = await fetch("/api/portfolio");
  if (!res.ok) return;
  const data = await res.json();

  const badge = document.getElementById("ib-status");
  badge.textContent = data.connected ? "IB Connected" : "IB Disconnected";
  badge.className = "badge " + (data.connected ? "badge-connected" : "badge-disconnected");

  const s = data.summary || {};
  const fmt = v => v != null ? "$" + Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—";
  const fmtPnl = v => {
    if (v == null) return "—";
    const sign = v >= 0 ? "+" : "";
    return `<span class="${v >= 0 ? "pos" : "neg"}">${sign}${fmt(v)}</span>`;
  };
  document.getElementById("net-liq").textContent  = fmt(s.NetLiquidation);
  document.getElementById("cash").textContent      = fmt(s.TotalCashValue);
  document.getElementById("upnl").innerHTML        = fmtPnl(s.UnrealizedPnL);
  document.getElementById("rpnl").innerHTML        = fmtPnl(s.RealizedPnL);

  const tbody = document.getElementById("positions-body");
  if (!data.positions?.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="empty">No positions</td></tr>`;
    return;
  }
  tbody.innerHTML = data.positions.map(p => `
    <tr class="pos-row" data-symbol="${p.symbol}" style="cursor:pointer">
      <td><strong>${p.symbol}</strong></td>
      <td>${p.secType}</td>
      <td>${p.position}</td>
      <td>$${Number(p.avgCost).toFixed(2)}</td>
    </tr>`).join("");
  document.querySelectorAll(".pos-row").forEach(row =>
    row.addEventListener("click", () => loadSymbol(row.dataset.symbol))
  );
}

// ── News (position mode) ─────────────────────────────────────────────────────
async function loadNews(symbol, analyze = false) {
  document.getElementById("news-title").textContent = `News · ${symbol}`;
  document.getElementById("news-list").innerHTML = `<p class="empty">Loading…</p>`;
  const res = await fetch(`/api/news/${symbol}?analyze=${analyze}`);
  if (!res.ok) { document.getElementById("news-list").innerHTML = `<p class="empty">Failed.</p>`; return; }
  const data = await res.json();
  if (!data.articles.length) { document.getElementById("news-list").innerHTML = `<p class="empty">No news found.</p>`; return; }
  document.getElementById("news-list").innerHTML = data.articles.map(a => {
    const badge = a.impact ? `<span class="impact-badge impact-${a.impact}">${a.impact}</span>` : "";
    const date  = a.publishedAt ? new Date(a.publishedAt).toLocaleDateString() : "";
    return `<div class="news-item">
      <div class="news-meta">${badge}<span class="news-publisher">${a.publisher||""}</span><span class="news-date">${date}</span></div>
      <div class="news-title"><a href="${a.url}" target="_blank" rel="noopener">${a.title}</a></div>
      ${a.summary ? `<div class="news-summary">${a.summary}</div>` : ""}
      ${a.reason  ? `<div class="news-reason">${a.reason}</div>`  : ""}
    </div>`;
  }).join("");
}

// ── WebSocket ────────────────────────────────────────────────────────────────
function connectQuoteWs(symbol) {
  if (quoteWs) quoteWs.close();
  const proto = location.protocol === "https:" ? "wss" : "ws";
  quoteWs = new WebSocket(`${proto}://${location.host}/api/ws/quotes/${symbol}`);
  quoteWs.onmessage = (e) => {
    const d = JSON.parse(e.data);
    if (d.ping) return;
    const el = document.getElementById("live-quote");
    el.textContent = d.last ? `${symbol}  $${Number(d.last).toFixed(2)}` : "";
  };
  quoteWs.onerror = () => {};
}

// ── Symbol (position mode) ───────────────────────────────────────────────────
async function loadSymbol(symbol) {
  symbol = symbol.toUpperCase().trim();
  if (!symbol) return;
  activeSymbol = symbol;
  document.getElementById("symbol-input").value = symbol;
  document.getElementById("live-quote").textContent = "";
  await Promise.all([loadChart(symbol), loadNews(symbol)]);
  connectQuoteWs(symbol);
}

// ── Mode switching ────────────────────────────────────────────────────────────
function switchMode(mode) {
  currentMode = mode;
  const isExplore = mode === "explore";

  document.getElementById("nav-positions").classList.toggle("active", !isExplore);
  document.getElementById("nav-explore").classList.toggle("active",  isExplore);

  document.getElementById("panel-positions").style.display = isExplore ? "none" : "";
  document.getElementById("panel-chart").style.display     = isExplore ? "none" : "";
  document.getElementById("panel-news").style.display      = isExplore ? "none" : "";

  const exploreEl = document.getElementById("explore-mode");
  exploreEl.style.display = isExplore ? "flex" : "none";

  if (isExplore && activeSymbol && activeSymbol !== exploreSymbol) {
    document.getElementById("explore-input").value = activeSymbol;
    loadExplore(activeSymbol);
  }
}

// ── Explore: chart ────────────────────────────────────────────────────────────
function initExploreChart() {
  if (exploreChart) return;
  const wrap = document.getElementById("explore-chart-wrap");
  exploreChart = LightweightCharts.createChart(wrap, {
    layout: { background: { color: "#0d1117" }, textColor: "#e6edf3" },
    grid: { vertLines: { color: "#21262d" }, horzLines: { color: "#21262d" } },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    rightPriceScale: { borderColor: "#30363d" },
    timeScale: { borderColor: "#30363d", timeVisible: false },
  });
  exploreCandleSeries = exploreChart.addCandlestickSeries({
    upColor: "#3fb950", downColor: "#f85149",
    borderUpColor: "#3fb950", borderDownColor: "#f85149",
    wickUpColor: "#3fb950", wickDownColor: "#f85149",
  });
  exploreSma20 = exploreChart.addLineSeries({ color: "#f0883e", lineWidth: 1.5, title: "SMA20", lastValueVisible: false, priceLineVisible: false });
  exploreSma50 = exploreChart.addLineSeries({ color: "#58a6ff", lineWidth: 1.5, title: "SMA50", lastValueVisible: false, priceLineVisible: false });
  new ResizeObserver(() =>
    exploreChart.applyOptions({ width: wrap.offsetWidth, height: wrap.offsetHeight })
  ).observe(wrap);
}

// ── Explore: load all sections ────────────────────────────────────────────────
async function loadExplore(symbol) {
  symbol = symbol.toUpperCase().trim();
  if (!symbol) return;
  exploreSymbol = symbol;
  document.getElementById("explore-sym-label").textContent = symbol;
  document.getElementById("explore-input").value = symbol;

  document.getElementById("body-rec").innerHTML  = `<p class="empty">Loading…</p>`;
  document.getElementById("body-news").innerHTML = `<p class="empty">Loading…</p>`;
  document.getElementById("body-tech-indicators").innerHTML = "";
  document.getElementById("body-ai").innerHTML   = `<p class="empty">Click Analyze to generate a DeepSeek analysis.</p>`;

  const res = await fetch(`/api/explore/${symbol}`);
  if (!res.ok) {
    document.getElementById("body-rec").innerHTML = `<p class="empty">Symbol not found or data unavailable.</p>`;
    return;
  }
  const data = await res.json();

  renderRecommendation(data);
  renderExploreNews(data.news);
  renderTechnical(data);
}

// ── Explore: Section 1 — Recommendation ──────────────────────────────────────
function renderRecommendation(data) {
  const p = data.price || {};
  const t = data.technicals || {};

  const fmt    = v => v != null ? "$" + Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—";
  const fmtCap = v => { if (!v) return "—"; if (v >= 1e12) return "$"+(v/1e12).toFixed(2)+"T"; if (v >= 1e9) return "$"+(v/1e9).toFixed(2)+"B"; return "$"+(v/1e6).toFixed(0)+"M"; };
  const fmtVol = v => { if (!v) return "—"; if (v >= 1e6) return (v/1e6).toFixed(1)+"M"; return v.toLocaleString(); };

  const sig      = t.signal || "hold";
  const sigClass = { buy: "sig-buy", sell: "sig-sell", hold: "sig-hold" }[sig] || "sig-hold";
  const chgSign  = (p.change ?? 0) >= 0 ? "+" : "";
  const chgClass = (p.change ?? 0) >= 0 ? "pos" : "neg";
  const rsiTxt   = t.rsi != null ? `${t.rsi} ${t.rsi < 30 ? "(oversold)" : t.rsi > 70 ? "(overbought)" : "(neutral)"}` : "—";
  const trendTxt = t.trend ? t.trend.charAt(0).toUpperCase() + t.trend.slice(1) : "—";

  document.getElementById("body-rec").innerHTML = `
    <div class="rec-signal ${sigClass}">${sig.toUpperCase()}</div>
    <div class="rec-price">
      ${fmt(p.current)}
      <span class="chg ${chgClass}">&nbsp;${chgSign}${p.change != null ? p.change.toFixed(2) : "—"} (${chgSign}${p.change_pct != null ? p.change_pct.toFixed(2) : "—"}%)</span>
    </div>
    <div class="metric-group">
      <div class="metric-row"><span>52W High</span><span>${fmt(p.year_high)}</span></div>
      <div class="metric-row"><span>52W Low</span><span>${fmt(p.year_low)}</span></div>
      <div class="metric-row"><span>Mkt Cap</span><span>${fmtCap(p.market_cap)}</span></div>
      <div class="metric-row"><span>Volume</span><span>${fmtVol(p.volume)}</span></div>
    </div>
    <div class="metric-sep"></div>
    <div class="metric-group">
      <div class="metric-row"><span>SMA 20</span><span>${fmt(t.sma20)}</span></div>
      <div class="metric-row"><span>SMA 50</span><span>${fmt(t.sma50)}</span></div>
      <div class="metric-row"><span>RSI (14)</span><span>${rsiTxt}</span></div>
      <div class="metric-row"><span>Trend</span><span>${trendTxt}</span></div>
    </div>`;
}

// ── Explore: Section 2 — News Sources ────────────────────────────────────────
function renderExploreNews(news) {
  if (!news?.length) { document.getElementById("body-news").innerHTML = `<p class="empty">No news found.</p>`; return; }
  document.getElementById("body-news").innerHTML = news.map(a => {
    const date = a.publishedAt ? new Date(a.publishedAt).toLocaleDateString() : "";
    return `<div class="src-news-item">
      <div class="src-news-meta">
        <span class="src-publisher">${a.publisher || "Unknown"}</span>
        <span class="src-date">${date}</span>
      </div>
      <div class="src-title"><a href="${a.url}" target="_blank" rel="noopener">${a.title}</a></div>
    </div>`;
  }).join("");
}

// ── Explore: Section 3 — Technical Analysis ───────────────────────────────────
function renderTechnical(data) {
  initExploreChart();

  if (data.bars?.length) {
    exploreCandleSeries.setData(data.bars.map(b => ({ time: b.time.slice(0, 10), open: b.open, high: b.high, low: b.low, close: b.close })));
    exploreSma20.setData(data.sma20_series?.length ? data.sma20_series : []);
    exploreSma50.setData(data.sma50_series?.length ? data.sma50_series : []);
    exploreChart.timeScale().fitContent();
  }

  const t = data.technicals || {};
  const rsiPct   = t.rsi != null ? Math.min(Math.max(t.rsi, 0), 100) : 50;
  const rsiColor = t.rsi > 70 ? "#f85149" : t.rsi < 30 ? "#3fb950" : "#58a6ff";

  document.getElementById("body-tech-indicators").innerHTML = `
    <div class="ind-item">
      <span class="ind-label">RSI 14</span>
      <div class="rsi-track"><div class="rsi-fill" style="width:${rsiPct}%;background:${rsiColor}"></div></div>
      <span class="ind-value">${t.rsi ?? "—"}</span>
    </div>
    <div class="ind-item">
      <span class="ind-label" style="color:#f0883e">SMA 20</span>
      <span class="ind-value">${t.sma20 != null ? "$"+t.sma20 : "—"}</span>
    </div>
    <div class="ind-item">
      <span class="ind-label" style="color:#58a6ff">SMA 50</span>
      <span class="ind-value">${t.sma50 != null ? "$"+t.sma50 : "—"}</span>
    </div>`;
}

// ── Explore: Section 4 — AI Analysis ─────────────────────────────────────────
async function runExploreAnalysis() {
  if (!exploreSymbol) return;
  document.getElementById("body-ai").innerHTML = `<p class="empty">Analyzing with DeepSeek…</p>`;
  const res = await fetch(`/api/explore/${exploreSymbol}/analysis`);
  if (!res.ok) { document.getElementById("body-ai").innerHTML = `<p class="empty">Analysis failed.</p>`; return; }
  const data = await res.json();
  document.getElementById("body-ai").innerHTML = `<div class="ai-body">${fmtAnalysis(data.analysis)}</div>`;
}

function fmtAnalysis(text) {
  return "<p>" + text
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/\n\n+/g, "</p><p>")
    .replace(/\n/g, "<br>") + "</p>";
}

// ── Event wiring ──────────────────────────────────────────────────────────────
document.getElementById("nav-positions").addEventListener("click", () => switchMode("positions"));
document.getElementById("nav-explore").addEventListener("click",   () => switchMode("explore"));

document.getElementById("load-btn").addEventListener("click", () => loadSymbol(document.getElementById("symbol-input").value));
document.getElementById("symbol-input").addEventListener("keydown", e => { if (e.key === "Enter") loadSymbol(e.target.value); });
document.getElementById("duration-select").addEventListener("change", () => { if (activeSymbol) loadChart(activeSymbol); });
document.getElementById("bar-select").addEventListener("change",      () => { if (activeSymbol) loadChart(activeSymbol); });
document.getElementById("analyze-btn").addEventListener("click",      () => { if (activeSymbol) loadNews(activeSymbol, true); });

document.getElementById("explore-search-btn").addEventListener("click", () => loadExplore(document.getElementById("explore-input").value));
document.getElementById("explore-input").addEventListener("keydown", e => { if (e.key === "Enter") loadExplore(e.target.value); });
document.getElementById("explore-ai-btn").addEventListener("click", runExploreAnalysis);

// ── Init ──────────────────────────────────────────────────────────────────────
initChart();
loadPortfolio();
setInterval(loadPortfolio, 15000);
