// afrr-engine.js — pure data layer for the aFRR sub-tab of the Graphs page.
//
// Reads from AFRR_DATA (per-ISP activation counts pre-computed by
// preprocess-afrr.py) and from the main Engine's typed arrays for the
// imbalance-volume columns that drive regime classification.
//
// CRITICAL INVARIANT: the aFRR data file deliberately keeps activation
// COUNTS rather than 4-second prices, so prices are NEVER averaged up to
// 15-minute resolution. Future price-related graphs will need a separate,
// non-aggregated 4s data feed; the current bar-charts only need counts.
//
// COLUMN CONVENTIONS (per ISP i, indexed identically to main data.js)
//   AFRR_DATA.n_total[i]  = number of 4-second slots in this ISP's window
//                           (≈ 225 = 15 × 60 / 4 once aFRR data starts;
//                           0 for ISPs before 2025-05-01)
//   AFRR_DATA.n_pos[i]    = count where AST_POS (upward price) is non-null
//   AFRR_DATA.n_neg[i]    = count where AST_NEG (downward price) is non-null
//   AFRR_DATA.n_any[i]    = count where at least one direction is non-null
//
// REGIME CLASSIFICATION
//   The aFRR section can split ISPs by either Latvia-only or full Baltic
//   imbalance volume. Two sets of thresholds (ind. of the mFRR section's):
//     LV: default ±10 MW   (LV is ~1/3 the magnitude of Baltic)
//     Baltic: default ±30 MW
//
// EXPORTS
//   init()                                  — wrap AFRR_DATA into Int16Arrays
//   setLvThresholds(deficit, surplus)       — module-level pair for LV regime
//   setBalticThresholds(deficit, surplus)   — module-level pair for Baltic regime
//   activationRateByRegime(level)           — { surplus: {...}, deficit: {...} }
//                                             where level = "lv" | "baltic"

