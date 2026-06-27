// bess-engine.js — stateful state-of-charge simulation for the BESS backtester.
//
// WHY THIS IS A SEPARATE ENGINE
// =============================
// The wind-park engine (engine.js) treats every ISP as INDEPENDENT. A battery
// can't: State of Charge (SoC) is CARRIED state — energy discharged now is
// energy you can't discharge later. So this is a sequential simulation with a
// running SoC, a running cost basis, and a running operating mode. One core
// _run(params, detail) feeds both simulate() (full detail) and simulateTotal()
// (fast) so they can never diverge.
//
// WHOLE-MW MARKET QUANTITIES
//   The balancing / day-ahead markets accept integer-MW blocks only, so every
//   OFFER and COMMITMENT is floored to whole MW (power budget is integer MW).
//   aFRR is partial-activation, so the *delivered* energy of an aFRR offer is a
//   fraction (n_*_fav/225) of the whole-MW offer — that part is intentionally
//   fractional. Power budget per ISP = floor(Pmax) MW.
//
// MARKET TIMING (decides which leg is "committed" vs "real-time")
//   Day-ahead   committed a DAY before  → both the sell-at-peaks and the
//                                          buy-low-at-troughs legs are picked
//                                          from a lag-24h (96-ISP) forecast.
//   mFRR        gate 25 min before       → real-time discharge/charge.
//   aFRR        ~real-time, partial.
//   Intraday    gate 30 min before       → real-time charge source, and the
//                                          ONLY price we know to close a diverted
//                                          DA position (see opportunistic).
//   Imbalance   settles AFTER delivery   → NEVER known at decision time, so it is
//                                          never a *chosen* close; it only happens
//                                          passively when a DA delivery falls short.
//
// SIGN CONVENTIONS  (energy MWh = MW × 0.25 h; price €/MWh; + = money in)
//   DA discharge    +E · p_da                           (sell stored energy to DA)
//   mFRR-up         +E · p_mfrr      (p_mfrr ≥ +1)       (discharge into balancing)
//   aFRR-up         +E · avg_p_pos   (avg_p_pos > 0)     (partial dispatch n_pos_fav/225)
//   mFRR-dn charge  −E · p_mfrr      (p_mfrr ≤ −1)       (charge; p<0 ⇒ PAID to absorb ⇒ +)
//   aFRR-dn charge  −E · avg_p_neg   (avg_p_neg < 0)     (partial dispatch n_neg_fav/225)
//   intraday charge −E · vwap                            (charge cost; vwap<0 ⇒ income)
//   DA buy-low      −E · p_da                            (day-ahead committed trough buy)
//   opportunistic   close a diverted DA leg on intraday: −E · vwap (DA revenue kept)
//   DA shortfall    −E_short · (p_imb + θ)               (unmet DA settles at imbalance)
//
// EFFICIENCY  (round-trip η, default 0.90): etaLeg = √η per leg, grid-side.
//   charge   : grid g MWh in  → SoC += g·etaLeg
//   discharge: deliver d MWh  → SoC −= d/etaLeg
//
// COST BASIS + MIN DELTA
//   costBasis = weighted-avg €/MWh STORED; charging g grid at `price` updates it
//   to (cb·soc + price·g)/(soc + g·etaLeg). Break-even DELIVERED sell price
//   effCost = costBasis/etaLeg. A discretionary discharge needs sell ≥
//   effCost + minDelta — a TRUE round-trip margin per delivered MWh.
//
// ADAPTIVE mFRR↔aFRR SPLIT (carried over from the wind park, BOTH directions)
//   UP split (s_up): routes the discharge offer between mFRR-up / aFRR-up.
//   DOWN split (s_dn): routes the charge offer between mFRR-dn / aFRR-dn, and
//   adapts toward whichever pays MORE to absorb (most-negative) over the
//   rebalance window — so charging "looks at the prices and shifts offers". A
//   side is used in an ISP only if its price is favourable AND ≤ the charge
//   ceiling; unusable shares fall back to the other balancing side, then to
//   intraday. z = 0 ⇒ static split at the start.
//
// MUST-FULFIL GUARANTEE
//   Balancing offers are sized within physical [0, cap] + power each ISP, so a
//   committed balancing activation is never short (SoC-safety audit:
//   unfulfilled = 0). Only DAY-AHEAD positions may fall short → imbalance.
//
// RED ZONES — discretionary NEW offers keep SoC in [lowerRed, upperRed]·cap; the
//   buffers cover committed activations / DA commitments.
//
// DAY-TYPE FILTER — SoC evolves over EVERY ISP; totals/decomp/stats accumulate
//   matching-day ISPs only, so total(all) == workday + weekend/holiday exactly.
//
// EXPORTS: init / invalidateCaches / simulate / simulateTotal /
//          monthlyAggregation / topConcentration / daForecastArray

