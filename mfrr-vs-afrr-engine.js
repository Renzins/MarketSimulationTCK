// mfrr-vs-afrr-engine.js — pure data layer for the "mFRR vs aFRR" sub-tab
// of the Graphs page.
//
// Reads from Engine.getData() (post-init) so the date-range window state
// is shared with the rest of the page. Treats AFRR_15MIN's avg_p_pos /
// avg_p_neg as the per-ISP aFRR price proxies.
//
// COLUMN CONVENTIONS
//   mfrrSpread[i]    = p_mfrr_raw[i] − p_da[i]              (signed; NaN when p_mfrr NaN)
//   afrrPosSpread[i] = avg_p_pos_raw[i] − p_da[i]           (only when avg_p_pos > 0; else NaN)
//   afrrNegSpread[i] = avg_p_neg_raw[i] − p_da[i]           (only when avg_p_neg < 0; else NaN)
//
// Raw mFRR is used (not winsorized) because the agreement question is
// about ALL clearings — capping outliers at the 5/95 percentile would
// distort the sign-agreement counts.
//
// DIRECTION CLASSIFICATION
//   mFRR direction:    0 = Up (p_mfrr ≥ 1)
//                      1 = Down (p_mfrr ≤ −1)
//                      2 = Dead band (|p_mfrr| < 1)
//   aFRR direction:    0 = Up only      (avg_p_pos > 0 AND avg_p_neg = 0)
//                      1 = Down only    (avg_p_pos = 0 AND avg_p_neg < 0)
//                      2 = Both         (avg_p_pos > 0 AND avg_p_neg < 0)
//                      3 = Neither      (both zero — typically pre-2025-05-01 ISPs)
//
// EXPORTS
//   init()                    — wrap into Float32 spreads
//   setDayTypeFilter(s)       — "all" | "workday" | "weekend-holiday"
//   agreementMatrix()         — 3 × 4 joint cell counts + total
//   signAgreement(dir)        — 2×2 sign×sign counts for aFRR-pos or aFRR-neg
//   spreadScatter(dir, max)   — { x, y, n } for the scatter chart (subsampled)
//   statsScoreboard()         — summary stats (firing rates, co-fire, correlation)

