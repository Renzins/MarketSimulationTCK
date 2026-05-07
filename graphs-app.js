// graphs-app.js — UI controller for the Graphs page (graphs.html).
//
// ARCHITECTURE
// ============
// Loads the same WIND_DATA + Engine bootstrap as the Backtester so the
// simulation window state is shared (changing sim window on either page
// affects both — but each page reads/writes Engine.setWindow() in its own
// updateAll path). Charts are computed by GraphsEngine and rendered by
// GraphsCharts.
//
// The page is structured into:
//   - Setup group:   sim date range, winsorize spread (10/90), surplus/deficit thresholds (±30)
//   - Bucket counts: wind / solar / DA price bands / matched-panel levels
//   - 7 charts:
//       1-2: 1-D box plot, spread by wind, SURPLUS / DEFICIT
//       3-4: 1-D box plot, spread by solar, SURPLUS / DEFICIT
//       5-6: 2-D heatmap, spread by Wind × Solar, DEFICIT / SURPLUS
//       7-9: matched-by-DA-band panels: Wind / Solar / Renewables (wind+solar)
//   - aFRR placeholder card (no data yet)
//
// Quantile bin boundaries are recomputed on every `updateAll()` from the
// values within the current Engine window.
//
// IMPORTANT INVARIANTS
// ====================
//   - Surplus/deficit thresholds (±30 default) define a dead band:
//     ISPs with baltic_imb_vol strictly between thresholds are excluded
//     from BOTH regimes. Setting both to 0 reproduces sign-only behaviour.
//   - Date inputs are text DD/MM/YYYY, same as the Backtester.

