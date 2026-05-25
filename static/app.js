// ── State ─────────────────────────────────────────────────────────────────────
let chart, candleSeries;
let exploreChart, exploreCandleSeries, exploreSma20, exploreSma50;
let activeSymbol = "";
let exploreSymbol = "";
let quoteWs = null;
let currentMode = "positions"; // "positions" | "explore"
let currentLang = "en";        // "en" | "zh"
let lastExploreData = null;
let exploreAiLoaded = false;

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
  lastExploreData = data;
  exploreAiLoaded = false;

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

  loadTechAI(data.symbol, data.price, t);
}

async function loadTechAI(symbol, price, t) {
  const el = document.getElementById("body-tech-ai");
  el.innerHTML = `<p class="empty">${currentLang === "zh" ? "分析中…" : "Analyzing…"}</p>`;
  const params = new URLSearchParams();
  if (price?.current != null) params.set("price", price.current);
  if (t.sma20  != null) params.set("sma20",  t.sma20);
  if (t.sma50  != null) params.set("sma50",  t.sma50);
  if (t.rsi    != null) params.set("rsi",    t.rsi);
  if (t.trend)          params.set("trend",  t.trend);
  if (t.signal)         params.set("signal", t.signal);
  params.set("lang", currentLang);
  try {
    const res = await fetch(`/api/explore/${symbol}/technical?${params}`);
    if (!res.ok) throw new Error();
    const d = await res.json();
    el.innerHTML = d.text ? `<p>${d.text}</p>` : `<p class="empty">—</p>`;
  } catch {
    el.innerHTML = `<p class="empty">—</p>`;
  }
}