const BessEngine = (() => {
  const LAG = 96; // 24 h = 96 × 15-min ISPs
  const EPS = 1e-9;

  let D = null;
  let _daFc = null; // lag-96 DA forecast
  let _rankHi = null; // per-ISP rank within UTC day, 0 = highest forecast (peaks)
  let _rankLo = null; // per-ISP rank within UTC day, 0 = lowest forecast (troughs)
  let _splitFx = null;
  let _splitDirty = true;

  function init() {
    D = Engine.getData();
    _buildDaForecast();
    _splitFx = null;
    _splitDirty = true;
    return D;
  }

  function invalidateCaches() {
    _splitDirty = true;
  }

  // ---------- lag-24h DA forecast + per-day peak/trough ranks (built once) -
  function _buildDaForecast() {
    const n = D.n;
    const pda = D.p_da;
    _daFc = new Float32Array(n);
    for (let i = 0; i < n; i++) _daFc[i] = i >= LAG ? pda[i - LAG] : NaN;

    const startMs = new Date(D.start_iso).getTime();
    const stepMs = D.step_min * 60000;
    const byDay = new Map();
    for (let i = 0; i < n; i++) {
      const day = Math.floor((startMs + D.offsets[i] * stepMs) / 86400000);
      let arr = byDay.get(day);
      if (!arr) byDay.set(day, (arr = []));
      arr.push(i);
    }
    _rankHi = new Int32Array(n).fill(1 << 30);
    _rankLo = new Int32Array(n).fill(1 << 30);
    for (const arr of byDay.values()) {
      const ranked = arr.filter((i) => !isNaN(_daFc[i]));
      ranked.sort((a, b) => _daFc[b] - _daFc[a]); // desc → peaks first
      for (let r = 0; r < ranked.length; r++) {
        _rankHi[ranked[r]] = r; // 0 = highest
        _rankLo[ranked[r]] = ranked.length - 1 - r; // 0 = lowest
      }
    }
  }

  function daForecastArray() {
    return _daFc;
  }

  // ---------- adaptive split (both directions) ---------------------------
  function _ensureSplitFx() {
    if (_splitFx && !_splitDirty) return _splitFx;
    const n = D.n;
    const pUM = new Float64Array(n + 1);
    const pUA = new Float64Array(n + 1);
    const pDM = new Float64Array(n + 1);
    const pDA = new Float64Array(n + 1);
    const pm = D.p_mfrr,
      ap = D.avg_p_pos,
      an = D.avg_p_neg;
    for (let i = 0; i < n; i++) {
      const m = pm[i],
        a = ap[i],
        b = an[i];
      pUM[i + 1] = pUM[i] + (m >= 1 ? m : 0);
      pDM[i + 1] = pDM[i] + (m <= -1 ? -m : 0);
      pUA[i + 1] = pUA[i] + (a > 0 ? a : 0);
      pDA[i + 1] = pDA[i] + (b < 0 ? -b : 0);
    }
    _splitFx = { pUM, pUA, pDM, pDA };
    _splitDirty = false;
    return _splitFx;
  }

  function _splitBlocks(start, win, step, fxM, fxA, upto) {
    const w = win < 1 ? 1 : win | 0;
    const nB = Math.max(1, Math.floor((Math.max(1, upto) - 1) / w) + 1);
    const blocks = new Float64Array(nB);
    let s = start < 0 ? 0 : start > 1 ? 1 : start;
    blocks[0] = s;
    for (let k = 1; k < nB; k++) {
      if (step > 0) {
        const lo = (k - 1) * w,
          hi = Math.min(k * w, D.n);
        const cnt = hi - lo;
        if (cnt > 0) {
          const am = (fxM[hi] - fxM[lo]) / cnt;
          const aa = (fxA[hi] - fxA[lo]) / cnt;
          if (am > aa) s += step;
          else if (aa > am) s -= step;
          if (s < 0) s = 0;
          else if (s > 1) s = 1;
        }
      }
      blocks[k] = s;
    }
    return { blocks, w };
  }

  function _resolveSplit(p, winEnd) {
    if (!p.splitOn) {
      const w = Math.max(1, winEnd || 1);
      return { up: [1], upW: w, dn: [1], dnW: w };
    }
    const fx = _ensureSplitFx();
    const u = _splitBlocks(p.s_up_start, p.s_up_win, p.s_up_step, fx.pUM, fx.pUA, winEnd);
    const v = _splitBlocks(p.s_dn_start, p.s_dn_win, p.s_dn_step, fx.pDM, fx.pDA, winEnd);
    return { up: u.blocks, upW: u.w, dn: v.blocks, dnW: v.w };
  }

  // ---------- resolve params ---------------------------------------------
  function _resolveParams(params) {
    const en = params.enabled || {};
    const splitOn = en.split !== false;
    const daOn = en.daDischarge !== false;
    const chargeOn = en.charging !== false;
    const ddOn = en.dynamicDischarge !== false;
    const oppOn = en.opportunistic !== false;
    const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
    const num = (v, d) => (v == null || isNaN(+v) ? d : +v);

    const cap = Math.max(0.1, num(params.cap_mwh, 40));
    const eff = Math.min(1, Math.max(0.5, num(params.eff_pct, 90) / 100));
    return {
      cap,
      eMaxMW: Math.max(0, Math.floor(num(params.power_mw, 20))), // integer MW power budget
      etaLeg: Math.sqrt(eff),
      socInit: clamp01(num(params.init_soc_pct, 50) / 100) * cap,
      loRed: clamp01(num(params.lower_red_pct, 20) / 100) * cap,
      hiRed: clamp01(num(params.upper_red_pct, 80) / 100) * cap,
      dwell: Math.max(0, num(params.dwell_isps, 4) | 0),
      minDelta: Math.max(0, num(params.min_delta, 100)),
      theta: Math.max(0, num(params.theta_flat, 30)),
      splitOn,
      s_up_start: splitOn ? clamp01(num(params.s_up_start, 1)) : 1,
      s_dn_start: splitOn ? clamp01(num(params.s_dn_start, 1)) : 1,
      s_up_win: Math.max(1, (params.s_up_win | 0) || 96),
      s_dn_win: Math.max(1, (params.s_dn_win | 0) || 96),
      s_up_step: splitOn ? clamp01(num(params.s_up_step, 0)) : 0,
      s_dn_step: splitOn ? clamp01(num(params.s_dn_step, 0)) : 0,
      daOn,
      da_min_price: num(params.da_min_price, 100),
      da_charge_price: num(params.da_charge_price, 0),
      da_n_periods: daOn ? Math.max(0, params.da_n_periods | 0) : 0,
      da_mw: Math.max(0, Math.floor(num(params.da_mw, 20))),
      chargeOn,
      max_charge_price: chargeOn ? num(params.max_charge_price, 20) : -1e9,
      ddOn,
      dd_lookback: Math.max(1, (params.dd_lookback | 0) || 4),
      dd_threshold: Math.max(0, num(params.dd_threshold, 20)),
      dd_hold: ddOn ? clamp01(num(params.dd_hold, 0.5)) : 0,
      oppOn,
      opp_threshold: oppOn ? Math.max(0, num(params.opp_threshold, 100)) : 1e9,
      dayTypeFilter: params.dayTypeFilter || "all",
    };
  }

  function _dayAccepts(filter, m) {
    if (filter === "workday") return m === 0;
    if (filter === "weekend-holiday") return m !== 0;
    return true;
  }

  // =======================================================================
  //  CORE SEQUENTIAL RUN
  // =======================================================================
  function _run(params, detail) {
    const p = _resolveParams(params);
    const win = Engine.getWindow();
    const winStart = win.start,
      winEnd = win.end;
    const SP = _resolveSplit(p, winEnd);

    const pda = D.p_da,
      pmf = D.p_mfrr,
      pim = D.p_imb,
      apos = D.avg_p_pos,
      aneg = D.avg_p_neg,
      vwap = D.vwap_1h,
      nposf = D.afrr_n_pos_fav,
      nnegf = D.afrr_n_neg_fav,
      mask = D.dayTypeMask;
    const { cap, eMaxMW, etaLeg, loRed, hiRed, dwell, minDelta, theta } = p;
    const ceiling = p.max_charge_price;
    const e4 = 0.25; // hours per ISP
    const filtering = p.dayTypeFilter !== "all";

    let soc = p.socInit;
    let cb = 0;
    let mode = 0;
    let lastFlip = -1 << 20;

    let total = 0;
    let bDA = 0, bUpM = 0, bUpA = 0, bDnM = 0, bDnA = 0, bID = 0, bChg = 0, bImb = 0, bFlat = 0;
    let nDis = 0, nChg = 0, nIdle = 0, nDAcleared = 0, nUpM = 0, nUpA = 0, nDnM = 0, nDnA = 0,
      nWithdraw = 0, nShort = 0, nUnfulfilled = 0, nAt0 = 0, nAtFull = 0;
    let mwhDischarged = 0, mwhCharged = 0, shortMWh = 0;
    let curRun = 0, curRunMode = 0, sumDisRun = 0, cntDisRun = 0, sumChgRun = 0, cntChgRun = 0,
      curIdle = 0, sumIdleGap = 0, cntIdleGap = 0;

    const filteredRev = detail ? [] : null;
    const bids = detail ? detail.bids : null;

    for (let i = winStart; i < winEnd; i++) {
      const k = i - winStart;
      const accept = !filtering || _dayAccepts(p.dayTypeFilter, mask[i]);
      const sUp = p.splitOn ? SP.up[(i / SP.upW) | 0] : 1;
      const sDn = p.splitOn ? SP.dn[(i / SP.dnW) | 0] : 1;
      const P_da = pda[i], P_mfrr = pmf[i], P_imb = pim[i], Apos = apos[i], Aneg = aneg[i], Vwap = vwap[i];

      let budgetMW = eMaxMW;
      const effCost = soc > EPS ? cb / etaLeg : 0;

      let cDA = 0, cUpM = 0, cUpA = 0, cDnM = 0, cDnA = 0, cID = 0, cChg = 0, cImb = 0, cFlat = 0;
      let daSellMW = 0, upMmw = 0, upAmw = 0, dnMmw = 0, dnAmw = 0, chgOtherMW = 0;
      // aFRR OFFERED MW (whole-MW); dispatched = offered × n_*_fav/225 (the
      // favourable fraction of the 15-min ISP), exactly as the wind park.
      let upAoffMW = 0, dnAoffMW = 0;
      let shortE = 0, dir = 0, daChargeCommitted = false;

      const mfrrUp = P_mfrr >= 1;
      const afrrUp = Apos > 0;
      const bestUp = Math.max(mfrrUp ? P_mfrr : -Infinity, afrrUp ? Apos : -Infinity);

      // 1. DAY-AHEAD discharge (committed peak)
      const daDisTarget =
        p.daOn && _rankHi[i] < p.da_n_periods && _daFc[i] >= p.da_min_price && P_da >= p.da_min_price;
      // 1b. DAY-AHEAD buy-low (committed trough) — only when NOT a sell peak
      const daBuyTarget =
        !daDisTarget && p.daOn && _rankLo[i] < p.da_n_periods && _daFc[i] <= p.da_charge_price && P_da <= p.da_charge_price;

      if (daDisTarget) {
        dir = 1;
        const commitMW = Math.min(p.da_mw, eMaxMW);
        const maxDelivMW = Math.floor(Math.min(budgetMW, (soc * etaLeg) / e4));
        const delivMW = Math.min(commitMW, maxDelivMW);
        if (delivMW > 0) {
          soc -= (delivMW * e4) / etaLeg;
          budgetMW -= delivMW;
          cDA += delivMW * e4 * P_da;
          daSellMW = delivMW;
        }
        const shortMW = commitMW - delivMW;
        if (shortMW > 0 && !isNaN(P_imb)) {
          shortE = shortMW * e4;
          cImb += shortE * P_imb;
          cFlat += shortE * theta;
        }
      } else if (daBuyTarget) {
        dir = -1;
        daChargeCommitted = true;
        const commitMW = Math.min(p.da_mw, eMaxMW);
        const maxChgMW = Math.floor(Math.min(budgetMW, (cap - soc) / (e4 * etaLeg)));
        const chgMW = Math.min(commitMW, maxChgMW);
        if (chgMW > 0) {
          const stored = chgMW * e4 * etaLeg;
          cb = (cb * soc + P_da * chgMW * e4) / (soc + stored);
          soc += stored;
          budgetMW -= chgMW;
          cChg -= chgMW * e4 * P_da;
          chgOtherMW += chgMW;
        }
      }

      // 2. Discretionary charge sources (real-time only; NO day-ahead here)
      const mfrrDn = P_mfrr <= -1;
      const afrrDn = Aneg < 0;
      const mfrrChgUsable = mfrrDn && P_mfrr <= ceiling;
      const afrrChgUsable = afrrDn && Aneg <= ceiling;
      const idChgUsable = !isNaN(Vwap) && Vwap <= ceiling;
      let bestChg = Infinity;
      if (mfrrChgUsable && P_mfrr < bestChg) bestChg = P_mfrr;
      if (afrrChgUsable && Aneg < bestChg) bestChg = Aneg;
      if (idChgUsable && Vwap < bestChg) bestChg = Vwap;
      const anyChgUsable = mfrrChgUsable || afrrChgUsable || idChgUsable;

      const dischargeOK = soc > loRed + EPS && budgetMW >= 1 && bestUp > -Infinity && bestUp >= effCost + minDelta;
      const chargeOK = soc < hiRed - EPS && budgetMW >= 1 && anyChgUsable;
      const canFlipTo = (want) => mode === 0 || mode === want || i - lastFlip >= dwell;

      if (daChargeCommitted) {
        // committed DA charge — no extra discretionary action this ISP
      } else if (dir === 1) {
        // DA discharge already set; extra discharge handled below
      } else if (dischargeOK && chargeOK) {
        if (mode === -1 && i - lastFlip < dwell) dir = -1;
        else if (mode === 1 && i - lastFlip < dwell) dir = 1;
        else dir = bestUp - effCost >= ceiling - bestChg ? 1 : -1;
      } else if (dischargeOK && canFlipTo(1)) {
        dir = 1;
      } else if (chargeOK && canFlipTo(-1)) {
        dir = -1;
      }

      // 3a. DISCHARGE leg. NB: not gated on budget — opportunistic redirects
      // already-delivered DA energy (no extra battery power); the extra-balancing
      // block below is self-gated by availMW (= 0 when budget is exhausted).
      if (dir === 1 && !daChargeCommitted) {
        // 4. opportunistic override — divert the DA-sold MW into a balancing
        //    spike, covering the DA obligation by buying INTRADAY (the only
        //    close price known at decision time). DA revenue is KEPT.
        // Divert ONLY into mFRR-up: it is binary / full-dispatch (a deficit
        // spike activates the whole bid), so the already-delivered DA energy
        // maps cleanly to it. aFRR's partial activation would leave the drained
        // battery only fractionally sold, so we never divert into aFRR here.
        if (p.oppOn && daSellMW > 0 && mfrrUp && !isNaN(Vwap) && P_mfrr - Vwap >= p.opp_threshold) {
          const e = daSellMW * e4;
          cID -= e * Vwap; // buy intraday to cover the DA delivery
          cUpM += e * P_mfrr;
          upMmw += daSellMW;
          if (bids) bids.push({ i, prod: "mfrr", dir: 1, price: P_mfrr, mw: daSellMW, status: "cleared" });
          daSellMW = 0; // battery energy now goes to balancing, not DA
        }

        const availMW = Math.floor(Math.min(budgetMW, (Math.max(0, soc - loRed) * etaLeg) / e4));
        if (availMW > 0 && bestUp >= effCost + minDelta) {
          let hold = 0;
          if (p.ddOn && p.dd_hold > 0 && i - p.dd_lookback >= 0) {
            const past = pmf[i - p.dd_lookback];
            if (!isNaN(past) && P_mfrr - past >= p.dd_threshold) hold = p.dd_hold;
          }
          const offerMW = Math.floor(availMW * (1 - hold));
          const heldMW = availMW - offerMW;
          if (heldMW > 0 && bids) {
            bids.push({ i, prod: "mfrr", dir: 1, price: P_mfrr, mw: heldMW, status: "withdrawn" });
            if (accept) nWithdraw++;
          }
          if (offerMW > 0) {
            let toMfrr = sUp;
            if (p.ddOn && afrrUp && mfrrUp && Apos > P_mfrr) toMfrr = 0; // switch to aFRR
            const routedMfrr = Math.round(toMfrr * offerMW);
            const routedAfrr = offerMW - routedMfrr;
            budgetMW -= offerMW;
            if (routedMfrr > 0) {
              if (mfrrUp) {
                soc -= (routedMfrr * e4) / etaLeg;
                cUpM += routedMfrr * e4 * P_mfrr;
                upMmw += routedMfrr;
                if (bids) bids.push({ i, prod: "mfrr", dir: 1, price: P_mfrr, mw: routedMfrr, status: "cleared" });
              } else if (bids) {
                bids.push({ i, prod: "mfrr", dir: 1, price: P_mfrr, mw: routedMfrr, status: "resting" });
              }
            }
            if (routedAfrr > 0) {
              upAoffMW += routedAfrr; // offered to aFRR-up (whether or not it clears)
              if (afrrUp) {
                const disp = routedAfrr * (nposf[i] / 225);
                soc -= (disp * e4) / etaLeg;
                cUpA += routedAfrr * e4 * Apos;
                upAmw += disp;
                if (bids) bids.push({ i, prod: "afrr", dir: 1, price: Apos, mw: routedAfrr, status: "cleared" });
              } else if (bids) {
                bids.push({ i, prod: "afrr", dir: 1, price: Apos, mw: routedAfrr, status: "resting" });
              }
            }
          }
        }
      }

      // 3b. CHARGE leg (real-time, discretionary) — route between mFRR-dn /
      //     aFRR-dn by the DOWN split, gated per-ISP on price, intraday fallback.
      if (dir === -1 && !daChargeCommitted && budgetMW >= 1 && chargeOK) {
        const headMW = Math.floor(Math.min(budgetMW, (hiRed - soc) / (e4 * etaLeg)));
        if (headMW > 0) {
          let mShare = Math.round(sDn * headMW);
          let aShare = headMW - mShare;
          // route unusable shares to the other usable balancing side
          let mMW = mfrrChgUsable ? mShare : 0;
          let aMW = afrrChgUsable ? aShare : 0;
          if (!mfrrChgUsable && afrrChgUsable) aMW += mShare;
          else if (mfrrChgUsable && !afrrChgUsable) mMW += aShare;
          let idMW = headMW - mMW - aMW; // whatever neither balancing side took
          if (!idChgUsable) idMW = 0;
          // mFRR-dn (binary full absorb)
          if (mMW > 0) {
            const stored = mMW * e4 * etaLeg;
            cb = (cb * soc + P_mfrr * mMW * e4) / (soc + stored);
            soc += stored;
            cDnM -= mMW * e4 * P_mfrr;
            dnMmw += mMW;
            if (bids) bids.push({ i, prod: "mfrr", dir: -1, price: P_mfrr, mw: mMW, status: "cleared" });
          }
          // aFRR-dn (partial absorb)
          if (aMW > 0) {
            dnAoffMW += aMW; // offered to aFRR-dn
            const absorbed = aMW * (nnegf[i] / 225);
            const stored = absorbed * e4 * etaLeg;
            if (soc + stored > 0) cb = (cb * soc + Aneg * aMW * e4) / (soc + stored);
            soc += stored;
            cDnA -= aMW * e4 * Aneg;
            dnAmw += absorbed;
            if (bids) bids.push({ i, prod: "afrr", dir: -1, price: Aneg, mw: aMW, status: "cleared" });
          }
          // intraday fallback (full absorb)
          if (idMW > 0) {
            const stored = idMW * e4 * etaLeg;
            cb = (cb * soc + Vwap * idMW * e4) / (soc + stored);
            soc += stored;
            cChg -= idMW * e4 * Vwap;
            chgOtherMW += idMW;
          }
          budgetMW -= mMW + aMW + idMW;
        }
      }

      if (soc < 0) soc = 0;
      else if (soc > cap) soc = cap;

      const rev = cDA + cUpM + cUpA + cDnM + cDnA + cID + cChg - cImb - cFlat;
      const netDis = daSellMW + upMmw + upAmw;
      const netChg = dnMmw + dnAmw + chgOtherMW;
      const ispDir = netDis > 1e-6 ? 1 : netChg > 1e-6 ? -1 : 0;
      if (ispDir !== 0 && ispDir !== mode) {
        lastFlip = i;
        mode = ispDir;
      }

      if (detail) {
        const dd = detail;
        dd.soc[k] = soc;
        dd.daSell[k] = daSellMW;
        dd.upM[k] = upMmw;
        dd.upA[k] = upAmw;
        dd.upAoff[k] = upAoffMW;
        dd.dnM[k] = dnMmw;
        dd.dnA[k] = dnAmw;
        dd.dnAoff[k] = dnAoffMW;
        dd.chgOther[k] = chgOtherMW;
        dd.rev[k] = rev;
        dd.revDA[k] = cDA;
        dd.revUp[k] = cUpM + cUpA;
        dd.revDn[k] = cDnM + cDnA;
        dd.revID[k] = cID;
        dd.revChg[k] = cChg;
        dd.costImb[k] = cImb;
        dd.costFlat[k] = cFlat;
        dd.short[k] = shortE;
        dd.effCost[k] = effCost;
        dd.dayType[k] = mask[i];
        dd.dir[k] = ispDir;
      }

      if (!accept) continue;
      total += rev;
      if (!detail) continue;

      filteredRev.push(rev);
      bDA += cDA; bUpM += cUpM; bUpA += cUpA; bDnM += cDnM; bDnA += cDnA;
      bID += cID; bChg += cChg; bImb += cImb; bFlat += cFlat;
      mwhDischarged += netDis * e4;
      mwhCharged += netChg * e4;
      if (daSellMW > 1e-6) nDAcleared++;
      if (upMmw > 1e-6) nUpM++;
      if (upAmw > 1e-6) nUpA++;
      if (dnMmw > 1e-6) nDnM++;
      if (dnAmw > 1e-6) nDnA++;
      if (shortE > 1e-6) {
        nShort++;
        shortMWh += shortE;
      }
      if (soc <= 1e-6) nAt0++;
      if (soc >= cap - 1e-6) nAtFull++;
      if (ispDir === 1) nDis++;
      else if (ispDir === -1) nChg++;
      else nIdle++;

      if (ispDir === 0) {
        curIdle++;
        if (curRunMode !== 0 && curRun > 0) {
          if (curRunMode === 1) { sumDisRun += curRun; cntDisRun++; }
          else { sumChgRun += curRun; cntChgRun++; }
          curRun = 0;
          curRunMode = 0;
        }
      } else {
        if (curIdle > 0) { sumIdleGap += curIdle; cntIdleGap++; curIdle = 0; }
        if (ispDir === curRunMode) curRun++;
        else {
          if (curRunMode === 1 && curRun > 0) { sumDisRun += curRun; cntDisRun++; }
          else if (curRunMode === -1 && curRun > 0) { sumChgRun += curRun; cntChgRun++; }
          curRunMode = ispDir;
          curRun = 1;
        }
      }
    }
    if (curRunMode === 1 && curRun > 0) { sumDisRun += curRun; cntDisRun++; }
    else if (curRunMode === -1 && curRun > 0) { sumChgRun += curRun; cntChgRun++; }

    if (!detail) return total;

    const usable = Math.max(1e-9, hiRed - loRed);
    detail.totalRevenue = total;
    detail.windowStart = winStart;
    detail.windowEnd = winEnd;
    detail.filteredRevenue = Float64Array.from(filteredRev);
    detail.breakdown = { DA: bDA, mFRR_up: bUpM, aFRR_up: bUpA, mFRR_dn: bDnM, aFRR_dn: bDnA, intraday: bID, charge: bChg, imb: bImb, flat: bFlat };
    detail.counts = { discharge: nDis, charge: nChg, idle: nIdle, daCleared: nDAcleared, upMfrr: nUpM, upAfrr: nUpA, dnMfrr: nDnM, dnAfrr: nDnA, withdrawn: nWithdraw, short: nShort, unfulfilled: nUnfulfilled, at0: nAt0, atFull: nAtFull };
    detail.stats = { mwhDischarged, mwhCharged, shortMWh, cycles: mwhDischarged / usable, avgDisRun: cntDisRun ? sumDisRun / cntDisRun : 0, avgChgRun: cntChgRun ? sumChgRun / cntChgRun : 0, avgIdleGap: cntIdleGap ? sumIdleGap / cntIdleGap : 0 };
    detail.finalSoc = soc;
    return detail;
  }

  // ---------- public entry points ----------------------------------------
  function simulate(params) {
    const win = Engine.getWindow();
    const wLen = Math.max(0, win.end - win.start);
    const f32 = () => new Float32Array(wLen);
    const detail = {
      soc: f32(), daSell: f32(), upM: f32(), upA: f32(), upAoff: f32(), dnM: f32(), dnA: f32(), dnAoff: f32(), chgOther: f32(),
      rev: f32(), revDA: f32(), revUp: f32(), revDn: f32(), revID: f32(), revChg: f32(),
      costImb: f32(), costFlat: f32(), short: f32(), effCost: f32(),
      dayType: new Uint8Array(wLen), dir: new Int8Array(wLen), bids: [],
    };
    return _run(params, detail);
  }

  function simulateTotal(params) {
    return _run(params, null);
  }

  function monthlyAggregation(params) {
    const sim = simulate(params);
    const start = new Date(D.start_iso);
    const winStart = sim.windowStart;
    const p = _resolveParams(params);
    const filtering = p.dayTypeFilter !== "all";
    const mask = D.dayTypeMask;
    const buckets = new Map();
    for (let k = 0; k < sim.rev.length; k++) {
      const i = winStart + k;
      if (filtering && !_dayAccepts(p.dayTypeFilter, mask[i])) continue;
      const ts = new Date(start.getTime() + D.offsets[i] * D.step_min * 60000);
      const key = `${ts.getUTCFullYear()}-${String(ts.getUTCMonth() + 1).padStart(2, "0")}`;
      let b = buckets.get(key);
      if (!b) {
        b = { month: key, DA: 0, up: 0, dn: 0, intraday: 0, charge: 0, imb: 0, flat: 0, total: 0 };
        buckets.set(key, b);
      }
      b.DA += sim.revDA[k];
      b.up += sim.revUp[k];
      b.dn += sim.revDn[k];
      b.intraday += sim.revID[k];
      b.charge += sim.revChg[k];
      b.imb += sim.costImb[k];
      b.flat += sim.costFlat[k];
      b.total += sim.rev[k];
    }
    return [...buckets.keys()].sort().map((k) => buckets.get(k));
  }

  function topConcentration(perISPRev, fraction) {
    const sorted = Float64Array.from(perISPRev);
    sorted.sort();
    let total = 0;
    for (let i = 0; i < perISPRev.length; i++) total += perISPRev[i];
    const topN = Math.max(1, Math.floor(perISPRev.length * fraction));
    let topSum = 0;
    for (let i = sorted.length - 1; i >= sorted.length - topN; i--) topSum += sorted[i];
    return { topN, topSum, totalSum: total, share: total !== 0 ? topSum / total : 0 };
  }

  return { init, invalidateCaches, simulate, simulateTotal, monthlyAggregation, topConcentration, daForecastArray };
})();

if (typeof module !== "undefined") module.exports = BessEngine;