const AfrrEngine = (() => {
  let D = null; // main Engine.getData() reference (for imbalance arrays)
  let A = null; // typed-array view of AFRR_DATA

  function init() {
    D = Engine.getData();
    if (typeof AFRR_DATA === "undefined") {
      console.warn("AFRR_DATA not loaded — aFRR section will be empty");
      return;
    }
    A = {
      n: AFRR_DATA.n,
      n_total: new Int16Array(AFRR_DATA.n_total),
      n_pos: new Int16Array(AFRR_DATA.n_pos),
      n_neg: new Int16Array(AFRR_DATA.n_neg),
      n_any: new Int16Array(AFRR_DATA.n_any),
      afrr_start_iso: AFRR_DATA.afrr_start_iso,
      afrr_end_iso: AFRR_DATA.afrr_end_iso,
    };
  }

  function getAfrrRange() {
    if (!A) return null;
    return { from: A.afrr_start_iso, to: A.afrr_end_iso };
  }

  // --------- regime thresholds (separate for LV vs Baltic) ---------------
  let _lvDeficit = -10;
  let _lvSurplus = +10;
  let _balticDeficit = -30;
  let _balticSurplus = +30;
  // "Rest of Baltic" = EE + LT only, computed on the fly as
  //   rest = baltic_imb_vol − lv_imb_vol
  // Used by the divergence chart to detect periods where Latvia
  // disagrees in sign with the rest of the synchronous area.
  let _restDeficit = -20;
  let _restSurplus = +20;

  function setLvThresholds(deficitThr, surplusThr) {
    _lvDeficit = deficitThr;
    _lvSurplus = surplusThr;
  }
  function setBalticThresholds(deficitThr, surplusThr) {
    _balticDeficit = deficitThr;
    _balticSurplus = surplusThr;
  }
  function setRestOfBalticThresholds(deficitThr, surplusThr) {
    _restDeficit = deficitThr;
    _restSurplus = surplusThr;
  }

  // --------- activation rate computation ---------------------------------
  // Each 4-second slot lands in EXACTLY ONE of four mutually-exclusive states:
  //   neither   — both AST_POS and AST_NEG are NaN  (no activation)
  //   pos_only  — AST_POS non-null, AST_NEG NaN     (upward only)
  //   neg_only  — AST_NEG non-null, AST_POS NaN     (downward only)
  //   both      — both non-null                     (both directions firing)
  // The four counts always sum to n_total. We derive them from the stored
  // pos / neg / any counts via:
  //   n_both     = n_pos + n_neg − n_any   (set algebra)
  //   n_pos_only = n_pos − n_both
  //   n_neg_only = n_neg − n_both
  //   n_neither  = n_total − n_any
  //
  // Returns:
  //   { level, thresholds, surplus: {...}, deficit: {...} }
  //   where each regime block has n_isps, n_total, n_neither, n_pos_only,
  //   n_neg_only, n_both, plus convenience pct_* fractions of n_total.
  // level = 'lv' | 'baltic' — which imbalance volume to classify on.
  function activationRateByRegime(level) {
    if (!A) return _emptyResult(level);
    const win = Engine.getWindow();
    const imb = level === "lv" ? D.lv_imb_vol : D.baltic_imb_vol;
    if (!imb) return _emptyResult(level);
    const dThr = level === "lv" ? _lvDeficit : _balticDeficit;
    const sThr = level === "lv" ? _lvSurplus : _balticSurplus;

    let s = _emptyBucket();
    let d = _emptyBucket();

    for (let i = win.start; i < win.end; i++) {
      // Skip ISPs that aren't covered by the aFRR data file
      const tot = A.n_total[i];
      if (tot === 0) continue;
      const iv = imb[i];
      if (isNaN(iv)) continue;

      const nPos = A.n_pos[i];
      const nNeg = A.n_neg[i];
      const nAny = A.n_any[i];
      // n_both = |POS ∩ NEG| = |POS| + |NEG| − |POS ∪ NEG|
      const nBoth = nPos + nNeg - nAny;
      const nPosOnly = nPos - nBoth;
      const nNegOnly = nNeg - nBoth;
      const nNeither = tot - nAny;

      const bucket = iv >= sThr ? s : iv <= dThr ? d : null;
      if (bucket === null) continue;
      bucket.n_isps += 1;
      bucket.n_total += tot;
      bucket.n_neither += nNeither;
      bucket.n_pos_only += nPosOnly;
      bucket.n_neg_only += nNegOnly;
      bucket.n_both += nBoth;
    }
    _finalize(s);
    _finalize(d);
    return {
      level,
      thresholds: { deficit: dThr, surplus: sThr },
      surplus: s,
      deficit: d,
    };
  }

  function _emptyBucket() {
    return {
      n_isps: 0,
      n_total: 0,
      n_neither: 0,
      n_pos_only: 0,
      n_neg_only: 0,
      n_both: 0,
      pct_neither: 0,
      pct_pos_only: 0,
      pct_neg_only: 0,
      pct_both: 0,
    };
  }
  function _finalize(b) {
    if (b.n_total <= 0) return;
    b.pct_neither = b.n_neither / b.n_total;
    b.pct_pos_only = b.n_pos_only / b.n_total;
    b.pct_neg_only = b.n_neg_only / b.n_total;
    b.pct_both = b.n_both / b.n_total;
  }
  function _emptyResult(level) {
    return {
      level: level || "lv",
      thresholds: { deficit: 0, surplus: 0 },
      surplus: _emptyBucket(),
      deficit: _emptyBucket(),
    };
  }

  // --------- cross-regime divergence -------------------------------------
  // Two cases describe periods where Latvia disagrees in sign with the rest
  // of the Baltic synchronous area:
  //   case_a (lv_pos_rest_neg): lv_imb_vol >= lv_surplus_thr   AND
  //                             rest_of_baltic <= rest_deficit_thr
  //   case_b (lv_neg_rest_pos): lv_imb_vol <= lv_deficit_thr   AND
  //                             rest_of_baltic >= rest_surplus_thr
  // where rest_of_baltic = baltic_imb_vol − lv_imb_vol.
  //
  // Returns the same per-bucket shape as activationRateByRegime() so the
  // existing 4-segment bar drawer can render it without changes.
  function activationRateByDivergence() {
    if (!A) return _emptyDivergence();
    if (!D.lv_imb_vol || !D.baltic_imb_vol) return _emptyDivergence();
    const win = Engine.getWindow();
    const lv = D.lv_imb_vol;
    const baltic = D.baltic_imb_vol;
    const a = _emptyBucket(); // case A: LV+ / rest−
    const b = _emptyBucket(); // case B: LV− / rest+
    for (let i = win.start; i < win.end; i++) {
      const tot = A.n_total[i];
      if (tot === 0) continue;
      const lvVal = lv[i];
      const balVal = baltic[i];
      if (isNaN(lvVal) || isNaN(balVal)) continue;
      const rest = balVal - lvVal;
      const isCaseA = lvVal >= _lvSurplus && rest <= _restDeficit;
      const isCaseB = lvVal <= _lvDeficit && rest >= _restSurplus;
      const bucket = isCaseA ? a : isCaseB ? b : null;
      if (bucket === null) continue;
      const nPos = A.n_pos[i];
      const nNeg = A.n_neg[i];
      const nAny = A.n_any[i];
      const nBoth = nPos + nNeg - nAny;
      bucket.n_isps += 1;
      bucket.n_total += tot;
      bucket.n_neither += tot - nAny;
      bucket.n_pos_only += nPos - nBoth;
      bucket.n_neg_only += nNeg - nBoth;
      bucket.n_both += nBoth;
    }
    _finalize(a);
    _finalize(b);
    // Return a result with the same shape as activationRateByRegime() but
    // with case_a / case_b instead of surplus / deficit, so the bar drawer
    // can be reused. The aliases on `surplus` / `deficit` keep the existing
    // template happy; the chart just gets custom x-labels.
    return {
      level: "divergence",
      thresholds: {
        lv_deficit: _lvDeficit,
        lv_surplus: _lvSurplus,
        rest_deficit: _restDeficit,
        rest_surplus: _restSurplus,
      },
      // `surplus` slot holds case A (LV+ / rest−), `deficit` slot holds case B.
      // The chart relabels them to the meaningful divergence labels.
      surplus: a,
      deficit: b,
    };
  }

  function _emptyDivergence() {
    return {
      level: "divergence",
      thresholds: { lv_deficit: 0, lv_surplus: 0, rest_deficit: 0, rest_surplus: 0 },
      surplus: _emptyBucket(),
      deficit: _emptyBucket(),
    };
  }

  return {
    init,
    getAfrrRange,
    setLvThresholds,
    setBalticThresholds,
    setRestOfBalticThresholds,
    activationRateByRegime,
    activationRateByDivergence,
  };
})();

if (typeof module !== "undefined") module.exports = AfrrEngine;