// ── Explore: Section 4 — AI Analysis ─────────────────────────────────────────
async function runExploreAnalysis() {
  if (!exploreSymbol) return;
  exploreAiLoaded = true;

  const bodyAi = document.getElementById("body-ai");
  const thinkingLabel = currentLang === "zh" ? "正在分析…" : "Analyzing…";
  const stepsLabel    = currentLang === "zh" ? "分析步骤" : "Analysis steps";
  const weighingLabel = currentLang === "zh" ? "因子权重评估" : "Factor Weighting";

  bodyAi.innerHTML = `
    <details class="thinking-section" id="ai-thinking-section" open>
      <summary>
        <span class="thinking-arrow">&#9658;</span>
        <span id="ai-thinking-label">${thinkingLabel}</span>
      </summary>
      <div id="ai-thinking-steps"></div>
    </details>
    <div id="ai-result"></div>`;

  const params = new URLSearchParams({ lang: currentLang });
  factors.forEach(f => params.append("factors", f.text));
  if (currentProfileText) params.set("profile_text", currentProfileText);
  if (lastExploreData) {
    const p = lastExploreData.price || {};
    const t = lastExploreData.technicals || {};
    if (p.current    != null) params.set("price",      p.current);
    if (p.year_high  != null) params.set("year_high",  p.year_high);
    if (p.year_low   != null) params.set("year_low",   p.year_low);
    if (p.market_cap != null) params.set("market_cap", p.market_cap);
    if (t.sma20  != null) params.set("sma20",   t.sma20);
    if (t.sma50  != null) params.set("sma50",   t.sma50);
    if (t.rsi    != null) params.set("rsi",     t.rsi);
    if (t.trend)           params.set("trend",  t.trend);
    if (t.signal)          params.set("signal", t.signal);
  }

  try {
    const res = await fetch(`/api/explore/${exploreSymbol}/analysis?${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      const parts = buf.split("\n\n");
      buf = parts.pop();

      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith("data:")) continue;
        let evt;
        try { evt = JSON.parse(line.slice(5).trim()); } catch { continue; }

        if (evt.type === "thinking") {
          const stepsEl = document.getElementById("ai-thinking-steps");
          if (stepsEl) {
            const step = document.createElement("div");
            step.className = "thinking-step";
            step.textContent = evt.text;
            stepsEl.appendChild(step);
            bodyAi.scrollTop = bodyAi.scrollHeight;
          }
        } else if (evt.type === "result") {
          const details = document.getElementById("ai-thinking-section");
          if (details) { details.open = false; }
          const label = document.getElementById("ai-thinking-label");
          if (label) label.textContent = stepsLabel;

          const weighingHtml = evt.weighing
            ? `<details class="weighing-section">
                 <summary><span class="weighing-arrow">&#9658;</span>${weighingLabel}</summary>
                 <div class="weighing-body">${fmtAnalysis(evt.weighing)}</div>
               </details>`
            : "";
          const resultEl = document.getElementById("ai-result");
          if (resultEl) {
            resultEl.innerHTML = weighingHtml + `<div class="ai-body">${fmtAnalysis(evt.analysis)}</div>`;
          }
        }
      }
    }
  } catch (err) {
    bodyAi.innerHTML = `<p class="empty">Analysis failed: ${err.message}</p>`;
  }
}

function fmtAnalysis(text) {
  return "<p>" + text
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/\n\n+/g, "</p><p>")
    .replace(/\n/g, "<br>") + "</p>";
}

// ── Explore: Internet query ───────────────────────────────────────────────────
async function runQuery() {
  const q = document.getElementById("ai-query-input").value.trim();
  if (!q || !exploreSymbol) return;

  const answerEl  = document.getElementById("ai-query-answer");
  const sourcesEl = document.getElementById("ai-query-sources");

  // Build the streaming UI shell
  const thinkingLabel = currentLang === "zh" ? "研究步骤" : "Research steps";
  answerEl.innerHTML = `
    <details class="thinking-section" id="thinking-section" open>
      <summary>
        <span class="thinking-arrow">&#9658;</span>
        <span id="thinking-label">${currentLang === "zh" ? "正在思考…" : "Thinking…"}</span>
      </summary>
      <div id="thinking-steps"></div>
    </details>
    <div id="query-result"></div>`;
  sourcesEl.innerHTML = "";

  try {
    const res = await fetch(
      `/api/explore/${exploreSymbol}/query?${new URLSearchParams({ q, lang: currentLang })}`
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      // SSE events are separated by double newlines
      const parts = buf.split("\n\n");
      buf = parts.pop(); // keep incomplete trailing chunk

      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith("data:")) continue;
        let evt;
        try { evt = JSON.parse(line.slice(5).trim()); } catch { continue; }

        if (evt.type === "thinking") {
          const stepsEl = document.getElementById("thinking-steps");
          if (stepsEl) {
            const step = document.createElement("div");
            step.className = "thinking-step";
            step.textContent = evt.text;
            stepsEl.appendChild(step);
            answerEl.scrollTop = answerEl.scrollHeight;
          }
        } else if (evt.type === "result") {
          // Collapse the thinking section and relabel it
          const details = document.getElementById("thinking-section");
          if (details) details.open = false;
          const label = document.getElementById("thinking-label");
          if (label) label.textContent = currentLang === "zh" ? "研究步骤" : "Research steps";

          // Render the answer
          const resultEl = document.getElementById("query-result");
          if (resultEl) {
            resultEl.innerHTML = evt.answer
              ? "<p>" + evt.answer
                  .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
                  .replace(/\n\n+/g, "</p><p>")
                  .replace(/\n/g, "<br>") + "</p>"
              : `<p class="empty">—</p>`;
          }

          // Render sources
          sourcesEl.innerHTML = (evt.sources || []).map((s, i) => `
            <div class="ai-src-item">
              <div class="ai-src-num">[${i + 1}] ${s.source || ""}</div>
              <div class="ai-src-title"><a href="${s.url}" target="_blank" rel="noopener">${s.title}</a></div>
              ${s.date ? `<div class="ai-src-meta">${s.date}</div>` : ""}
            </div>`).join("");
        }
      }
    }
  } catch (err) {
    answerEl.innerHTML = `<p class="empty">${currentLang === "zh" ? "搜索失败。" : "Search failed."}</p>`;
  }
}

// ── Investor profile ──────────────────────────────────────────────────────────
let currentProfileText = "";

function syncProfileBtn() {
  document.getElementById("profile-btn").classList.toggle("profile-set", !!currentProfileText);
}

async function fetchProfile() {
  try {
    const res  = await fetch("/api/user/profile");
    const data = await res.json();
    currentProfileText = data.text || "";
    syncProfileBtn();
  } catch {}
}

async function saveProfileText(text) {
  currentProfileText = text;
  syncProfileBtn();
  await fetch("/api/user/profile", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

// ── Profile modal wiring ──────────────────────────────────────────────────────
const profileOverlay  = document.getElementById("profile-overlay");
const profileTextarea = document.getElementById("profile-text");
const profileCharcount = document.getElementById("profile-charcount");

function updateCharCount() {
  profileCharcount.textContent = profileTextarea.value.length;
}

function syncChipUsed() {
  const val = profileTextarea.value;
  document.querySelectorAll(".profile-chip").forEach(chip => {
    chip.classList.toggle("used", val.includes(chip.dataset.snippet));
  });
}

profileTextarea.addEventListener("input", () => {
  updateCharCount();
  syncChipUsed();
});

document.querySelectorAll(".profile-chip").forEach(chip => {
  chip.addEventListener("click", () => {
    const snippet = chip.dataset.snippet;
    const ta = profileTextarea;
    const start = ta.selectionStart;
    const before = ta.value.slice(0, start);
    const after  = ta.value.slice(ta.selectionEnd);
    const needsComma = before.length > 0 && !before.trimEnd().endsWith(",") && !before.trimEnd().endsWith(".");
    const insert = (needsComma ? ", " : "") + snippet;
    ta.value = before + insert + after;
    ta.selectionStart = ta.selectionEnd = start + insert.length;
    ta.focus();
    updateCharCount();
    syncChipUsed();
  });
});

document.getElementById("profile-btn").addEventListener("click", () => {
  profileTextarea.value = currentProfileText;
  updateCharCount();
  syncChipUsed();
  profileOverlay.style.display = "flex";
  setTimeout(() => profileTextarea.focus(), 50);
});
document.getElementById("profile-close").addEventListener("click", () => {
  profileOverlay.style.display = "none";
});
profileOverlay.addEventListener("click", e => {
  if (e.target === profileOverlay) profileOverlay.style.display = "none";
});
document.getElementById("profile-clear-btn").addEventListener("click", () => {
  profileTextarea.value = "";
  updateCharCount();
  syncChipUsed();
  profileTextarea.focus();
});
document.getElementById("profile-save-btn").addEventListener("click", async () => {
  await saveProfileText(profileTextarea.value.trim());
  profileOverlay.style.display = "none";
});
profileTextarea.addEventListener("keydown", e => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    document.getElementById("profile-save-btn").click();
  }
  if (e.key === "Escape") profileOverlay.style.display = "none";
});

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
const factorInOverlay  = document.getElementById("factor-in-overlay");
const factorInInput    = document.getElementById("factor-in-input");
const factorsSidebar   = document.getElementById("factors-sidebar");
const factorsList      = document.getElementById("factors-list");

// factors: [{id, text}, ...]
let factors = [];
let selectedFactorId = null;

function renderFactors() {
  factorsList.innerHTML = factors.map(f => `
    <li class="factor-item${f.id === selectedFactorId ? " factor-selected" : ""}" data-id="${f.id}">
      <span class="factor-item-text">${f.text}</span>
      <button class="factor-item-del" data-id="${f.id}" title="Remove">&#x2715;</button>
    </li>`).join("");
  factorsSidebar.classList.toggle("open", factors.length > 0);
}

async function fetchFactors() {
  try {
    const res = await fetch("/api/user/factors");
    factors = await res.json();
    renderFactors();
  } catch {}
}

function openFactorIn() {
  factorInInput.value = "";
  factorInOverlay.style.display = "flex";
  factorInInput.focus();
}
function closeFactorIn() {
  factorInOverlay.style.display = "none";
}

async function submitFactor() {
  const text = factorInInput.value.trim();
  if (!text) return;
  closeFactorIn();
  const res = await fetch("/api/user/factors", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const newFactor = await res.json();
  factors.push(newFactor);
  renderFactors();
}

function selectFactor(id) {
  selectedFactorId = selectedFactorId === id ? null : id;
  renderFactors();
  if (selectedFactorId === null) return;
  const f = factors.find(f => f.id === id);
  if (!f) return;
  document.getElementById("ai-query-input").value = f.text;
  runQuery();
}

factorsList.addEventListener("click", async e => {
  const delBtn = e.target.closest(".factor-item-del");
  if (delBtn) {
    const id = Number(delBtn.dataset.id);
    await fetch(`/api/user/factors/${id}`, { method: "DELETE" });
    factors = factors.filter(f => f.id !== id);
    if (selectedFactorId === id) selectedFactorId = null;
    renderFactors();
    return;
  }
  const item = e.target.closest(".factor-item");
  if (item) selectFactor(Number(item.dataset.id));
});

document.getElementById("factors-clear-btn").addEventListener("click", async () => {
  await fetch("/api/user/factors", { method: "DELETE" });
  factors = [];
  selectedFactorId = null;
  renderFactors();
});

document.getElementById("explore-factor-in-btn").addEventListener("click", openFactorIn);
document.getElementById("factor-in-close").addEventListener("click", closeFactorIn);
document.getElementById("factor-in-add-btn").addEventListener("click", submitFactor);
factorInOverlay.addEventListener("click", e => { if (e.target === factorInOverlay) closeFactorIn(); });
factorInInput.addEventListener("keydown", e => {
  if (e.key === "Enter") submitFactor();
  if (e.key === "Escape") closeFactorIn();
});
document.getElementById("ai-query-btn").addEventListener("click", runQuery);
document.getElementById("ai-query-input").addEventListener("keydown", e => { if (e.key === "Enter") runQuery(); });

document.getElementById("lang-select").addEventListener("change", (e) => {
  currentLang = e.target.value;
  if (lastExploreData) {
    loadTechAI(lastExploreData.symbol, lastExploreData.price, lastExploreData.technicals || {});
  }
  if (exploreAiLoaded) runExploreAnalysis();
});

// ── Card expand / fullscreen ──────────────────────────────────────────────────
const EXPAND_SVG = `<svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><polyline points="1,4 1,1 4,1"/><polyline points="7,1 10,1 10,4"/><polyline points="10,7 10,10 7,10"/><polyline points="4,10 1,10 1,7"/></svg>`;
const RETURN_SVG = `<svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><polyline points="4,1 1,1 1,4"/><polyline points="10,1 10,4"/><polyline points="10,7 10,10 7,10"/><polyline points="1,7 1,10 4,10"/><line x1="1" y1="1" x2="4" y2="4"/><line x1="10" y1="10" x2="7" y2="7"/></svg>`;

function collapseExpandedCard() {
  const card = document.querySelector('.explore-card.card-expanded');
  if (!card) return;
  const btn = card.querySelector('.card-expand-btn');
  card.classList.remove('card-expanded');
  btn.innerHTML = EXPAND_SVG;
  btn.title = 'Expand';
  resizeExploreChart(card);
}

function toggleCardExpand(btn) {
  const card = btn.closest('.explore-card');
  // collapse any other expanded card first
  document.querySelectorAll('.explore-card.card-expanded').forEach(other => {
    if (other !== card) {
      other.classList.remove('card-expanded');
      other.querySelector('.card-expand-btn').innerHTML = EXPAND_SVG;
      other.querySelector('.card-expand-btn').title = 'Expand';
    }
  });
  const isExpanded = card.classList.toggle('card-expanded');
  if (isExpanded) {
    btn.innerHTML = RETURN_SVG + ' Return';
    btn.title = 'Return';
  } else {
    btn.innerHTML = EXPAND_SVG;
    btn.title = 'Expand';
  }
  resizeExploreChart(card);
}

function resizeExploreChart(card) {
  if (!exploreChart) return;
  const wrap = document.getElementById('explore-chart-wrap');
  if (wrap && card.contains(wrap)) {
    requestAnimationFrame(() =>
      exploreChart.applyOptions({ width: wrap.offsetWidth, height: wrap.offsetHeight })
    );
  }
}

document.querySelectorAll('.card-expand-btn').forEach(btn =>
  btn.addEventListener('click', () => toggleCardExpand(btn))
);

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') collapseExpandedCard();
});

// ── Init ──────────────────────────────────────────────────────────────────────
initChart();
loadPortfolio();
setInterval(loadPortfolio, 15000);
fetchProfile();
fetchFactors();