const MfrrAfrrEngine = (() => {
  let D = null;
  let mfrrSpread = null;
  let afrrPosSpread = null;
  let afrrNegSpread = null;
  // n_any from AFRR_DATA, used by the slot-level matrix to split slots
  // into Pos-only / Neg-only / Both / Neither. Engine.js doesn't wrap this
  // (only n_pos / n_neg / n_total), so we do it here.
  let afrrNAny = null;
  let _dayTypeFilter = "all";

  function init() {
    D = Engine.getData();
    if (!D) return false;
    const n = D.n;
    mfrrSpread = new Float32Array(n);
    afrrPosSpread = new Float32Array(n);
    afrrNegSpread = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const pmf = D.p_mfrr_raw[i];
      const pda = D.p_da[i];
      mfrrSpread[i] = isNaN(pmf) ? NaN : pmf - pda;
      const apos = D.avg_p_pos_raw ? D.avg_p_pos_raw[i] : 0;
      const aneg = D.avg_p_neg_raw ? D.avg_p_neg_raw[i] : 0;
      afrrPosSpread[i] = apos > 0 ? apos - pda : NaN;
      afrrNegSpread[i] = aneg < 0 ? aneg - pda : NaN;
    }
    if (typeof AFRR_DATA !== "undefined" && AFRR_DATA && AFRR_DATA.n === n) {
      afrrNAny = new Int16Array(AFRR_DATA.n_any);
    }
    return true;
  }

  // ---------- winsorization ----------------------------------------------
  // Two independent percentile pairs: one for mFRR spread, one for aFRR
  // spread. Bounds are computed lazily and cached per (window, dayType,
  // percentiles, scope). Five caches in total (mFRR is the same number
  // in ISP and slot modes — both use the per-ISP distribution; aFRR
  // distributions differ between ISP-aggregated and per-entry, so they
  // get separate caches per direction).
  let _winsorMfrr = { lo: 10, hi: 90 };
  let _winsorAfrr = { lo: 10, hi: 90 };
  let _bMfrr = null;
  let _bIspAfrrPos = null;
  let _bIspAfrrNeg = null;
  let _bSlotAfrrPos = null;
  let _bSlotAfrrNeg = null;

  function setWinsorMfrr(lo, hi) {
    if (lo === _winsorMfrr.lo && hi === _winsorMfrr.hi) return;
    _winsorMfrr = { lo, hi };
    _bMfrr = null;
  }
  function setWinsorAfrr(lo, hi) {
    if (lo === _winsorAfrr.lo && hi === _winsorAfrr.hi) return;
    _winsorAfrr = { lo, hi };
    _bIspAfrrPos = _bIspAfrrNeg = _bSlotAfrrPos = _bSlotAfrrNeg = null;
  }

  function _percentile(sorted, p) {
    if (!sorted.length) return NaN;
    const idx = (p / 100) * (sorted.length - 1);
    const a = Math.floor(idx);
    const b = Math.ceil(idx);
    if (a === b) return sorted[a];
    return sorted[a] + (sorted[b] - sorted[a]) * (idx - a);
  }
  function _clip(v, b) {
    if (b == null || !isFinite(b.lo) || !isFinite(b.hi)) return v;
    return v < b.lo ? b.lo : v > b.hi ? b.hi : v;
  }
  function _winsorScopeKey() {
    const win = Engine.getWindow();
    return `${win.start}-${win.end}-${_dayTypeFilter}`;
  }

  // mFRR spread bounds. Computed over the per-ISP mfrrSpread distribution
  // in the current window (43k values; cheap to sort). Used in both
  // ISP-level and slot-level modes — slot-level broadcasts the same
  // per-ISP value to all 225 slots, so the percentile of the broadcast
  // distribution is the same as the per-ISP one.
  function _getMfrrBounds() {
    const key = `${_winsorScopeKey()}-${_winsorMfrr.lo}-${_winsorMfrr.hi}`;
    if (_bMfrr && _bMfrr.key === key) return _bMfrr;
    const win = Engine.getWindow();
    const vals = [];
    for (let i = win.start; i < win.end; i++) {
      if (!_acceptsDay(i)) continue;
      const v = mfrrSpread[i];
      if (!isNaN(v)) vals.push(v);
    }
    vals.sort((a, b) => a - b);
    _bMfrr = { key, lo: _percentile(vals, _winsorMfrr.lo), hi: _percentile(vals, _winsorMfrr.hi) };
    return _bMfrr;
  }

  // ISP-level aFRR-pos / neg bounds. Computed over the ISP-aggregated
  // (favourable-only) spreads (afrrPosSpread / afrrNegSpread).
  function _getIspAfrrBounds(direction) {
    const cacheRef = direction === "neg" ? "neg" : "pos";
    const cached = cacheRef === "neg" ? _bIspAfrrNeg : _bIspAfrrPos;
    const key = `${_winsorScopeKey()}-${_winsorAfrr.lo}-${_winsorAfrr.hi}`;
    if (cached && cached.key === key) return cached;
    const arr = cacheRef === "neg" ? afrrNegSpread : afrrPosSpread;
    const win = Engine.getWindow();
    const vals = [];
    for (let i = win.start; i < win.end; i++) {
      if (!_acceptsDay(i)) continue;
      const v = arr[i];
      if (!isNaN(v)) vals.push(v);
    }
    vals.sort((a, b) => a - b);
    const bounds = { key, lo: _percentile(vals, _winsorAfrr.lo), hi: _percentile(vals, _winsorAfrr.hi) };
    if (cacheRef === "neg") _bIspAfrrNeg = bounds;
    else _bIspAfrrPos = bounds;
    return bounds;
  }

  // Slot-level aFRR-pos / neg bounds. Computed over per-entry spreads from
  // AFRR_PRICES (~4 M values each direction). Distribution differs from
  // the ISP-aggregated one (no favourable filter, no /225 averaging), so
  // bounds will be quantitatively different.
  function _getSlotAfrrBounds(direction) {
    if (!isSlotDataLoaded()) return null;
    const cacheRef = direction === "neg" ? "neg" : "pos";
    const cached = cacheRef === "neg" ? _bSlotAfrrNeg : _bSlotAfrrPos;
    const key = `${_winsorScopeKey()}-${_winsorAfrr.lo}-${_winsorAfrr.hi}`;
    if (cached && cached.key === key) return cached;
    const win = Engine.getWindow();
    const isp = AFRR_PRICES.isp_idx;
    const sp = AFRR_PRICES.spread_x10;
    const kStart = cacheRef === "neg" ? AFRR_PRICES.n_pos_entries : 0;
    const kEnd =
      cacheRef === "neg" ? AFRR_PRICES.n_entries : AFRR_PRICES.n_pos_entries;
    // Single pass: count valid entries, then typed-array allocation, then fill.
    let nValid = 0;
    for (let k = kStart; k < kEnd; k++) {
      const i = isp[k];
      if (i < win.start || i >= win.end) continue;
      if (!_acceptsDay(i)) continue;
      nValid++;
    }
    const buf = new Float32Array(nValid);
    let off = 0;
    for (let k = kStart; k < kEnd; k++) {
      const i = isp[k];
      if (i < win.start || i >= win.end) continue;
      if (!_acceptsDay(i)) continue;
      buf[off++] = sp[k] * 0.1;
    }
    buf.sort();
    const bounds = {
      key,
      lo: _percentile(buf, _winsorAfrr.lo),
      hi: _percentile(buf, _winsorAfrr.hi),
    };
    if (cacheRef === "neg") _bSlotAfrrNeg = bounds;
    else _bSlotAfrrPos = bounds;
    return bounds;
  }

  // Expose the current bounds so the UI can render live cap previews.
  function getCurrentBounds(scope, direction) {
    if (scope === "mfrr") return _getMfrrBounds();
    if (scope === "isp") return _getIspAfrrBounds(direction);
    if (scope === "slot") return _getSlotAfrrBounds(direction);
    return null;
  }

  // ---------- 4-s slot-level mode ----------------------------------------
  // The slot-level analysis treats each 4-s aFRR clearing as a separate
  // data point. mFRR (which clears once per 15-min ISP) is BROADCAST across
  // all 225 slots in that ISP. The comparison then asks:
  //   "for each 4-s slot where aFRR cleared, did the encompassing ISP's
  //    mFRR clearing also indicate the same direction?"
  // Uses the lazy-loaded AFRR_PRICES global (set up by graphs-app.js's
  // loadAfrrPriceData()). When that global is absent, the slot-level
  // methods return null so the caller can render a loading state.
  function isSlotDataLoaded() {
    return typeof AFRR_PRICES !== "undefined" && AFRR_PRICES !== null;
  }

  // ---------- day-type filter ---------------------------------------------
  // Same semantics as GraphsEngine / AfrrEngine. Reads dayTypeMask from
  // Engine.getData(); when "all" every ISP passes.
  function setDayTypeFilter(filter) {
    _dayTypeFilter = filter || "all";
  }
  function _acceptsDay(i) {
    if (_dayTypeFilter === "all") return true;
    if (!D.dayTypeMask) return true;
    const v = D.dayTypeMask[i];
    if (_dayTypeFilter === "workday") return v === 0;
    return v !== 0;
  }

  // ---------- internal helpers --------------------------------------------
  function _mfrrDir(pmf) {
    if (pmf >= 1) return 0;
    if (pmf <= -1) return 1;
    return 2;
  }
  function _afrrDir(apos, aneg) {
    const u = apos > 0;
    const d = aneg < 0;
    if (u && !d) return 0;
    if (!u && d) return 1;
    if (u && d) return 2;
    return 3;
  }

  // ---------- 3 × 4 joint direction matrix --------------------------------
  // Returns { cells[3][4], total } where cells[m][a] is the count of ISPs
  // with mFRR direction m and aFRR direction a (see classification above).
  // ISPs with NaN p_mfrr are excluded.
  function agreementMatrix() {
    const win = Engine.getWindow();
    const cells = [
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ];
    let total = 0;
    for (let i = win.start; i < win.end; i++) {
      if (!_acceptsDay(i)) continue;
      const pmf = D.p_mfrr_raw[i];
      if (isNaN(pmf)) continue;
      const apos = D.avg_p_pos_raw ? D.avg_p_pos_raw[i] : 0;
      const aneg = D.avg_p_neg_raw ? D.avg_p_neg_raw[i] : 0;
      cells[_mfrrDir(pmf)][_afrrDir(apos, aneg)]++;
      total++;
    }
    return { cells, total };
  }

  // ---------- sign agreement (the user's specific request) ----------------
  // For each ISP where BOTH mFRR spread AND aFRR (direction-specific) spread
  // are defined, classify by the 2×2 sign×sign matrix.
  // Returns { counts: {ppos, pneg, npos, nneg}, total }:
  //   ppos = mFRR spread ≥ 0 AND aFRR spread ≥ 0   (agreement, "both positive")
  //   nneg = mFRR spread < 0 AND aFRR spread < 0   (agreement, "both negative")
  //   pneg = mFRR + / aFRR −                      (disagreement)
  //   npos = mFRR − / aFRR +                      (disagreement)
  //
  // Spreads are CLIPPED to the winsor bounds before sign-checking. With
  // mild winsorization (default 5/95) this rarely flips a sign; with
  // aggressive winsorization (e.g. 25/75 where the lower bound lands above
  // zero) it can flip negative values to positive — that's the user's
  // explicit choice and matches the rest of the codebase's convention.
  //
  // Caveat: aFRR-dn spread is virtually always negative (avg_p_neg ≤ 0,
  // p_da typically > 0), so for direction="neg" the sign-agreement reduces
  // to "is mFRR also below DA". The result is heavily skewed; not as
  // informative as the "pos" case.
  function signAgreement(direction) {
    const win = Engine.getWindow();
    const arr = direction === "neg" ? afrrNegSpread : afrrPosSpread;
    const mB = _getMfrrBounds();
    const aB = _getIspAfrrBounds(direction);
    const c = { ppos: 0, pneg: 0, npos: 0, nneg: 0 };
    for (let i = win.start; i < win.end; i++) {
      if (!_acceptsDay(i)) continue;
      const ms_raw = mfrrSpread[i];
      const as_raw = arr[i];
      if (isNaN(ms_raw) || isNaN(as_raw)) continue;
      const ms = _clip(ms_raw, mB);
      const as = _clip(as_raw, aB);
      if (ms >= 0 && as >= 0) c.ppos++;
      else if (ms >= 0 && as < 0) c.pneg++;
      else if (ms < 0 && as >= 0) c.npos++;
      else c.nneg++;
    }
    const total = c.ppos + c.pneg + c.npos + c.nneg;
    return { counts: c, total };
  }

  // ---------- spread × spread scatter -------------------------------------
  // Raw point cloud for visualising the spread relationship.
  // Spreads are clipped to the winsor bounds so the scatter range stays
  // readable (otherwise a couple of ±10 000 €/MWh outliers would
  // compress every other point into a single pixel near the origin).
  // Subsamples to maxPoints (default 8000) so Plotly stays responsive.
  function spreadScatter(direction, maxPoints = 8000) {
    const win = Engine.getWindow();
    const arr = direction === "neg" ? afrrNegSpread : afrrPosSpread;
    const mB = _getMfrrBounds();
    const aB = _getIspAfrrBounds(direction);
    const xs = [];
    const ys = [];
    for (let i = win.start; i < win.end; i++) {
      if (!_acceptsDay(i)) continue;
      const ms_raw = mfrrSpread[i];
      const as_raw = arr[i];
      if (isNaN(ms_raw) || isNaN(as_raw)) continue;
      xs.push(_clip(ms_raw, mB));
      ys.push(_clip(as_raw, aB));
    }
    const nTotal = xs.length;
    if (nTotal <= maxPoints) return { x: xs, y: ys, n: nTotal, subsampled: false };
    const stride = Math.ceil(nTotal / maxPoints);
    const xs2 = new Array(Math.ceil(nTotal / stride));
    const ys2 = new Array(xs2.length);
    let j = 0;
    for (let k = 0; k < nTotal; k += stride) {
      xs2[j] = xs[k];
      ys2[j] = ys[k];
      j++;
    }
    return { x: xs2.slice(0, j), y: ys2.slice(0, j), n: nTotal, subsampled: true };
  }

  // ---------- stats scoreboard --------------------------------------------
  // Single-pass aggregation over the window. Returns headline numbers:
  // total ISPs, firing rates per market, co-firing rates, and Pearson
  // correlation between mFRR spread and aFRR-pos spread (where both
  // defined). All proportions are computed from `nTotal` (the count of
  // valid ISPs with non-NaN p_mfrr in the window).
  function statsScoreboard() {
    const win = Engine.getWindow();
    const mB = _getMfrrBounds();
    const aB = _getIspAfrrBounds("pos");
    let nTotal = 0;
    let nMfrrUp = 0,
      nMfrrDn = 0,
      nMfrrDead = 0;
    let nAfrrUp = 0,
      nAfrrDn = 0,
      nAfrrBoth = 0,
      nAfrrNone = 0;
    let nCoUp = 0,
      nCoDn = 0;
    // Correlation accumulators (winsorized mFRR spread vs aFRR-pos spread).
    let nC = 0,
      sumX = 0,
      sumY = 0,
      sumXY = 0,
      sumXX = 0,
      sumYY = 0;
    for (let i = win.start; i < win.end; i++) {
      if (!_acceptsDay(i)) continue;
      const pmf = D.p_mfrr_raw[i];
      if (isNaN(pmf)) continue;
      nTotal++;
      const mDir = _mfrrDir(pmf);
      if (mDir === 0) nMfrrUp++;
      else if (mDir === 1) nMfrrDn++;
      else nMfrrDead++;
      const apos = D.avg_p_pos_raw ? D.avg_p_pos_raw[i] : 0;
      const aneg = D.avg_p_neg_raw ? D.avg_p_neg_raw[i] : 0;
      const aDir = _afrrDir(apos, aneg);
      if (aDir === 0) nAfrrUp++;
      else if (aDir === 1) nAfrrDn++;
      else if (aDir === 2) nAfrrBoth++;
      else nAfrrNone++;
      // Co-firing: mFRR direction agrees with at least one aFRR direction.
      // - co-up: mFRR Up AND aFRR has any up activity (Up or Both).
      // - co-dn: mFRR Dn AND aFRR has any down activity (Dn or Both).
      if (mDir === 0 && (aDir === 0 || aDir === 2)) nCoUp++;
      if (mDir === 1 && (aDir === 1 || aDir === 2)) nCoDn++;
      // Correlation only counts ISPs with both spreads defined.
      // Clipped to winsor bounds — otherwise a couple of ±10 000 outliers
      // dominate the Pearson term and the central correlation gets buried.
      const ms_raw = mfrrSpread[i];
      const as_raw = afrrPosSpread[i];
      if (!isNaN(ms_raw) && !isNaN(as_raw)) {
        const ms = _clip(ms_raw, mB);
        const as = _clip(as_raw, aB);
        nC++;
        sumX += ms;
        sumY += as;
        sumXY += ms * as;
        sumXX += ms * ms;
        sumYY += as * as;
      }
    }
    let corr = NaN;
    if (nC > 1) {
      const meanX = sumX / nC;
      const meanY = sumY / nC;
      const cov = sumXY / nC - meanX * meanY;
      const varX = sumXX / nC - meanX * meanX;
      const varY = sumYY / nC - meanY * meanY;
      if (varX > 0 && varY > 0) corr = cov / Math.sqrt(varX * varY);
    }
    // Sign-agreement ratio for pos direction (informative one).
    const ag = signAgreement("pos");
    const signAgreePos = ag.total > 0 ? (ag.counts.ppos + ag.counts.nneg) / ag.total : NaN;
    return {
      nTotal,
      nMfrrUp,
      nMfrrDn,
      nMfrrDead,
      nAfrrUp,
      nAfrrDn,
      nAfrrBoth,
      nAfrrNone,
      nCoUp,
      nCoDn,
      corrPos: corr,
      nCorrPos: nC,
      signAgreePos,
      nSignAgreePos: ag.total,
    };
  }

  // 3 × 4 matrix at SLOT level (4-s slots, not ISPs).
  // Rows: mFRR direction (broadcast from the ISP).
  // Cols: aFRR slot type — Pos-only / Neg-only / Both / Neither.
  // Per-ISP counts come from AFRR_DATA (n_pos, n_neg, n_any, n_total);
  // derived counts use set algebra:
  //   n_both     = n_pos + n_neg − n_any
  //   n_pos_only = n_any − n_neg
  //   n_neg_only = n_any − n_pos
  //   n_neither  = n_total − n_any
  // Returns { cells[3][4], total }.
  function slotLevelMatrix() {
    if (!afrrNAny || !D.afrr_n_pos || !D.afrr_n_neg || !D.afrr_n_total) return null;
    const win = Engine.getWindow();
    const cells = [
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ];
    let total = 0;
    for (let i = win.start; i < win.end; i++) {
      if (!_acceptsDay(i)) continue;
      const pmf = D.p_mfrr_raw[i];
      if (isNaN(pmf)) continue;
      const nt = D.afrr_n_total[i] || 0;
      if (nt === 0) continue;
      const np = D.afrr_n_pos[i] || 0;
      const nn = D.afrr_n_neg[i] || 0;
      const na = afrrNAny[i] || 0;
      const nBoth = np + nn - na;
      const nPosOnly = na - nn;
      const nNegOnly = na - np;
      const nNeither = nt - na;
      const m = _mfrrDir(pmf);
      cells[m][0] += nPosOnly;
      cells[m][1] += nNegOnly;
      cells[m][2] += nBoth;
      cells[m][3] += nNeither;
      total += nt;
    }
    return { cells, total };
  }

  // Sign agreement at SLOT level: iterate AFRR_PRICES entries for the
  // requested direction and tally the 2×2 sign×sign matrix between mFRR
  // spread (broadcast from each entry's ISP) and aFRR spread (per entry,
  // = spread_x10 / 10).
  // "Near-DA" band: both prices are within ±10% of DA (or, equivalently,
  // 0.9·|DA| ≤ |price − 0| relative). Captures the user's false-disagreement
  // example: DA=100, aFRR=101, mFRR=99 — strictly the signs of the two
  // spreads disagree, but both prices are essentially AT DA, so it would
  // be misleading to bucket them as "mFRR− / aFRR+". The "near" category
  // collects those cases. Uses absolute-difference test so it also handles
  // negative-p_da rows symmetrically.
  function _isNearDa(price, p_da) {
    return Math.abs(price - p_da) <= 0.1 * Math.abs(p_da);
  }

  // Counts for the slot-level sign-agreement chart. Now SIX buckets:
  //   ppos, pneg, npos, nneg — strict sign-comparison (excluding near-DA)
  //   near_da               — BOTH prices within ±10% of DA (band)
  //   na                    — aFRR direction not activated in that 4-s slot
  //                            (AST_POS or AST_NEG was null upstream)
  //
  // The `na` count is derived from AFRR_DATA (per-ISP n_total − n_dir),
  // since AFRR_PRICES only contains *active* slot entries. All NA slots
  // in a given ISP share the same p_mfrr/p_da, so we don't need per-slot
  // info — just count slots and use the per-ISP mFRR.
  function slotLevelSignAgreement(direction) {
    if (!isSlotDataLoaded()) return null;
    const win = Engine.getWindow();
    const mB = _getMfrrBounds();
    const aB = _getSlotAfrrBounds(direction);
    const isp = AFRR_PRICES.isp_idx;
    const sp = AFRR_PRICES.spread_x10;
    const kStart = direction === "neg" ? AFRR_PRICES.n_pos_entries : 0;
    const kEnd =
      direction === "neg" ? AFRR_PRICES.n_entries : AFRR_PRICES.n_pos_entries;
    const c = { ppos: 0, pneg: 0, npos: 0, nneg: 0, near_da: 0, na: 0 };
    // Pass 1 — active slots from AFRR_PRICES.
    for (let k = kStart; k < kEnd; k++) {
      const i = isp[k];
      if (i < win.start || i >= win.end) continue;
      if (!_acceptsDay(i)) continue;
      const pmf = D.p_mfrr_raw[i];
      if (isNaN(pmf)) continue;
      const pda = D.p_da[i];
      const ast = pda + sp[k] * 0.1; // recover AST_{POS|NEG} from spread
      // "near DA" gate triggers ONLY when BOTH prices sit in the ±10% band.
      // Otherwise fall through to the strict sign comparison so the chart
      // still surfaces genuine market disagreements.
      const mfrrNear = _isNearDa(pmf, pda);
      const astNear = _isNearDa(ast, pda);
      if (mfrrNear && astNear) {
        c.near_da++;
        continue;
      }
      const ms = _clip(pmf - pda, mB);
      const as = _clip(sp[k] * 0.1, aB);
      if (ms >= 0 && as >= 0) c.ppos++;
      else if (ms >= 0 && as < 0) c.pneg++;
      else if (ms < 0 && as >= 0) c.npos++;
      else c.nneg++;
    }
    // Pass 2 — NA slots, summed per-ISP. Use AFRR_DATA's n_total / n_pos /
    // n_neg counts (per-ISP; total non-null 4-s rows and per-direction
    // active counts). NA count for the requested direction = n_total - n_dir.
    if (D.afrr_n_total && (D.afrr_n_pos || D.afrr_n_neg)) {
      const nTotal = D.afrr_n_total;
      const nActive = direction === "neg" ? D.afrr_n_neg : D.afrr_n_pos;
      for (let i = win.start; i < win.end; i++) {
        if (!_acceptsDay(i)) continue;
        const naCount = (nTotal[i] | 0) - (nActive[i] | 0);
        if (naCount <= 0) continue;
        const pmf = D.p_mfrr_raw[i];
        if (isNaN(pmf)) continue;
        c.na += naCount;
      }
    }
    const total = c.ppos + c.pneg + c.npos + c.nneg + c.near_da + c.na;
    return { counts: c, total };
  }

  // Distribution of mFRR's sign-vs-DA, restricted to 4-s slots where the
  // requested aFRR direction was N/A. Same per-ISP broadcast trick: every
  // NA slot in an ISP inherits the ISP's p_mfrr / p_da. Buckets are three
  // categorical bins (up / near DA / down) using the same ±10% band as
  // the sign-agreement chart, so a slot where mFRR cleared essentially
  // at DA doesn't get arbitrarily lumped into "up" or "down".
  function mfrrSignWhenAfrrNa(direction) {
    if (!isSlotDataLoaded()) return null;
    if (!D.afrr_n_total || !(D.afrr_n_pos || D.afrr_n_neg)) return null;
    const win = Engine.getWindow();
    const mB = _getMfrrBounds();
    const nTotal = D.afrr_n_total;
    const nActive = direction === "neg" ? D.afrr_n_neg : D.afrr_n_pos;
    const c = { up: 0, near: 0, down: 0 };
    for (let i = win.start; i < win.end; i++) {
      if (!_acceptsDay(i)) continue;
      const naCount = (nTotal[i] | 0) - (nActive[i] | 0);
      if (naCount <= 0) continue;
      const pmf = D.p_mfrr_raw[i];
      if (isNaN(pmf)) continue;
      const pda = D.p_da[i];
      if (_isNearDa(pmf, pda)) {
        c.near += naCount;
        continue;
      }
      const ms = _clip(pmf - pda, mB);
      if (ms >= 0) c.up += naCount;
      else c.down += naCount;
    }
    return { counts: c, total: c.up + c.near + c.down };
  }

  // Scatter of (mFRR spread broadcast, aFRR spread) at slot level for
  // the requested direction. Subsampled to ≤ maxPoints by stride so
  // Plotly stays responsive.
  function slotLevelScatter(direction, maxPoints = 8000) {
    if (!isSlotDataLoaded()) return null;
    const win = Engine.getWindow();
    const mB = _getMfrrBounds();
    const aB = _getSlotAfrrBounds(direction);
    const isp = AFRR_PRICES.isp_idx;
    const sp = AFRR_PRICES.spread_x10;
    const kStart = direction === "neg" ? AFRR_PRICES.n_pos_entries : 0;
    const kEnd =
      direction === "neg" ? AFRR_PRICES.n_entries : AFRR_PRICES.n_pos_entries;
    // First pass: count valid entries to compute stride.
    let nValid = 0;
    for (let k = kStart; k < kEnd; k++) {
      const i = isp[k];
      if (i < win.start || i >= win.end) continue;
      if (!_acceptsDay(i)) continue;
      if (isNaN(D.p_mfrr_raw[i])) continue;
      nValid++;
    }
    const stride = nValid > maxPoints ? Math.ceil(nValid / maxPoints) : 1;
    const xs = [];
    const ys = [];
    let validIdx = 0;
    for (let k = kStart; k < kEnd; k++) {
      const i = isp[k];
      if (i < win.start || i >= win.end) continue;
      if (!_acceptsDay(i)) continue;
      const pmf = D.p_mfrr_raw[i];
      if (isNaN(pmf)) continue;
      if (validIdx % stride === 0) {
        xs.push(_clip(pmf - D.p_da[i], mB));
        ys.push(_clip(sp[k] * 0.1, aB));
      }
      validIdx++;
    }
    return { x: xs, y: ys, n: nValid, subsampled: stride > 1 };
  }


  // Combined slot-level stats. Single pass over AFRR_PRICES entries
  // (~8.5M) plus one pass over ISPs in the window (for total-slot count
  // and mFRR direction broadcasts). All proportions are computed as
  // entries-of-some-kind ÷ entries-of-relevant-kind.
  //
  // Caveat to surface in the UI: each ISP contributes its mFRR value 225
  // times (broadcast), so "effective independent observations" of mFRR is
  // ~nIsps, not the slot counts. Confidence intervals tighten faster
  // than they should — don't over-read 3-decimal-place differences.
  function slotLevelStats() {
    if (!isSlotDataLoaded()) return null;
    const win = Engine.getWindow();
    const mB = _getMfrrBounds();
    const aBp = _getSlotAfrrBounds("pos");
    const aBn = _getSlotAfrrBounds("neg");
    const isp = AFRR_PRICES.isp_idx;
    const sp = AFRR_PRICES.spread_x10;
    const nPosEntries = AFRR_PRICES.n_pos_entries;
    const nEntries = AFRR_PRICES.n_entries;

    let nPos = 0,
      nNeg = 0;
    let nCoUpPos = 0,
      nCoDnNeg = 0;
    let nSignAgreePos = 0,
      nSignAgreeNeg = 0;
    // Correlation accumulators across ALL entries (POS + NEG combined) —
    // gives a single number that captures slot-level co-movement.
    // Uses CLIPPED spreads so the result reflects central correlation
    // rather than being dominated by ±10 000 spike entries.
    let nC = 0,
      sumX = 0,
      sumY = 0,
      sumXY = 0,
      sumXX = 0,
      sumYY = 0;
    for (let k = 0; k < nEntries; k++) {
      const i = isp[k];
      if (i < win.start || i >= win.end) continue;
      if (!_acceptsDay(i)) continue;
      const pmf = D.p_mfrr_raw[i];
      if (isNaN(pmf)) continue;
      const isPos = k < nPosEntries;
      const ms = _clip(pmf - D.p_da[i], mB);
      const as = _clip(sp[k] * 0.1, isPos ? aBp : aBn);
      if (isPos) {
        nPos++;
        if (pmf >= 1) nCoUpPos++;
        if ((ms >= 0 && as >= 0) || (ms < 0 && as < 0)) nSignAgreePos++;
      } else {
        nNeg++;
        if (pmf <= -1) nCoDnNeg++;
        if ((ms >= 0 && as >= 0) || (ms < 0 && as < 0)) nSignAgreeNeg++;
      }
      nC++;
      sumX += ms;
      sumY += as;
      sumXY += ms * as;
      sumXX += ms * ms;
      sumYY += as * as;
    }
    // Total 4-s slots in window (Σ n_total over accepted ISPs).
    let totalSlots = 0;
    let nIspsWithAfrr = 0;
    for (let i = win.start; i < win.end; i++) {
      if (!_acceptsDay(i)) continue;
      if (isNaN(D.p_mfrr_raw[i])) continue;
      const nt = D.afrr_n_total ? D.afrr_n_total[i] || 0 : 0;
      if (nt > 0) {
        totalSlots += nt;
        nIspsWithAfrr++;
      }
    }
    let corr = NaN;
    if (nC > 1) {
      const meanX = sumX / nC;
      const meanY = sumY / nC;
      const cov = sumXY / nC - meanX * meanY;
      const varX = sumXX / nC - meanX * meanX;
      const varY = sumYY / nC - meanY * meanY;
      if (varX > 0 && varY > 0) corr = cov / Math.sqrt(varX * varY);
    }
    return {
      mode: "slot",
      nSlots: totalSlots,
      nIspsWithAfrr,
      nPos,
      nNeg,
      nCoUpPos,
      nCoDnNeg,
      nSignAgreePos,
      nSignAgreeNeg,
      corr,
      nCorr: nC,
    };
  }

  return {
    init,
    setDayTypeFilter,
    setWinsorMfrr,
    setWinsorAfrr,
    getCurrentBounds,
    isSlotDataLoaded,
    // ISP-level (retained for fallback / when 4-s data not loaded)
    agreementMatrix,
    signAgreement,
    spreadScatter,
    statsScoreboard,
    // Slot-level (preferred — 4-s native granularity)
    slotLevelMatrix,
    slotLevelSignAgreement,
    slotLevelScatter,
    slotLevelStats,
    mfrrSignWhenAfrrNa,
  };
})();

if (typeof module !== "undefined") module.exports = MfrrAfrrEngine;