(() => {
  // ---------- bootstrap --------------------------------------------------
  const D = Engine.init(WIND_DATA);
  GraphsEngine.init();

  const startTs = Engine.tsAt(0);
  const endTs = Engine.tsAt(D.n - 1);
  const fmtDateOnly = (d) => d.toISOString().substring(0, 10);
  const fmtDateEU = (d) => {
    const dd = String(d.getUTCDate()).padStart(2, "0");
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const yyyy = d.getUTCFullYear();
    return `${dd}/${mm}/${yyyy}`;
  };
  function parseEU(str) {
    if (!str) return null;
    const m = str.trim().match(/^(\d{1,2})[\/\.\-](\d{1,2})[\/\.\-](\d{4})$/);
    if (!m) return null;
    return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  function isoToEU(iso) {
    if (!iso) return "";
    const [y, m, d] = iso.split("-");
    return `${d}/${m}/${y}`;
  }
  document.getElementById("data-range").textContent =
    `${fmtDateEU(startTs)} → ${fmtDateEU(endTs)} (${D.n.toLocaleString()} ISPs)`;
  const dataMinDate = fmtDateOnly(startTs);
  const dataMaxDate = fmtDateOnly(endTs);

  // ---------- state ------------------------------------------------------
  const state = {
    sim: { from: dataMinDate, to: dataMaxDate },
    winsorMfrrLo: 10,
    winsorMfrrHi: 90,
    deficitThr: -30, // baltic_imb_vol ≤ this → deficit
    surplusThr: 30, // baltic_imb_vol ≥ this → surplus
    buckets: {
      wind: 4,
      solar: 4,
      daBand: 5,
      // Number of level rows in EVERY matched-by-DA chart (wind / solar /
      // renewables share the same level count for visual consistency).
      matchedLevels: 3,
    },
  };

  // ---------- generate setup cards ---------------------------------------
  function setupCardHTML() {
    return `
      <div class="control sim-range">
        <label>Simulation date range<span class="unit">DD/MM/YYYY</span></label>
        <div class="slider-row two">
          <input type="text" inputmode="numeric" placeholder="DD/MM/YYYY"
                 pattern="\\d{2}/\\d{2}/\\d{4}" maxlength="10"
                 id="g-sim-from" value="${isoToEU(state.sim.from)}">
          <span>→</span>
          <input type="text" inputmode="numeric" placeholder="DD/MM/YYYY"
                 pattern="\\d{2}/\\d{2}/\\d{4}" maxlength="10"
                 id="g-sim-to" value="${isoToEU(state.sim.to)}">
          <button type="button" class="btn small" id="g-sim-reset" title="Reset to full dataset">↻</button>
        </div>
        <div class="param-desc">
          <p>Restricts every box-plot and heatmap to ISPs in this window. Quantile bin boundaries are also derived within it.</p>
          <ul class="extremes">
            <li><b>Full dataset:</b> all 14+ months of data.</li>
            <li><b>Sub-period:</b> stress-test specific periods (e.g. summer only, single quarter).</li>
          </ul>
        </div>
      </div>

      <div class="control winsor">
        <label>Winsorize spread (percentiles)</label>
        <div class="slider-row two">
          <input type="number" id="g-winsor-lo" value="${state.winsorMfrrLo}" min="0" max="50" step="1">
          <span>/</span>
          <input type="number" id="g-winsor-hi" value="${state.winsorMfrrHi}" min="50" max="100" step="1">
        </div>
        <div class="param-desc">
          <p>Caps the spread (P<sub>mFRR</sub> − P<sub>DA</sub>) at the chosen percentiles within the window. Tames the −10 000 / +10 000 EUR/MWh outliers in the 2025–2026 data.</p>
          <ul class="extremes">
            <li><b>0 / 100:</b> raw outliers retained.</li>
            <li><b>10 / 90:</b> default — typical robustness for box plots.</li>
          </ul>
        </div>
      </div>

      <div class="control">
        <label>Surplus / deficit thresholds<span class="unit">MW</span></label>
        <div class="slider-row two">
          <input type="number" id="g-deficit-thr" value="${state.deficitThr}" step="1" style="width: 80px">
          <span>/</span>
          <input type="number" id="g-surplus-thr" value="${state.surplusThr}" step="1" style="width: 80px">
        </div>
        <div class="param-desc">
          <p>Classifies each ISP by the sum of LV+EE+LT imbalance volumes. ISPs with sum ≤ deficit threshold go into the DEFICIT graphs; sum ≥ surplus threshold into the SURPLUS graphs. Values strictly between (the dead band) are excluded.</p>
          <ul class="extremes">
            <li><b>−30 / +30 (default):</b> ignores small noise around zero.</li>
            <li><b>0 / 0:</b> every non-zero ISP counts, no neutral band.</li>
            <li><b>−100 / +100:</b> only large imbalances qualify; smaller datasets per regime.</li>
          </ul>
        </div>
      </div>
    `;
  }

  function bucketCardHTML() {
    const def = (key, label, def_, max_, desc, ex) => `
      <div class="control">
        <label for="g-buck-${key}">${label}<span class="unit">bins</span></label>
        <div class="slider-row">
          <input type="range" id="g-buck-${key}" min="2" max="${max_}" step="1" value="${state.buckets[key]}">
          <input type="number" id="g-buck-${key}-num" value="${state.buckets[key]}" min="2" max="${max_}" step="1">
        </div>
        <div class="param-desc">
          <p>${desc}</p>
          <ul class="extremes">
            ${ex.map(([v, m]) => `<li><b>${v}:</b> ${m}</li>`).join("")}
          </ul>
        </div>
      </div>`;
    return [
      def(
        "wind",
        "Wind buckets",
        4,
        12,
        "Quantile bins for the Baltic wind forecast (used by the wind 1-D plots and the wind axis of the heatmap).",
        [
          ["2", "coarse — surplus vs deficit only"],
          ["8", "fine-grained, may have small per-bucket sample sizes"],
        ],
      ),
      def(
        "solar",
        "Solar buckets",
        4,
        12,
        "Quantile bins for the Baltic solar forecast (used by the solar 1-D plots and the solar axis of the heatmap).",
        [
          ["2", "coarse — daylight vs night roughly"],
          ["8", "fine — splits high-irradiance hours into multiple bands"],
        ],
      ),
      def(
        "daBand",
        "DA price bands",
        5,
        10,
        "Number of panels in the matched-by-DA chart. Each panel covers one quantile of DA price.",
        [
          ["3", "wide bands"],
          ["8", "fine bands — narrow panels, fewer ISPs each"],
        ],
      ),
      def(
        "matchedLevels",
        "Levels (matched panels)",
        3,
        6,
        "Number of level rows in each matched-by-DA chart. Applied to all three (wind / solar / renewables) for visual consistency. Within each DA-price panel, the level axis is split into this many global quantile bins.",
        [
          ["2", "Low / High only"],
          ["3", "Low / Mid / High (default)"],
          ["5", "Very-low / Low / Mid / High / Very-high"],
        ],
      ),
    ].join("");
  }

  function renderCards() {
    document.getElementById("g-setup-params").innerHTML = setupCardHTML();
    document.getElementById("g-bucket-params").innerHTML = bucketCardHTML();
  }

  // ---------- date helpers shared with backtester ------------------------
  function clampDate(s, lo, hi) {
    if (s < lo) return lo;
    if (s > hi) return hi;
    return s;
  }
  function idxAtOrAfter(dateStr) {
    const t = new Date(dateStr + "T00:00:00Z").getTime();
    const startMs = new Date(D.start_iso).getTime();
    const targetOffset = (t - startMs) / (D.step_min * 60000);
    let lo = 0,
      hi = D.n - 1,
      ans = D.n;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (D.offsets[mid] >= targetOffset) {
        ans = mid;
        hi = mid - 1;
      } else lo = mid + 1;
    }
    return ans;
  }
  function rangeToIdx(fromStr, toStr) {
    const start = idxAtOrAfter(fromStr);
    const next = new Date(toStr + "T00:00:00Z");
    next.setUTCDate(next.getUTCDate() + 1);
    const end = idxAtOrAfter(next.toISOString().substring(0, 10));
    return { start, end };
  }

  // ---------- main update path -------------------------------------------
  let updateTimer = null;
  function scheduleUpdate() {
    clearTimeout(updateTimer);
    updateTimer = setTimeout(updateAll, 60);
  }

  function updateAll() {
    const progEl = document.getElementById("g-progress");
    progEl.textContent = "computing…";
    setTimeout(() => {
      const t0 = performance.now();
      const { start, end } = rangeToIdx(state.sim.from, state.sim.to);
      Engine.setWindow(start, end);
      GraphsEngine.setRegimeThresholds(state.deficitThr, state.surplusThr);
      GraphsEngine.maybeWinsorizeSpread(state.winsorMfrrLo, state.winsorMfrrHi);

      const wB = state.buckets.wind;
      const sB = state.buckets.solar;
      const daB = state.buckets.daBand;
      const mL = state.buckets.matchedLevels;

      // Graphs 1 & 2: spread by wind, surplus & deficit
      const wSurp = GraphsEngine.spreadByAxisRegime("wind", "surplus", wB);
      const wDef = GraphsEngine.spreadByAxisRegime("wind", "deficit", wB);
      GraphsCharts.drawSpreadByBucket(
        "g-wind-surplus",
        wSurp,
        "SURPLUS",
        "Baltic Day-Ahead Wind Forecast",
        `SURPLUS — mFRR spread by Wind power (n=${wSurp.totalN.toLocaleString()})`,
      );
      GraphsCharts.drawSpreadByBucket(
        "g-wind-deficit",
        wDef,
        "DEFICIT",
        "Baltic Day-Ahead Wind Forecast",
        `DEFICIT — mFRR spread by Wind power (n=${wDef.totalN.toLocaleString()})`,
      );

      // Graphs 3 & 4: spread by solar
      const sSurp = GraphsEngine.spreadByAxisRegime("solar", "surplus", sB);
      const sDef = GraphsEngine.spreadByAxisRegime("solar", "deficit", sB);
      GraphsCharts.drawSpreadByBucket(
        "g-solar-surplus",
        sSurp,
        "SURPLUS",
        "Baltic Day-Ahead Solar Forecast",
        `SURPLUS — mFRR spread by Solar power (n=${sSurp.totalN.toLocaleString()})`,
      );
      GraphsCharts.drawSpreadByBucket(
        "g-solar-deficit",
        sDef,
        "DEFICIT",
        "Baltic Day-Ahead Solar Forecast",
        `DEFICIT — mFRR spread by Solar power (n=${sDef.totalN.toLocaleString()})`,
      );

      // Graphs 5 & 6: heatmap
      const hDef = GraphsEngine.spreadByWindSolarRegime("deficit", wB, sB);
      const hSurp = GraphsEngine.spreadByWindSolarRegime("surplus", wB, sB);
      GraphsCharts.drawWindSolarHeatmap(
        "g-heatmap-deficit",
        hDef,
        "DEFICIT",
        `DEFICIT — Spread by Wind × Solar (${wB}×${sB} bins)`,
      );
      GraphsCharts.drawWindSolarHeatmap(
        "g-heatmap-surplus",
        hSurp,
        "SURPLUS",
        `SURPLUS — Spread by Wind × Solar (${wB}×${sB} bins)`,
      );

      // Graphs 7-9: matched-by-DA (wind / solar / renewables)
      const matchedWind = GraphsEngine.absSpreadByWindMatchedByDABand(daB, mL);
      GraphsCharts.drawAbsSpreadMatchedPanels(
        "g-matched",
        matchedWind,
        `|Spread| by Wind Level — Matched by DA Price Band (${daB} panels × ${mL} levels)`,
      );
      const matchedSolar = GraphsEngine.absSpreadBySolarMatchedByDABand(daB, mL);
      GraphsCharts.drawAbsSpreadMatchedPanels(
        "g-matched-solar",
        matchedSolar,
        `|Spread| by Solar Level — Matched by DA Price Band (${daB} panels × ${mL} levels)`,
      );
      const matchedRenew = GraphsEngine.absSpreadByRenewablesMatchedByDABand(daB, mL);
      GraphsCharts.drawAbsSpreadMatchedPanels(
        "g-matched-renew",
        matchedRenew,
        `|Spread| by Renewables Level (Wind+Solar) — Matched by DA Price Band (${daB} panels × ${mL} levels)`,
      );

      const ms = Math.round(performance.now() - t0);
      progEl.textContent = `done in ${ms} ms`;
    }, 30);
  }

  // ---------- bind controls ----------------------------------------------
  function bindControls() {
    // Sim range — text inputs in DD/MM/YYYY
    const fromEl = document.getElementById("g-sim-from");
    const toEl = document.getElementById("g-sim-to");
    const onSim = () => {
      let f = clampDate(parseEU(fromEl.value) || dataMinDate, dataMinDate, dataMaxDate);
      let t = clampDate(parseEU(toEl.value) || dataMaxDate, dataMinDate, dataMaxDate);
      if (f > t) [f, t] = [t, f];
      fromEl.value = isoToEU(f);
      toEl.value = isoToEU(t);
      state.sim = { from: f, to: t };
      scheduleUpdate();
    };
    fromEl.addEventListener("change", onSim);
    toEl.addEventListener("change", onSim);
    document.getElementById("g-sim-reset").addEventListener("click", () => {
      fromEl.value = isoToEU(dataMinDate);
      toEl.value = isoToEU(dataMaxDate);
      onSim();
    });
    // Winsor
    const winLo = document.getElementById("g-winsor-lo");
    const winHi = document.getElementById("g-winsor-hi");
    const onWin = () => {
      state.winsorMfrrLo = Math.max(0, Math.min(50, parseFloat(winLo.value) || 0));
      state.winsorMfrrHi = Math.max(50, Math.min(100, parseFloat(winHi.value) || 100));
      winLo.value = state.winsorMfrrLo;
      winHi.value = state.winsorMfrrHi;
      scheduleUpdate();
    };
    winLo.addEventListener("change", onWin);
    winHi.addEventListener("change", onWin);
    // Regime thresholds
    const defThr = document.getElementById("g-deficit-thr");
    const surThr = document.getElementById("g-surplus-thr");
    const onThr = () => {
      let d = parseFloat(defThr.value);
      let s = parseFloat(surThr.value);
      if (isNaN(d)) d = 0;
      if (isNaN(s)) s = 0;
      if (d > s) [d, s] = [s, d];
      defThr.value = d;
      surThr.value = s;
      state.deficitThr = d;
      state.surplusThr = s;
      scheduleUpdate();
    };
    defThr.addEventListener("change", onThr);
    surThr.addEventListener("change", onThr);
    // Buckets
    for (const key of ["wind", "solar", "daBand", "matchedLevels"]) {
      const slider = document.getElementById(`g-buck-${key}`);
      const num = document.getElementById(`g-buck-${key}-num`);
      const onSet = (raw) => {
        let v = parseInt(raw, 10);
        if (isNaN(v)) return;
        v = Math.max(2, Math.min(parseInt(slider.max, 10), v));
        slider.value = v;
        num.value = v;
        state.buckets[key] = v;
        scheduleUpdate();
      };
      slider.addEventListener("input", (e) => onSet(e.target.value));
      num.addEventListener("change", (e) => onSet(e.target.value));
    }
    // Recompute (also clears cache)
    document.getElementById("g-recompute").addEventListener("click", updateAll);
  }

  // ---------- tabs -------------------------------------------------------
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(`panel-${btn.dataset.section}`).classList.add("active");
    });
  });

  // ---------- init -------------------------------------------------------
  renderCards();
  bindControls();
  updateAll();
})();
