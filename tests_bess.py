"""
tests_bess.py — audit / regression suite for the BESS backtester (bess-engine.js).

A SEPARATE suite from tests.py. Faithful PYTHON MIRROR of bess-engine.js's
stateful state-of-charge loop, exercised three ways:

  A. FORECAST     — lag-24h (96-ISP) DA forecast + per-day peak/trough ranks.
  B. CORE MECHANICS (synthetic, hand-computed) — whole-MW offers, round-trip
     efficiency, cost-basis + min-delta gate, power cap, SoC bounds, red zones,
     red-zone time audit (pinned counters), dwell, must-fulfil, price-aware
     charging, day-ahead buy-low, opportunistic divert (keeps DA revenue, closes
     on intraday only — no imbalance clairvoyance), reactive ask re-pricing
     (rests on a stall, clears the FULL volume on continuation; per-leg ask gate).
  C. REAL DATA    — rev == Σ components, SoC ∈ [0,cap], whole-MW market volumes,
     day-type partition, strategy-off neutrality, frozen default revenue.

DYNAMIC DISCHARGE PRICING (reactive ask): every discretionary balancing offer
carries an ask = effCost + minDelta; a leg clears only when ITS price reaches
the ask. On a SETTLED run-up (p_mfrr[i-3] - p_mfrr[i-3-lookback] >=
dd_threshold; LAG_SETTLED = 3) the whole offer is re-priced to
p_mfrr[i-3] + dd_markup — full volume stays offered, nothing is withheld
(the old dd_hold withholding is gone).

RED-ZONE TIME AUDIT: counts.lowRed / counts.upRed = ISPs whose end-of-ISP SoC is
pinned at/inside a red zone (soc < loRed + 0.25/etaLeg, soc > hiRed - 0.25*etaLeg
— within one whole-MW step of the boundary, or beyond it).

JS↔Python parity: the mirror produces a frozen number; the browser JS is checked
to match it (see FROZEN_* / README). Mirror is float64; JS reads float32 winsor
arrays → cross-check carries a small tolerance.

Run:  python tests_bess.py
"""

from __future__ import annotations

import io
import json
import math
import os
import sys
from typing import Callable

import numpy as np

if sys.stdout.encoding != "utf-8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

BASE = os.path.dirname(os.path.abspath(__file__))
DATA_JS = os.path.join(BASE, "data.js")
AFRR_15MIN_JS = os.path.join(BASE, "data-afrr-15min.js")

LAG = 96
# Newest SETTLED ISP at decision time is i−3: the intraday gate (t0−30) is the
# end of ISP i−3; the balancing gate (t0−25) falls inside ISP i−2. Decisions
# read settled prices only; realised same-ISP prices decide only clearing.
LAG_SETTLED = 3
EPS = 1e-9
E4 = 0.25  # hours per ISP

# Cross-checked against the browser JS (BessEngine) at the default config over
# the full dataset. Re-freeze after any engine change (the test prints the value).
# Current freeze: FAIR INFORMATION TIMING (all decisions on settled ≤ i−3
# prices + the pre-gate intraday quote; realised prices only clear bids) +
# reactive-ask dynamic discharge (lb=1/thr=20/markup=75; the old hard
# mFRR→aFRR switch removed) + per-leg ask gate + red-zone time audit +
# DA FINANCIAL SETTLEMENT (committed DA volume paid in full; the physical
# gap — short sell or unabsorbed buy — settles at p_imb with θ on the gap;
# was 2,109,994.41 under the pre-2026-07 delivered-only booking).
FROZEN_DEFAULT_REVENUE_EUR = 3409313.15


# =============================================================================
#  Test runner
# =============================================================================
class TestRunner:
    def __init__(self):
        self.tests: list[tuple[str, Callable[[], None]]] = []
        self.passed = 0
        self.failed: list[tuple[str, str]] = []

    def add(self, name, fn):
        self.tests.append((name, fn))

    def run(self):
        print(f"\nRunning {len(self.tests)} BESS tests…\n")
        for name, fn in self.tests:
            try:
                fn()
                print(f"  PASS  {name}")
                self.passed += 1
            except AssertionError as e:
                print(f"  FAIL  {name}")
                print(f"        {e}")
                self.failed.append((name, str(e)))
            except Exception as e:
                print(f"  ERROR {name}: {type(e).__name__}: {e}")
                self.failed.append((name, f"{type(e).__name__}: {e}"))
        print()
        print(f"{self.passed}/{len(self.tests)} passed")
        if self.failed:
            print(f"{len(self.failed)} failed:")
            for name, err in self.failed:
                print(f"  - {name}")
            return 1
        return 0


# =============================================================================
#  Loaders
# =============================================================================
def _load_js_object(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()
    return json.loads(text[text.index("{"): text.rindex("}") + 1])


def load_data():
    d = _load_js_object(DATA_JS)
    n = d["n"]
    nn = lambda a: np.asarray([np.nan if v is None else v for v in a], dtype=np.float64)
    out = {
        "n": n, "start_iso": d["start_iso"], "step_min": d["step_min"],
        "offsets": np.asarray(d["offsets"], dtype=np.int64),
        "p_da": np.asarray(d["p_da"], dtype=np.float64),
        "p_mfrr": nn(d["p_mfrr"]), "p_imb": nn(d["p_imb"]),
        "vwap_1h": nn(d.get("vwap_1h", [None] * n)),
    }
    try:
        a = _load_js_object(AFRR_15MIN_JS)
        if a.get("n") == n:
            out["avg_p_pos"] = np.asarray(a["avg_p_pos"], dtype=np.float64)
            out["avg_p_neg"] = np.asarray(a["avg_p_neg"], dtype=np.float64)
            out["n_pos_fav"] = np.asarray(a["n_pos_fav"], dtype=np.float64)
            out["n_neg_fav"] = np.asarray(a["n_neg_fav"], dtype=np.float64)
    except FileNotFoundError:
        pass
    for key in ("avg_p_pos", "avg_p_neg", "n_pos_fav", "n_neg_fav"):
        out.setdefault(key, np.zeros(n))
    return out


# =============================================================================
#  Winsorisation (mirror of engine.js)
# =============================================================================
def _percentile_value(s, p):
    N = len(s)
    if N == 0:
        return 0.0
    idx = (p / 100) * (N - 1)
    lo, hi = math.floor(idx), math.ceil(idx)
    return s[lo] if lo == hi else s[lo] + (s[hi] - s[lo]) * (idx - lo)


def winsorize(arr, p_lo, p_hi):
    buf = sorted(v for v in arr if not math.isnan(v))
    out = list(arr)
    if not buf:
        return out
    lo, hi = _percentile_value(buf, p_lo), _percentile_value(buf, p_hi)
    for i in range(len(arr)):
        v = arr[i]
        if not math.isnan(v):
            out[i] = lo if v < lo else (hi if v > hi else v)
    return out


def _iso_ms(iso):
    import datetime as _dt
    return int(_dt.datetime.strptime(iso, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=_dt.timezone.utc).timestamp() * 1000)


def jround(x):
    """Mirror engine Math.round: half UP (toward +∞). Python's builtin
    round() is half-to-even and diverges at exact half-MW split products
    (0.5 × 5 MW = 2.5 → engine 3, banker's 2)."""
    return math.floor(x + 0.5)


def day_type_mask(data):
    """Mirror engine.js _computeDayTypeMask: 0 = workday, 1 = weekend,
    2 = LV/EE/LT public holiday (weekend wins — the engine checks
    day-of-week first). Degrades to weekend-only when the `holidays`
    package is missing, exactly like engine.js does when the
    date-holidays CDN fails. Same approach as tests.py's _day_type_mask."""
    import datetime as _dt
    n = data["n"]
    start_ms = _iso_ms(data["start_iso"])
    step_ms = data["step_min"] * 60000
    hol = set()
    try:
        import holidays as _holidays
        ms0 = start_ms + int(data["offsets"][0]) * step_ms
        ms1 = start_ms + int(data["offsets"][n - 1]) * step_ms
        years = list(range(
            _dt.datetime.fromtimestamp(ms0 / 1000, _dt.timezone.utc).year,
            _dt.datetime.fromtimestamp(ms1 / 1000, _dt.timezone.utc).year + 1,
        ))
        for cc in ("LV", "EE", "LT"):
            hol.update(_holidays.country_holidays(cc, years=years).keys())
    except Exception:
        hol = set()  # weekend-only fallback
    mask = np.zeros(n, dtype=np.uint8)
    for i in range(n):
        ms = start_ms + int(data["offsets"][i]) * step_ms
        dow = ((ms // 86400000) + 4) % 7  # getUTCDay
        if dow in (0, 6):
            mask[i] = 1
        elif _dt.datetime.fromtimestamp(ms / 1000, _dt.timezone.utc).date() in hol:
            mask[i] = 2
    return mask


# =============================================================================
#  lag-24h forecast + peak/trough ranks
# =============================================================================
def build_da_forecast(data):
    n = data["n"]
    pda = data["p_da"]
    fc = np.full(n, np.nan)
    for i in range(n):
        if i >= LAG:
            fc[i] = pda[i - LAG]
    start_ms = _iso_ms(data["start_iso"])
    step_ms = data["step_min"] * 60000
    by_day = {}
    for i in range(n):
        by_day.setdefault((start_ms + int(data["offsets"][i]) * step_ms) // 86400000, []).append(i)
    rank_hi = np.full(n, 1 << 30, dtype=np.int64)
    rank_lo = np.full(n, 1 << 30, dtype=np.int64)
    for arr in by_day.values():
        ranked = [i for i in arr if not math.isnan(fc[i])]
        ranked.sort(key=lambda i: -fc[i])
        m = len(ranked)
        for r, i in enumerate(ranked):
            rank_hi[i] = r
            rank_lo[i] = m - 1 - r
    return fc, rank_hi, rank_lo


# =============================================================================
#  Param resolution + split
# =============================================================================
def resolve_params(params):
    en = params.get("enabled", {})
    on = lambda k: en.get(k, True) is not False
    c01 = lambda v: 0.0 if v < 0 else (1.0 if v > 1 else v)

    def num(k, d):
        v = params.get(k, None)
        try:
            v = float(v)
        except (TypeError, ValueError):
            return d
        return d if math.isnan(v) else v

    split_on = on("split")
    da_on = on("daDischarge")
    charge_on = on("charging")
    dd_on = on("dynamicDischarge")
    opp_on = on("opportunistic")
    cap = max(0.1, num("cap_mwh", 40))
    eff = min(1.0, max(0.5, num("eff_pct", 90) / 100))
    return dict(
        cap=cap, eMaxMW=max(0, int(math.floor(num("power_mw", 20)))), etaLeg=math.sqrt(eff),
        socInit=c01(num("init_soc_pct", 50) / 100) * cap,
        loRed=c01(num("lower_red_pct", 20) / 100) * cap,
        hiRed=c01(num("upper_red_pct", 80) / 100) * cap,
        dwell=max(0, int(num("dwell_isps", 4))), minDelta=max(0.0, num("min_delta", 100)),
        theta=max(0.0, num("theta_flat", 30)), splitOn=split_on,
        s_up_start=c01(num("s_up_start", 1)) if split_on else 1.0,
        s_dn_start=c01(num("s_dn_start", 1)) if split_on else 1.0,
        s_up_win=max(1, int(params.get("s_up_win", 96) or 96)),
        s_dn_win=max(1, int(params.get("s_dn_win", 96) or 96)),
        s_up_wait=max(1, int(params.get("s_up_wait", 1) or 1)),
        s_dn_wait=max(1, int(params.get("s_dn_wait", 1) or 1)),
        s_up_step=(c01(num("s_up_step", 0)) if split_on else 0.0),
        s_dn_step=(c01(num("s_dn_step", 0)) if split_on else 0.0),
        daOn=da_on, da_min_price=num("da_min_price", 100), da_charge_price=num("da_charge_price", 0),
        da_n_periods=max(0, int(params.get("da_n_periods", 0) or 0)) if da_on else 0,
        da_mw=max(0, int(math.floor(num("da_mw", 20)))),
        chargeOn=charge_on, max_charge_price=num("max_charge_price", 20) if charge_on else -1e9,
        ddOn=dd_on, dd_lookback=max(1, int(params.get("dd_lookback", 1) or 1)),
        dd_threshold=max(0.0, num("dd_threshold", 20)), dd_markup=(max(0.0, num("dd_markup", 75)) if dd_on else 0.0),
        oppOn=opp_on, opp_threshold=(max(0.0, num("opp_threshold", 100)) if opp_on else 1e9),
        dayTypeFilter=params.get("dayTypeFilter", "all"),
    )


def _split_blocks(start, win, step, wait, fxM, fxA, upto, n):
    lb = 1 if win < 1 else int(win)    # lookback length
    wt = 1 if wait < 1 else int(wait)  # cadence (segment length)
    nB = max(1, (max(1, upto) - 1) // wt + 1)
    blocks = np.zeros(nB)
    s = 0.0 if start < 0 else (1.0 if start > 1 else start)
    blocks[0] = s
    for k in range(1, nB):
        if step > 0:
            # window ends at the last SETTLED ISP before the block boundary
            boundary = max(0, k * wt - LAG_SETTLED + 1)
            lo, hi = max(0, boundary - lb), min(boundary, n)
            cnt = hi - lo
            if cnt > 0:
                am = (fxM[hi] - fxM[lo]) / cnt
                aa = (fxA[hi] - fxA[lo]) / cnt
                if am > aa:
                    s += step
                elif aa > am:
                    s -= step
                s = 0.0 if s < 0 else (1.0 if s > 1 else s)
        blocks[k] = s
    return blocks, wt


def resolve_split(p, we, A):
    n = A["n"]
    if not p["splitOn"]:
        w = max(1, we or 1)
        return [1.0], w, [1.0], w
    pm, ap, an = A["p_mfrr"], A["avg_p_pos"], A["avg_p_neg"]
    pUM = np.zeros(n + 1); pUA = np.zeros(n + 1); pDM = np.zeros(n + 1); pDA = np.zeros(n + 1)
    for i in range(n):
        m, a, b = pm[i], ap[i], an[i]
        pUM[i + 1] = pUM[i] + (m if m >= 1 else 0)
        pDM[i + 1] = pDM[i] + (-m if m <= -1 else 0)
        pUA[i + 1] = pUA[i] + (a if a > 0 else 0)
        pDA[i + 1] = pDA[i] + (-b if b < 0 else 0)
    up, upW = _split_blocks(p["s_up_start"], p["s_up_win"], p["s_up_step"], p["s_up_wait"], pUM, pUA, we, n)
    dn, dnW = _split_blocks(p["s_dn_start"], p["s_dn_win"], p["s_dn_step"], p["s_dn_wait"], pDM, pDA, we, n)
    return up, upW, dn, dnW


def day_accepts(f, m):
    return (m == 0) if f == "workday" else ((m != 0) if f == "weekend-holiday" else True)


# =============================================================================
#  Python mirror of bess-engine.js _run()
# =============================================================================
def bess_run(A, params):
    p = resolve_params(params)
    ws, we, n = A["win_start"], A["win_end"], A["n"]
    up, upW, dn, dnW = resolve_split(p, we, A)
    pda, pmf, pim = A["p_da"], A["p_mfrr"], A["p_imb"]
    apos, aneg, vwap = A["avg_p_pos"], A["avg_p_neg"], A["vwap_1h"]
    nposf, nnegf, mask = A["n_pos_fav"], A["n_neg_fav"], A["mask"]
    fc, rhi, rlo = A["fc"], A["rank_hi"], A["rank_lo"]
    cap, eMaxMW, eta = p["cap"], p["eMaxMW"], p["etaLeg"]
    loRed, hiRed, dwell, minDelta, theta = p["loRed"], p["hiRed"], p["dwell"], p["minDelta"], p["theta"]
    ceiling = p["max_charge_price"]
    filtering = p["dayTypeFilter"] != "all"

    soc, cb, actMode, lastActISP = p["socInit"], 0.0, 0, -(1 << 20)
    total = 0.0
    b = dict(DA=0.0, mFRR_up=0.0, aFRR_up=0.0, mFRR_dn=0.0, aFRR_dn=0.0, intraday=0.0, charge=0.0, imb=0.0, flat=0.0)
    c = dict(discharge=0, charge=0, idle=0, daCleared=0, upMfrr=0, upAfrr=0, dnMfrr=0, dnAfrr=0,
             repriced=0, repClear=0, divMiss=0, short=0, unfulfilled=0, lowRed=0, upRed=0)
    # red-zone time audit: pinned at/inside a zone = within one whole-MW step
    # of its boundary (or beyond it — committed DA legs may dig inside)
    pinLo = loRed + E4 / eta
    pinHi = hiRed - E4 * eta
    mwhDis = mwhChg = shortMWh = 0.0
    socs, revs, fr = [], [], []
    daSells, upMs, dnMs, chgOs = [], [], [], []
    bids = []
    max_viol = 0.0

    for i in range(ws, we):
        accept = (not filtering) or day_accepts(p["dayTypeFilter"], mask[i])
        sUp = up[i // upW] if p["splitOn"] else 1.0
        sDn = dn[i // dnW] if p["splitOn"] else 1.0
        P_da, P_mfrr, P_imb, Apos, Aneg, Vwap = pda[i], pmf[i], pim[i], apos[i], aneg[i], vwap[i]
        budgetMW = eMaxMW
        effCost = (cb / eta) if soc > EPS else 0.0
        cDA = cUpM = cUpA = cDnM = cDnA = cID = cChg = cImb = cFlat = 0.0
        daSellMW = upMmw = upAmw = dnMmw = dnAmw = chgOtherMW = 0.0
        shortE = 0.0
        dir_ = 0
        da_charge_committed = False
        div_refund_e = 0.0

        # realised same-ISP favourability — clearing conditions ONLY
        mfrrUp = P_mfrr >= 1
        afrrUp = Apos > 0

        # KNOWN info at the gates: settled ISP i−3 + live intraday quote
        jl = i - LAG_SETTLED
        lag_known = jl >= 0
        pmfJ = pmf[jl] if lag_known else math.nan
        aposJ = apos[jl] if lag_known else 0.0
        anegJ = aneg[jl] if lag_known else 0.0
        mfrrUpLag = pmfJ >= 1
        afrrUpLag = aposJ > 0
        bestUpLag = max(pmfJ if mfrrUpLag else -math.inf, aposJ if afrrUpLag else -math.inf)
        mfrrChgLag = pmfJ <= -1 and pmfJ <= ceiling
        afrrChgLag = anegJ < 0 and anegJ <= ceiling

        da_dis = p["daOn"] and rhi[i] < p["da_n_periods"] and fc[i] >= p["da_min_price"] and P_da >= p["da_min_price"]
        da_buy = (not da_dis) and p["daOn"] and rlo[i] < p["da_n_periods"] and fc[i] <= p["da_charge_price"] and P_da <= p["da_charge_price"]

        if da_dis:
            dir_ = 1
            commitMW = min(p["da_mw"], eMaxMW)
            maxDelivMW = math.floor(min(budgetMW, (soc * eta) / E4))
            delivMW = min(commitMW, maxDelivMW)
            # DA settles financially: the committed sale is paid in full at
            # P_da; the undelivered remainder is bought back at imbalance.
            cDA += commitMW * E4 * P_da
            if delivMW > 0:
                soc -= delivMW * E4 / eta
                budgetMW -= delivMW
                daSellMW = delivMW
            shortMW = commitMW - delivMW
            if shortMW > 0 and not math.isnan(P_imb):
                shortE = shortMW * E4
                cImb += shortE * P_imb
                cFlat += shortE * theta
        elif da_buy:
            dir_ = -1
            da_charge_committed = True
            commitMW = min(p["da_mw"], eMaxMW)
            maxChgMW = math.floor(min(budgetMW, (cap - soc) / (E4 * eta)))
            chgMW = min(commitMW, maxChgMW)
            # Financial mirror of the sale: the committed buy is paid in full;
            # unabsorbable energy is sold back at imbalance (long), θ on the gap.
            cChg -= commitMW * E4 * P_da
            if chgMW > 0:
                stored = chgMW * E4 * eta
                cb = (cb * soc + P_da * chgMW * E4) / (soc + stored)
                soc += stored
                budgetMW -= chgMW
                chgOtherMW += chgMW
            surplusMW = commitMW - chgMW
            if surplusMW > 0 and not math.isnan(P_imb):
                shortE = surplusMW * E4
                cImb -= shortE * P_imb
                cFlat += shortE * theta

        # realised charge usability — clearing conditions only
        mfrrChgU = P_mfrr <= -1 and P_mfrr <= ceiling
        afrrChgU = Aneg < 0 and Aneg <= ceiling
        idChgU = (not math.isnan(Vwap)) and Vwap <= ceiling  # executable quote
        # best KNOWN charge source (settled balancing / live intraday quote)
        bestChgKnown = math.inf
        for ok, pr in ((mfrrChgLag, pmfJ), (afrrChgLag, anegJ), (idChgU, Vwap)):
            if ok and pr < bestChgKnown:
                bestChgKnown = pr

        # placement is a posture: place whenever physically possible
        canDis = soc > loRed + EPS and budgetMW >= 1
        canChg = soc < hiRed - EPS and budgetMW >= 1
        # cooldown rest measured from the last action (block END), not flip start
        in_cooldown = (i - lastActISP) < dwell
        rest_ok = lambda want: actMode == 0 or actMode == want or not in_cooldown

        if da_charge_committed:
            pass
        elif dir_ == 1:
            pass
        elif canDis and canChg:
            if actMode == -1 and in_cooldown:
                dir_ = -1
            elif actMode == 1 and in_cooldown:
                dir_ = 1
            else:
                upScore = (bestUpLag - effCost) if bestUpLag > -math.inf else -math.inf
                dnScore = (ceiling - bestChgKnown) if bestChgKnown < math.inf else -math.inf
                dir_ = 1 if upScore >= dnScore else -1
        elif canDis and rest_ok(1):
            dir_ = 1
        elif canChg and rest_ok(-1):
            dir_ = -1

        # 3a. discharge leg (not budget-gated: opportunistic redirects already-
        # delivered DA energy; extra-discharge below is self-gated by availMW)
        if dir_ == 1 and not da_charge_committed:
            # opportunistic divert — REACTIVE trigger (settled i−3 price vs the
            # live intraday quote); intraday buy-back COMMITTED either way; the
            # freed energy is offered to mFRR at ask = Vwap + threshold. Miss ⇒
            # energy stays stored (deferred SoC refund), net (p_da − vwap)·E.
            if p["oppOn"] and daSellMW > 0 and mfrrUpLag and not math.isnan(Vwap) and (pmfJ - Vwap) >= p["opp_threshold"]:
                e = daSellMW * E4
                askDiv = Vwap + p["opp_threshold"]
                cID -= e * Vwap
                if mfrrUp and P_mfrr >= askDiv:
                    cUpM += e * P_mfrr
                    upMmw += daSellMW
                    bids.append((i, "mfrr", 1, daSellMW, P_mfrr, "cleared"))
                else:
                    div_refund_e = e  # refund AFTER the extra offer (sizing is gate-time)
                    if accept:
                        c["divMiss"] += 1
                    bids.append((i, "mfrr", 1, daSellMW, askDiv, "resting"))
                daSellMW = 0.0
            availMW = math.floor(min(budgetMW, (max(0.0, soc - loRed) * eta) / E4))
            if availMW > 0:
                # reactive ask: resting level = break-even + margin; on a
                # run-up over SETTLED ISPs the WHOLE offer is re-priced to
                # last-settled + markup (full volume offered, nothing withheld)
                ask = effCost + minDelta
                repriced = False
                if p["ddOn"] and p["dd_markup"] > 0 and lag_known and (jl - p["dd_lookback"]) >= 0:
                    past = pmf[jl - p["dd_lookback"]]
                    if not math.isnan(pmfJ) and not math.isnan(past) and (pmfJ - past) >= p["dd_threshold"]:
                        raised = pmfJ + p["dd_markup"]
                        if raised > ask:
                            ask = raised
                            repriced = True
                toMfrr = sUp  # mFRR<->aFRR routing is the adaptive split's job
                routedMfrr = jround(toMfrr * availMW)
                routedAfrr = availMW - routedMfrr
                budgetMW -= availMW  # offered capacity reserved whether or not it clears
                any_clear = False
                if routedMfrr > 0:
                    if mfrrUp and P_mfrr >= ask:
                        soc -= routedMfrr * E4 / eta
                        cUpM += routedMfrr * E4 * P_mfrr
                        upMmw += routedMfrr
                        any_clear = True
                        bids.append((i, "mfrr", 1, routedMfrr, P_mfrr, "cleared-rep" if repriced else "cleared"))
                    else:
                        bids.append((i, "mfrr", 1, routedMfrr, ask, "repriced" if repriced else "resting"))
                if routedAfrr > 0:
                    if afrrUp and Apos >= ask:
                        disp = routedAfrr * (nposf[i] / 225)
                        soc -= disp * E4 / eta
                        cUpA += routedAfrr * E4 * Apos
                        upAmw += disp
                        any_clear = True
                        bids.append((i, "afrr", 1, routedAfrr, Apos, "cleared-rep" if repriced else "cleared"))
                    else:
                        bids.append((i, "afrr", 1, routedAfrr, ask, "repriced" if repriced else "resting"))
                if repriced and accept:
                    c["repriced"] += 1
                    if any_clear:
                        c["repClear"] += 1
        # deferred failed-divert refund — energy returns for FUTURE ISPs
        if div_refund_e > 0:
            soc += div_refund_e / eta

        # 3b. charge leg — sizing/routing on KNOWN info only; realised prices
        # decide clearing. Intraday only when settled balancing was dead.
        if dir_ == -1 and not da_charge_committed and canChg:
            headMW = math.floor(min(budgetMW, (hiRed - soc) / (E4 * eta)))
            if headMW > 0:
                mMW = aMW = idMW = 0
                if lag_known and not mfrrChgLag and not afrrChgLag:
                    idMW = headMW if idChgU else 0
                else:
                    mShare = jround(sDn * headMW)
                    aShare = headMW - mShare
                    if lag_known and not mfrrChgLag and afrrChgLag:
                        aMW = aShare + mShare
                    elif lag_known and mfrrChgLag and not afrrChgLag:
                        mMW = mShare + aShare
                    else:
                        mMW, aMW = mShare, aShare
                if mMW > 0:
                    if mfrrChgU:
                        stored = mMW * E4 * eta
                        cb = (cb * soc + P_mfrr * mMW * E4) / (soc + stored)
                        soc += stored
                        cDnM -= mMW * E4 * P_mfrr
                        dnMmw += mMW
                        bids.append((i, "mfrr", -1, mMW, P_mfrr, "cleared"))
                    else:
                        bids.append((i, "mfrr", -1, mMW, ceiling, "resting"))
                if aMW > 0:
                    if afrrChgU:
                        absorbed = aMW * (nnegf[i] / 225)
                        stored = absorbed * E4 * eta
                        if soc + stored > 0:
                            cb = (cb * soc + Aneg * aMW * E4) / (soc + stored)
                        soc += stored
                        cDnA -= aMW * E4 * Aneg
                        dnAmw += absorbed
                        bids.append((i, "afrr", -1, aMW, Aneg, "cleared"))
                    else:
                        bids.append((i, "afrr", -1, aMW, ceiling, "resting"))
                if idMW > 0:
                    stored = idMW * E4 * eta
                    cb = (cb * soc + Vwap * idMW * E4) / (soc + stored)
                    soc += stored
                    cChg -= idMW * E4 * Vwap
                    chgOtherMW += idMW
                budgetMW -= mMW + aMW + idMW  # placed = reserved

        if soc < -1e-6 or soc > cap + 1e-6:
            max_viol = max(max_viol, abs(soc - min(max(soc, 0), cap)))
            c["unfulfilled"] += 1  # mirror of the engine's must-fulfil audit
        soc = 0.0 if soc < 0 else (cap if soc > cap else soc)

        rev = cDA + cUpM + cUpA + cDnM + cDnA + cID + cChg - cImb - cFlat
        netDis = daSellMW + upMmw + upAmw
        netChg = dnMmw + dnAmw + chgOtherMW
        ispDir = 1 if netDis > 1e-6 else (-1 if netChg > 1e-6 else 0)
        if ispDir != 0:  # anchor the cooldown on every action (block END)
            lastActISP = i
            actMode = ispDir

        socs.append(soc); revs.append(rev)
        daSells.append(daSellMW); upMs.append(upMmw); dnMs.append(dnMmw); chgOs.append(chgOtherMW)
        if not accept:
            continue
        total += rev
        fr.append(rev)
        for kk, vv in (("DA", cDA), ("mFRR_up", cUpM), ("aFRR_up", cUpA), ("mFRR_dn", cDnM),
                       ("aFRR_dn", cDnA), ("intraday", cID), ("charge", cChg), ("imb", cImb), ("flat", cFlat)):
            b[kk] += vv
        mwhDis += netDis * E4
        mwhChg += netChg * E4
        if daSellMW > 1e-6: c["daCleared"] += 1
        if upMmw > 1e-6: c["upMfrr"] += 1
        if upAmw > 1e-6: c["upAfrr"] += 1
        if dnMmw > 1e-6: c["dnMfrr"] += 1
        if dnAmw > 1e-6: c["dnAfrr"] += 1
        if shortE > 1e-6:
            c["short"] += 1
            shortMWh += shortE
        if soc < pinLo: c["lowRed"] += 1
        if soc > pinHi: c["upRed"] += 1
        c["discharge" if ispDir == 1 else ("charge" if ispDir == -1 else "idle")] += 1

    return dict(total=total, breakdown=b, counts=c, mwhDischarged=mwhDis, mwhCharged=mwhChg,
                shortMWh=shortMWh, finalSoc=soc, soc=np.asarray(socs), rev=np.asarray(revs),
                filtered_rev=np.asarray(fr), daSell=np.asarray(daSells), upM=np.asarray(upMs),
                dnM=np.asarray(dnMs), chgOther=np.asarray(chgOs), bids=bids, max_balancing_violation=max_viol)


# =============================================================================
#  Sensitivity math — Python mirror of optim-sens.js (OptimSens, shared by
#  the BESS and wind-park pages)
# =============================================================================
def sens_ranks(a):
    idx = sorted(range(len(a)), key=lambda i: a[i])
    rk = [0.0] * len(a)
    i = 0
    while i < len(idx):
        j = i
        while j + 1 < len(idx) and a[idx[j + 1]] == a[idx[i]]:
            j += 1
        r = (i + j) / 2 + 1  # average rank across ties
        for k in range(i, j + 1):
            rk[idx[k]] = r
        i = j + 1
    return rk


def sens_spearman(xs, ys):
    rx, ry = sens_ranks(list(xs)), sens_ranks(list(ys))
    n = len(rx)
    if n < 2:
        return 0.0
    mx, my = sum(rx) / n, sum(ry) / n
    sxy = sum((rx[i] - mx) * (ry[i] - my) for i in range(n))
    sxx = sum((x - mx) ** 2 for x in rx)
    syy = sum((y - my) ** 2 for y in ry)
    return sxy / math.sqrt(sxx * syy) if sxx > 0 and syy > 0 else 0.0


def sens_weight_and_band(curve, v_star, r_star, tol=0.01):
    """curve = [(v, r)] sorted by v (must contain v_star or its nearest)."""
    denom = max(1.0, abs(r_star))
    loss = [(r_star - r) / denom for _, r in curve]
    i_star = 0
    for i in range(1, len(curve)):
        if abs(curve[i][0] - v_star) < abs(curve[i_star][0] - v_star):
            i_star = i
    weight = 0.0
    for L in loss:
        if L > weight:
            weight = L
    lo, hi = i_star, i_star
    while lo > 0 and loss[lo - 1] <= tol:
        lo -= 1
    while hi < len(curve) - 1 and loss[hi + 1] <= tol:
        hi += 1
    if weight <= tol:
        shape = "flat"
    else:
        r_first, r_last = curve[0][1], curve[-1][1]
        if r_star - max(r_first, r_last) <= tol * denom:
            shape = "up" if r_last >= r_first else "down"
        else:
            shape = "peaked"
    nb = max(loss[i_star - 1] if i_star > 0 else 0.0,
             loss[i_star + 1] if i_star < len(curve) - 1 else 0.0)
    return dict(weight=weight, band=[curve[lo][0], curve[hi][0]], shape=shape,
                sharp=nb > 0.05, edge=(i_star == 0 or i_star == len(curve) - 1))


def _sens_bins(vals):
    uniq = sorted(set(vals))
    if len(uniq) <= 3:
        return [uniq.index(v) for v in vals]
    s = sorted(vals)
    q1, q2 = _percentile_value(s, 100 / 3), _percentile_value(s, 200 / 3)
    return [0 if v <= q1 else (1 if v <= q2 else 2) for v in vals]


def sens_interaction_scores(pop, keys, r_star, min_cell=20):
    """pop = [{'sample': {...}, 'revenue': r}] — pairwise non-additivity of
    tertile-binned cell means, RMS residual as a fraction of |r_star|."""
    denom = max(1.0, abs(r_star))
    ys = [p["revenue"] for p in pop]
    bins_by = {k: _sens_bins([p["sample"][k] for p in pop]) for k in keys}
    out = []
    for a in range(len(keys)):
        for b in range(a + 1, len(keys)):
            ba, bb = bins_by[keys[a]], bins_by[keys[b]]
            sm = [[0.0] * 3 for _ in range(3)]
            ct = [[0] * 3 for _ in range(3)]
            for i, yv in enumerate(ys):
                sm[ba[i]][bb[i]] += yv
                ct[ba[i]][bb[i]] += 1
            g = gn = 0.0
            valid = 0
            for r in range(3):
                for c in range(3):
                    if ct[r][c] >= min_cell:
                        g += sm[r][c]
                        gn += ct[r][c]
                        valid += 1
            if valid < 6 or gn == 0:
                continue
            g /= gn
            rowE, colE = [0.0] * 3, [0.0] * 3
            for r in range(3):
                s = n = 0.0
                for c in range(3):
                    if ct[r][c] >= min_cell:
                        s += sm[r][c]
                        n += ct[r][c]
                rowE[r] = s / n - g if n > 0 else 0.0
            for c in range(3):
                s = n = 0.0
                for r in range(3):
                    if ct[r][c] >= min_cell:
                        s += sm[r][c]
                        n += ct[r][c]
                colE[c] = s / n - g if n > 0 else 0.0
            se = sw = 0.0
            for r in range(3):
                for c in range(3):
                    if ct[r][c] < min_cell:
                        continue
                    e = sm[r][c] / ct[r][c] - (g + rowE[r] + colE[c])
                    se += ct[r][c] * e * e
                    sw += ct[r][c]
            out.append(dict(a=keys[a], b=keys[b], score=math.sqrt(se / sw) / denom))
    out.sort(key=lambda x: -x["score"])
    return out


# =============================================================================
#  Synthetic + real-data harnesses
# =============================================================================
def synth(n, **arrays):
    A = dict(n=n, win_start=0, win_end=n,
             p_da=np.full(n, 50.0), p_mfrr=np.zeros(n), p_imb=np.full(n, 50.0),
             avg_p_pos=np.zeros(n), avg_p_neg=np.zeros(n), vwap_1h=np.full(n, np.nan),
             n_pos_fav=np.full(n, 225.0), n_neg_fav=np.full(n, 225.0), mask=np.zeros(n, dtype=np.uint8),
             fc=np.full(n, np.nan), rank_hi=np.full(n, 1 << 30, dtype=np.int64), rank_lo=np.full(n, 1 << 30, dtype=np.int64))
    A.update(arrays)
    return A


_REAL = {}


def real_ctx():
    if _REAL:
        return _REAL
    data = load_data()
    fc, rhi, rlo = build_da_forecast(data)
    _REAL["data"] = data
    _REAL["A"] = dict(
        n=data["n"], win_start=0, win_end=data["n"],
        p_da=data["p_da"].tolist(),
        p_mfrr=winsorize(data["p_mfrr"].tolist(), 5, 95),
        p_imb=winsorize(data["p_imb"].tolist(), 5, 95),
        avg_p_pos=winsorize(data["avg_p_pos"].tolist(), 5, 95),
        avg_p_neg=winsorize(data["avg_p_neg"].tolist(), 5, 95),
        vwap_1h=data["vwap_1h"].tolist(),
        n_pos_fav=data["n_pos_fav"].tolist(), n_neg_fav=data["n_neg_fav"].tolist(),
        mask=day_type_mask(data), fc=fc, rank_hi=rhi, rank_lo=rlo,
    )
    return _REAL


DEFAULT_PARAMS = dict(
    cap_mwh=40, power_mw=20, eff_pct=90, init_soc_pct=50, dwell_isps=4,
    upper_red_pct=80, lower_red_pct=20, min_delta=100, theta_flat=30,
    s_up_start=1, s_up_win=96, s_up_wait=1, s_up_step=0, s_dn_start=1, s_dn_win=96, s_dn_wait=1, s_dn_step=0,
    da_min_price=100, da_charge_price=0, da_n_periods=8, da_mw=20, max_charge_price=20,
    dd_lookback=1, dd_threshold=20, dd_markup=75, opp_threshold=100,
    enabled=dict(split=True, daDischarge=True, charging=True, dynamicDischarge=True, opportunistic=True),
)


# =============================================================================
#  A. FORECAST
# =============================================================================
def test_lag96_forecast():
    data = real_ctx()["data"]
    fc, _, _ = build_da_forecast(data)
    assert math.isnan(fc[0]) and math.isnan(fc[LAG - 1])
    for i in (LAG, 1000, 20000, data["n"] - 1):
        assert abs(fc[i] - data["p_da"][i - LAG]) < 1e-9


def test_da_peak_and_trough_ranks():
    n = 96
    fc = np.array([10.0 + (40 if i == 50 else 0) - (8 if i == 7 else 0) + i * 0.001 for i in range(n)])
    ranked = sorted(range(n), key=lambda i: -fc[i])
    rhi = np.empty(n, dtype=np.int64); rlo = np.empty(n, dtype=np.int64)
    for r, i in enumerate(ranked):
        rhi[i] = r; rlo[i] = n - 1 - r
    assert rhi[50] == 0, "explicit peak ranks 0 (highest)"
    assert rlo[7] == 0, "explicit trough ranks 0 (lowest)"


# =============================================================================
#  B. CORE MECHANICS
# =============================================================================
def test_charge_efficiency_and_costbasis():
    # 3 warm-up ISPs give the fair engine a SETTLED price to act on at i=3;
    # the warm-up itself is inert (no-info posture rests a discharge offer,
    # which cannot clear at −10 €/MWh).
    A = synth(4, p_mfrr=np.full(4, -10.0))
    p = dict(DEFAULT_PARAMS, init_soc_pct=25, da_n_periods=0, max_charge_price=20,
             enabled=dict(split=False, daDischarge=False, charging=True, dynamicDischarge=False, opportunistic=False))
    r = bess_run(A, p)
    eta = math.sqrt(0.9)
    soc0 = 0.25 * 40
    assert abs(r["soc"][2] - soc0) < 1e-9, "warm-up must be inert"
    headMW = min(20, math.floor((0.8 * 40 - soc0) / (E4 * eta)))  # 20
    stored = headMW * E4 * eta
    assert abs(r["soc"][3] - (soc0 + stored)) < 1e-6
    assert abs(r["total"] - (headMW * E4 * 10.0)) < 1e-6, "paid 10/MWh to absorb ⇒ +revenue"
    assert r["counts"]["dnMfrr"] == 1


def test_power_cap_limits_throughput():
    # init 10% is BELOW the red floor ⇒ canDis is false, so the charge side is
    # placed from ISP 0 with no history needed (single-side, not a tie-break).
    A = synth(1, p_mfrr=np.array([-10.0]))
    p = dict(DEFAULT_PARAMS, power_mw=20, init_soc_pct=10, da_n_periods=0,
             enabled=dict(split=False, daDischarge=False, charging=True, dynamicDischarge=False, opportunistic=False))
    r = bess_run(A, p)
    assert r["dnM"][0] > 0, "the charge bid must clear at −10 €/MWh"
    assert r["mwhCharged"] <= 20 * E4 + 1e-6


def test_whole_mw_market_volumes():
    A = real_ctx()["A"]
    r = bess_run(A, DEFAULT_PARAMS)
    for name in ("daSell", "upM", "dnM", "chgOther"):
        arr = r[name]
        frac = np.abs(arr - np.round(arr))
        assert frac.max() < 1e-9, f"{name} must be whole MW (max frac {frac.max()})"


def test_min_delta_blocks_thin_discharge():
    A = synth(1, p_mfrr=np.array([60.0]))
    p = dict(DEFAULT_PARAMS, init_soc_pct=80, min_delta=100, da_n_periods=0,
             enabled=dict(split=False, daDischarge=False, charging=False, dynamicDischarge=False, opportunistic=False))
    assert bess_run(A, p)["mwhDischarged"] == 0
    assert bess_run(synth(1, p_mfrr=np.array([160.0])), p)["mwhDischarged"] > 0


def test_red_zones_bound_discretionary():
    n = 200
    A = synth(n, p_mfrr=np.full(n, 300.0))
    p = dict(DEFAULT_PARAMS, init_soc_pct=100, min_delta=0, da_n_periods=0, dwell_isps=0,
             enabled=dict(split=False, daDischarge=False, charging=False, dynamicDischarge=False, opportunistic=False))
    assert bess_run(A, p)["soc"].min() >= 0.20 * 40 - 1e-6


def test_dwell_blocks_fast_flip():
    # charge fires at i=3 (settled −50 seen), then the price flips high; with a
    # long dwell the flip to discharge stays blocked, with dwell=0 it clears.
    A = synth(8, p_mfrr=np.array([-50.0] * 4 + [300.0] * 4))
    p = dict(DEFAULT_PARAMS, init_soc_pct=50, dwell_isps=8, min_delta=0, da_n_periods=0, max_charge_price=20,
             enabled=dict(split=False, daDischarge=False, charging=True, dynamicDischarge=False, opportunistic=False))
    r = bess_run(A, p)
    assert r["counts"]["dnMfrr"] >= 1, "the settled cheap price must trigger a charge"
    assert r["mwhDischarged"] == 0, "dwell must block the flip to discharge"
    r0 = bess_run(A, dict(p, dwell_isps=0))
    assert r0["mwhDischarged"] > 0, "without dwell the flip clears (dwell was binding)"


def test_dwell_enforces_rest_between_opposite_phases():
    """The dwell is a COOLDOWN measured from the last action (block END): the
    opposite phase may start once >= dwell ISPs have passed since the last
    discharge (dwell-1 fully idle ISPs in between), even when charging is
    immediately attractive."""
    n = 10
    pm = np.array([300.0, 300, 300, 300, -50, -50, -50, -50, -50, -50])
    A = synth(n, p_mfrr=pm)
    p = dict(DEFAULT_PARAMS, init_soc_pct=100, dwell_isps=4, min_delta=0, da_n_periods=0, max_charge_price=20,
             enabled=dict(split=False, daDischarge=False, charging=True, dynamicDischarge=False, opportunistic=False))
    r = bess_run(A, p)
    dis = [k for k in range(n) if r["upM"][k] > 1e-6]       # discharge ISPs
    chg = [k for k in range(n) if r["dnM"][k] > 1e-6]       # charge ISPs
    assert dis and chg, "scenario should both discharge then charge"
    last_dis, first_chg = max(dis), min(chg)
    assert first_chg - last_dis >= 4, (
        f"charge started {first_chg - last_dis} ISPs after last discharge; "
        f"expected a >= dwell (4) rest. dis={dis} chg={chg}"
    )
    assert first_chg > last_dis + 1, "there must be idle ISPs (a real break) between the phases"


def test_must_fulfil_no_soc_violation_random():
    rng = np.random.default_rng(12345)
    n = 5000
    A = synth(n, p_mfrr=rng.uniform(-200, 400, n),
              avg_p_pos=np.maximum(0, rng.uniform(-50, 200, n)),
              avg_p_neg=np.minimum(0, rng.uniform(-200, 50, n)),
              p_da=rng.uniform(-50, 250, n), vwap_1h=rng.uniform(-50, 250, n), p_imb=rng.uniform(-50, 400, n),
              fc=rng.uniform(-50, 250, n),
              rank_hi=rng.integers(0, 96, n).astype(np.int64), rank_lo=rng.integers(0, 96, n).astype(np.int64),
              n_pos_fav=rng.integers(0, 226, n).astype(float), n_neg_fav=rng.integers(0, 226, n).astype(float))
    r = bess_run(A, DEFAULT_PARAMS)
    assert r["max_balancing_violation"] < 1e-6
    assert r["soc"].min() >= -1e-6 and r["soc"].max() <= 40 + 1e-6


def test_charge_price_aware_skips_above_ceiling():
    # mFRR-dn exists at −2 but ceiling −50 excludes it; aFRR-dn −80 is usable.
    # Split off (sDn=1) routes to mFRR, but the SETTLED (i−3) usability
    # re-routes that share to aFRR — no same-ISP knowledge involved.
    A = synth(4, p_mfrr=np.full(4, -2.0), avg_p_neg=np.full(4, -80.0))
    p = dict(DEFAULT_PARAMS, init_soc_pct=20, da_n_periods=0, max_charge_price=-50,
             enabled=dict(split=False, daDischarge=False, charging=True, dynamicDischarge=False, opportunistic=False))
    r = bess_run(A, p)
    eta = math.sqrt(0.9)
    headMW = min(20, math.floor((0.8 * 40 - 0.2 * 40) / (E4 * eta)))
    assert r["counts"]["dnAfrr"] == 1 and r["counts"]["dnMfrr"] == 0, "must avoid the lag-unusable mFRR side"
    assert abs(r["total"] - headMW * E4 * 80.0) < 1e-6


def test_da_buy_low_committed_at_trough():
    # forecast trough ≤ buy ceiling and actual ≤ ceiling ⇒ day-ahead buy fires
    A = synth(1, p_da=np.array([-5.0]), fc=np.array([-5.0]), rank_lo=np.array([0], dtype=np.int64))
    p = dict(DEFAULT_PARAMS, init_soc_pct=20, da_charge_price=0, da_n_periods=8,
             enabled=dict(split=False, daDischarge=True, charging=False, dynamicDischarge=False, opportunistic=False))
    r = bess_run(A, p)
    assert r["mwhCharged"] > 0 and r["chgOther"][0] > 0, "battery should buy-low on DA at the trough"
    assert r["total"] > 0, "buying at −5 €/MWh pays us"


def test_opportunistic_keeps_da_and_uses_intraday():
    # DA-sold peak + a SETTLED spike signal (i−3 mFRR 300 above the intraday
    # quote) ⇒ divert: buy the DA volume back on intraday, offer it to mFRR at
    # ask = Vwap + threshold; the spike persists ⇒ clears. DA revenue KEPT.
    big = 1 << 30
    A = synth(4, p_da=np.full(4, 200.0), p_mfrr=np.full(4, 400.0), vwap_1h=np.full(4, 100.0),
              fc=np.array([np.nan, np.nan, np.nan, 200.0]),
              rank_hi=np.array([big, big, big, 0], dtype=np.int64))
    p = dict(DEFAULT_PARAMS, init_soc_pct=20, min_delta=0, da_min_price=100, da_n_periods=8, da_mw=20,
             opp_threshold=100,
             enabled=dict(split=False, daDischarge=True, charging=False, dynamicDischarge=False, opportunistic=True))
    r = bess_run(A, p)
    bd = r["breakdown"]
    # 20 MW × 0.25 h delivered at i=3: DA kept = 1000, balancing = 5×400 = 2000,
    # intraday close = −5×100 = −500 (warm-up is inert: soc sits at the red floor)
    assert abs(bd["DA"] - 1000) < 1e-6, "DA revenue must be KEPT on divert"
    assert abs(bd["mFRR_up"] - 2000) < 1e-6
    assert abs(bd["intraday"] - (-500)) < 1e-6, "close on intraday only (imbalance never chosen)"
    assert abs(r["total"] - 2500) < 1e-6
    assert r["counts"]["divMiss"] == 0


def test_opportunistic_miss_pays_the_spread_and_keeps_energy():
    """A divert is a committed BET now: the intraday buy-back happens at the
    gate; if the spike then fizzles (realised mFRR below Vwap + threshold) the
    mFRR offer rests, the energy stays in the battery and the net P&L of the
    ISP is (p_da − vwap)·E — a real loss when the buy-back was dearer."""
    big = 1 << 30
    A = synth(4, p_da=np.full(4, 200.0), p_mfrr=np.array([400.0, 400.0, 400.0, 150.0]),
              vwap_1h=np.full(4, 100.0), fc=np.array([np.nan, np.nan, np.nan, 200.0]),
              rank_hi=np.array([big, big, big, 0], dtype=np.int64))
    p = dict(DEFAULT_PARAMS, init_soc_pct=20, min_delta=0, da_min_price=100, da_n_periods=8, da_mw=20,
             opp_threshold=100,
             enabled=dict(split=False, daDischarge=True, charging=False, dynamicDischarge=False, opportunistic=True))
    r = bess_run(A, p)
    bd = r["breakdown"]
    # trigger: settled pmf[0]=400 − Vwap 100 ≥ 100 ✓; realised 150 < ask 200 ⇒ miss
    assert abs(bd["DA"] - 1000) < 1e-6, "DA revenue still earned (covered by intraday)"
    assert abs(bd["mFRR_up"]) < 1e-6, "the diverted offer must NOT clear at 150 < ask 200"
    assert abs(bd["intraday"] - (-500)) < 1e-6, "the intraday buy-back is committed either way"
    assert abs(r["total"] - 500) < 1e-6, "net = (p_da − vwap)·E = (200−100)×5"
    assert r["counts"]["divMiss"] == 1
    assert abs(r["soc"][3] - 0.20 * 40) < 1e-6, "the energy never left the battery"
    assert r["daSell"][3] == 0, "the battery did not deliver the DA leg itself"


def test_reprice_rests_on_stall_and_clears_on_continuation():
    """Reactive ask: a run-up over SETTLED ISPs (p_mfrr[i-3] vs lookback before
    it) re-prices the whole offer to last-settled + markup. If the price
    stalls below the ask the offer RESTS (no discharge, nothing sold cheap);
    if the spike keeps running past the ask the FULL volume clears (nothing
    is withheld — the old dd_hold behaviour is gone)."""
    # target ISP i=9: settled base pmf[6]=100 vs pmf[2]=0 → rise 100 ≥ 50 ⇒ ask 200
    base = [0.0] * 6 + [100.0, 0.0, 0.0]
    p = dict(DEFAULT_PARAMS, init_soc_pct=100, min_delta=0, dwell_isps=0, da_n_periods=0,
             dd_lookback=4, dd_threshold=50, dd_markup=100,
             enabled=dict(split=False, daDischarge=False, charging=False, dynamicDischarge=True, opportunistic=False))
    # stall: realised P = 150 < ask 200 → rests
    r = bess_run(synth(10, p_mfrr=np.array(base + [150.0])), p)
    assert r["upM"][9] == 0, "price below the raised ask must NOT clear"
    assert r["counts"]["repriced"] == 1 and r["counts"]["repClear"] == 0
    assert any(s == "repriced" for *_, s in r["bids"])
    # continuation: realised P = 300 ≥ ask 200 → the FULL offer clears
    r2 = bess_run(synth(10, p_mfrr=np.array(base + [300.0])), p)
    assert r2["upM"][9] == 20, f"continuation must clear the FULL offer, got {r2['upM'][9]} MW"
    assert r2["counts"]["repriced"] == 1 and r2["counts"]["repClear"] == 1
    # an isolated spike out of a flat settled past is NOT held back: no run-up
    # ⇒ baseline ask ⇒ the resting offer clears at full volume (the old
    # hold-back used to withhold exactly here)
    r3 = bess_run(synth(10, p_mfrr=np.array([0.0] * 9 + [400.0])), p)
    assert r3["upM"][9] == 20, "the spike ISP itself must clear in full"
    assert r3["counts"]["repriced"] == 0


def test_no_future_leakage_perturbation():
    """THE leakage regression: shocking the CURRENT ISP's realised balancing
    prices (mFRR / aFRR up+down) must not change any DECISION taken for that
    ISP — direction, which offers were placed (product / side / MW), the
    intraday charge volume, the DA delivery, or the divert commitment. Only
    CLEARING outcomes may change. The intraday quote is NOT perturbed (it is
    a pre-gate snapshot, legitimately known)."""
    rng = np.random.default_rng(777)
    n = 60
    mk = lambda: dict(
        p_mfrr=np.round(rng.uniform(-150, 250, n), 1),
        avg_p_pos=np.round(np.maximum(0, rng.uniform(-100, 250, n)), 1),
        avg_p_neg=np.round(np.minimum(0, rng.uniform(-200, 60, n)), 1),
        p_da=np.round(rng.uniform(-30, 220, n), 1),
        vwap_1h=np.round(rng.uniform(-30, 220, n), 1),
        p_imb=np.round(rng.uniform(-50, 300, n), 1),
        fc=np.round(rng.uniform(-30, 220, n), 1),
        rank_hi=rng.integers(0, 40, n).astype(np.int64),
        rank_lo=rng.integers(0, 40, n).astype(np.int64),
        n_pos_fav=rng.integers(0, 226, n).astype(float),
        n_neg_fav=rng.integers(0, 226, n).astype(float),
    )
    arrays = mk()
    p = dict(DEFAULT_PARAMS, dwell_isps=2, min_delta=50, max_charge_price=30, opp_threshold=80)
    r0 = bess_run(synth(n, **{k: v.copy() for k, v in arrays.items()}), p)
    placed0 = {}
    for (isp, prod, dirn, mw, _price, _status) in r0["bids"]:
        placed0.setdefault(isp, []).append((prod, dirn, round(float(mw), 6)))
    for k in range(6, n):
        for shock in (+400.0, -400.0):
            pert = {key: v.copy() for key, v in arrays.items()}
            pert["p_mfrr"][k] += shock
            pert["avg_p_pos"][k] = max(0.0, pert["avg_p_pos"][k] + shock)
            pert["avg_p_neg"][k] = min(0.0, pert["avg_p_neg"][k] - shock)
            r2 = bess_run(synth(n, **pert), p)
            placed2 = {}
            for (isp, prod, dirn, mw, _price, _status) in r2["bids"]:
                placed2.setdefault(isp, []).append((prod, dirn, round(float(mw), 6)))
            assert sorted(placed0.get(k, [])) == sorted(placed2.get(k, [])), (
                f"ISP {k} shock {shock:+}: PLACED offers changed with the realised price — leakage!"
                f"\n  base: {sorted(placed0.get(k, []))}\n  pert: {sorted(placed2.get(k, []))}")
            assert r0["chgOther"][k] == r2["chgOther"][k], (
                f"ISP {k} shock {shock:+}: intraday/DA-buy charge volume depends on realised balancing prices!")
            assert r0["daSell"][k] == r2["daSell"][k], (
                f"ISP {k} shock {shock:+}: DA delivery / divert commitment depends on realised balancing prices!")
            # per-ISP revenue BEFORE k must be identical (no backward influence)
            assert np.array_equal(r0["rev"][:k], r2["rev"][:k]), f"ISP {k}: earlier ISPs changed!"


def test_ask_gates_each_leg_no_below_margin_clears():
    """A leg clears only if ITS OWN price reaches the ask — one market carrying
    the bestUp gate must not let the other clear below break-even + minDelta."""
    p = dict(DEFAULT_PARAMS, init_soc_pct=100, min_delta=100, dwell_isps=0, da_n_periods=0,
             enabled=dict(split=False, daDischarge=False, charging=False, dynamicDischarge=False, opportunistic=False))
    # aFRR (200) carries the gate; all volume routed to mFRR (split off ⇒ sUp=1,
    # dd off ⇒ no switch); mFRR at 50 < ask 100 → the offer RESTS
    r = bess_run(synth(1, p_mfrr=np.array([50.0]), avg_p_pos=np.array([200.0])), p)
    assert r["mwhDischarged"] == 0, "mFRR share must not clear below the ask"
    assert any(s == "resting" for *_, s in r["bids"])
    # sanity: mFRR above the ask clears
    r2 = bess_run(synth(1, p_mfrr=np.array([150.0]), avg_p_pos=np.array([200.0])), p)
    assert r2["mwhDischarged"] > 0
    # symmetric: mFRR (200) carries the gate, all volume routed to aFRR
    # (split on, static 0) but aFRR avg 50 < ask 100 → rests
    p3 = dict(p, s_up_start=0, s_up_step=0, enabled=dict(p["enabled"], split=True))
    r3 = bess_run(synth(1, p_mfrr=np.array([200.0]), avg_p_pos=np.array([50.0])), p3)
    assert r3["counts"]["upAfrr"] == 0 and r3["mwhDischarged"] == 0


def test_redzone_time_counters():
    """Red-zone time audit: ISPs whose end-of-ISP SoC is pinned at/inside a red
    zone (within one whole-MW step of the boundary, or beyond it) are counted;
    mid-band ISPs are not. Committed DA legs that dig inside the zone count."""
    eta = math.sqrt(0.9)
    n = 8
    p = dict(DEFAULT_PARAMS, init_soc_pct=50, min_delta=0, dwell_isps=0, da_n_periods=0,
             enabled=dict(split=False, daDischarge=False, charging=False, dynamicDischarge=False, opportunistic=False))
    # lower: discharge to the floor, then park just above loRed (whole-MW leftovers)
    r = bess_run(synth(n, p_mfrr=np.full(n, 300.0)), p)
    pin_lo = 0.20 * 40 + E4 / eta
    expect = int(np.sum(r["soc"] < pin_lo))
    assert expect > 0, "battery should end parked at the lower boundary"
    assert r["counts"]["lowRed"] == expect
    assert r["counts"]["upRed"] == 0
    assert r["soc"].min() >= 0.20 * 40 - 1e-9, "discretionary discharge never enters the zone"
    # upper: charge to the ceiling, then park just below hiRed
    p2 = dict(p, max_charge_price=20, enabled=dict(p["enabled"], charging=True))
    r2 = bess_run(synth(n, p_mfrr=np.full(n, -50.0)), p2)
    pin_hi = 0.80 * 40 - E4 * eta
    expect2 = int(np.sum(r2["soc"] > pin_hi))
    assert expect2 > 0 and r2["counts"]["upRed"] == expect2
    assert r2["counts"]["lowRed"] == 0
    # committed DA discharge digs INSIDE the lower zone → counted (strictly in-zone)
    A3 = synth(1, p_da=np.array([200.0]), fc=np.array([200.0]), rank_hi=np.array([0], dtype=np.int64))
    p3 = dict(DEFAULT_PARAMS, init_soc_pct=30, da_min_price=100, da_n_periods=8, da_mw=20,
              enabled=dict(split=False, daDischarge=True, charging=False, dynamicDischarge=False, opportunistic=False))
    r3 = bess_run(A3, p3)
    assert r3["soc"][0] < 0.20 * 40 and r3["counts"]["lowRed"] == 1


# =============================================================================
#  B2. SENSITIVITY MATH (mirror of optim-sens.js)
# =============================================================================
def test_sens_weight_band_shape():
    grid = list(range(7))
    # peaked quadratic f(v) = 100 − (v−3)²: worst loss 9%, 1%-band [2..4]
    m = sens_weight_and_band([(v, 100.0 - (v - 3) ** 2) for v in grid], 3, 100.0)
    assert abs(m["weight"] - 0.09) < 1e-12
    assert m["band"] == [2, 4]
    assert m["shape"] == "peaked" and not m["edge"] and not m["sharp"]
    # monotone up, optimum at the boundary
    m2 = sens_weight_and_band([(v, float(v)) for v in grid], 6, 6.0)
    assert m2["shape"] == "up" and m2["edge"]
    assert abs(m2["weight"] - 1.0) < 1e-12  # v=0 loses everything: (6−0)/max(1,6)
    # flat: nothing matters anywhere
    m3 = sens_weight_and_band([(v, 50.0) for v in grid], 2, 50.0)
    assert m3["shape"] == "flat" and m3["weight"] == 0.0 and m3["band"] == [0, 6]
    # sharp cliff next to the optimum
    m4 = sens_weight_and_band([(0, 100.0), (1, 40.0), (2, 30.0)], 0, 100.0)
    assert m4["sharp"] and m4["edge"] and m4["shape"] in ("down", "peaked")


def test_sens_spearman():
    xs = [1, 2, 3, 4, 5]
    assert abs(sens_spearman(xs, [2, 4, 6, 8, 10]) - 1) < 1e-12
    assert abs(sens_spearman(xs, [10, 8, 6, 4, 2]) + 1) < 1e-12
    # ties → average ranks; hand-computed: ranks x = [1.5,1.5,3.5,3.5] vs [1..4]
    assert abs(sens_spearman([1, 1, 2, 2], [1, 2, 3, 4]) - 4 / math.sqrt(20)) < 1e-12


def test_sens_interaction_detection():
    """Multiplicative pairs must outrank additive ones: rev = 100x + 100y +
    200·x·z ⇒ (x,z) is the interacting pair, (x,y) and (y,z) are additive."""
    rng = np.random.default_rng(42)
    n = 3000
    x, y, z = rng.uniform(0, 1, n), rng.uniform(0, 1, n), rng.uniform(0, 1, n)
    rev = 100 * x + 100 * y + 200 * x * z
    pop = [dict(sample=dict(x=float(x[i]), y=float(y[i]), z=float(z[i])), revenue=float(rev[i])) for i in range(n)]
    scores = sens_interaction_scores(pop, ["x", "y", "z"], r_star=300.0)
    by = {(s["a"], s["b"]): s["score"] for s in scores}
    assert (scores[0]["a"], scores[0]["b"]) == ("x", "z"), f"expected (x,z) strongest, got {scores}"
    assert by[("x", "z")] > 2 * max(by[("x", "y")], by[("y", "z")])


def test_sens_engine_oat_inert_vs_live_params():
    """Anchor the sensitivity math to the engine — the user's observation,
    distilled: with the default STATIC split (step 0) the down-split rebalance
    wait is provably inert, so its OAT weight must be exactly 0 and its shape
    flat, while da_mw genuinely carries weight."""
    A = dict(real_ctx()["A"])
    A["win_end"] = 5000  # short window keeps this test fast
    base = bess_run(A, DEFAULT_PARAMS)["total"]
    curve_wait = [(v, base if v == DEFAULT_PARAMS["s_dn_wait"]
                   else bess_run(A, dict(DEFAULT_PARAMS, s_dn_wait=v))["total"])
                  for v in (1, 24, 96, 672)]
    m = sens_weight_and_band(curve_wait, DEFAULT_PARAMS["s_dn_wait"], base)
    assert m["weight"] == 0.0 and m["shape"] == "flat", "static split ⇒ wait must be weightless"
    assert m["band"] == [1, 672], "the 1%-band must span the whole sweep"
    # a genuinely load-bearing lever: pushing the charge ceiling to −100
    # (never pay to charge) starves the battery and loses heavily
    curve_cc = [(v, base if v == 20 else bess_run(A, dict(DEFAULT_PARAMS, max_charge_price=v))["total"])
                for v in (-100, 0, 20)]
    m2 = sens_weight_and_band(curve_cc, 20, base)
    assert m2["weight"] > 0.5, "max_charge_price must carry real weight"
    # NB: weight is measured FROM AN OPTIMUM; from a non-optimal base a param
    # whose sweep only finds improvements correctly reads ~0 (e.g. da_mw here).


# =============================================================================
#  C. REAL DATA
# =============================================================================
def test_rev_equals_component_sum():
    r = bess_run(real_ctx()["A"], DEFAULT_PARAMS)
    bd = r["breakdown"]
    recomputed = bd["DA"] + bd["mFRR_up"] + bd["aFRR_up"] + bd["mFRR_dn"] + bd["aFRR_dn"] + bd["intraday"] + bd["charge"] - bd["imb"] - bd["flat"]
    assert abs(recomputed - r["total"]) < 1.0


def test_soc_bounds_real():
    r = bess_run(real_ctx()["A"], DEFAULT_PARAMS)
    assert r["soc"].min() >= -1e-6 and r["soc"].max() <= 40 + 1e-6
    assert r["max_balancing_violation"] < 1e-6


def test_daytype_partition_exact():
    A = real_ctx()["A"]
    t_all = bess_run(A, dict(DEFAULT_PARAMS, dayTypeFilter="all"))["total"]
    t_wd = bess_run(A, dict(DEFAULT_PARAMS, dayTypeFilter="workday"))["total"]
    t_we = bess_run(A, dict(DEFAULT_PARAMS, dayTypeFilter="weekend-holiday"))["total"]
    assert abs(t_all - (t_wd + t_we)) < 1.0


def test_charging_off_no_charge():
    r = bess_run(real_ctx()["A"], dict(DEFAULT_PARAMS, da_charge_price=-1e9,
                enabled=dict(DEFAULT_PARAMS["enabled"], charging=False)))
    assert r["mwhCharged"] < 1e-6
    assert r["mwhDischarged"] <= 0.50 * 40 * math.sqrt(0.9) + 1e-6


def test_da_off_no_da_legs():
    r = bess_run(real_ctx()["A"], dict(DEFAULT_PARAMS, enabled=dict(DEFAULT_PARAMS["enabled"], daDischarge=False)))
    assert r["counts"]["daCleared"] == 0 and abs(r["breakdown"]["DA"]) < 1e-6


def test_dynamic_discharge_off_no_repricing():
    r = bess_run(real_ctx()["A"], dict(DEFAULT_PARAMS, enabled=dict(DEFAULT_PARAMS["enabled"], dynamicDischarge=False)))
    assert r["counts"]["repriced"] == 0 and r["counts"]["repClear"] == 0
    assert not any(s in ("repriced", "cleared-rep") for *_, s in r["bids"])


def test_opportunistic_off_no_intraday_leg():
    r = bess_run(real_ctx()["A"], dict(DEFAULT_PARAMS, enabled=dict(DEFAULT_PARAMS["enabled"], opportunistic=False)))
    assert abs(r["breakdown"]["intraday"]) < 1e-6


def test_both_splits_static_collapse_to_one():
    A = real_ctx()["A"]
    up, upW, dn, dnW = resolve_split(resolve_params(DEFAULT_PARAMS), A["win_end"], A)
    assert all(abs(x - 1.0) < 1e-12 for x in up) and all(abs(x - 1.0) < 1e-12 for x in dn)


def test_frozen_default_revenue():
    r = bess_run(real_ctx()["A"], DEFAULT_PARAMS)
    val = r["total"]
    print(f"\n    [default BESS revenue = {val:,.2f} €  | discharged {r['mwhDischarged']:,.0f} MWh"
          f"  | charged {r['mwhCharged']:,.0f} MWh  | cycles {r['mwhDischarged']/((0.8-0.2)*40):,.1f}"
          f"  | DA-sold {r['counts']['daCleared']}  | short {r['counts']['short']}]")
    assert math.isfinite(val)
    assert r["counts"]["unfulfilled"] == 0
    if FROZEN_DEFAULT_REVENUE_EUR is not None:
        assert abs(val - FROZEN_DEFAULT_REVENUE_EUR) < 50.0, f"{val:,.2f} != frozen {FROZEN_DEFAULT_REVENUE_EUR:,.2f}"


# =============================================================================
R = TestRunner()
R.add("lag-24h DA forecast: fc[i] == p_da[i-96], NaN before", test_lag96_forecast)
R.add("per-day ranks: peak ranks 0 (hi), trough ranks 0 (lo)", test_da_peak_and_trough_ranks)
R.add("charge: SoC += grid·etaLeg; paid-to-charge ⇒ +rev; cost basis", test_charge_efficiency_and_costbasis)
R.add("power cap: grid-side charge ≤ Pmax·0.25 per ISP", test_power_cap_limits_throughput)
R.add("whole-MW: daSell / mFRR / charge volumes are integers", test_whole_mw_market_volumes)
R.add("min-delta gate blocks thin discharge, passes above gate", test_min_delta_blocks_thin_discharge)
R.add("red zones bound discretionary discharge at the lower red", test_red_zones_bound_discretionary)
R.add("dwell-time suppresses a discharge right after a charge", test_dwell_blocks_fast_flip)
R.add("dwell enforces a real rest (opposite starts >= dwell ISPs apart)", test_dwell_enforces_rest_between_opposite_phases)
R.add("must-fulfil: SoC never sized out of [0, cap] over random prices", test_must_fulfil_no_soc_violation_random)
R.add("price-aware charging skips an above-ceiling side, uses the usable one", test_charge_price_aware_skips_above_ceiling)
R.add("day-ahead buy-low fires at a committed forecast trough", test_da_buy_low_committed_at_trough)
R.add("opportunistic divert KEEPS DA revenue, closes on intraday (no imbalance)", test_opportunistic_keeps_da_and_uses_intraday)
R.add("opportunistic MISS: buy-back committed, energy retained, spread paid", test_opportunistic_miss_pays_the_spread_and_keeps_energy)
R.add("reactive ask: rests on a stall, clears FULL volume on continuation", test_reprice_rests_on_stall_and_clears_on_continuation)
R.add("NO FUTURE LEAKAGE: same-ISP price shocks never change placed offers", test_no_future_leakage_perturbation)
R.add("per-leg ask gate: no below-margin clears via the other market's gate", test_ask_gates_each_leg_no_below_margin_clears)
R.add("red-zone time audit: pinned-at-boundary + in-zone ISPs counted", test_redzone_time_counters)
R.add("sensitivity math: OAT weight / 1%-band / shape / edge / sharp", test_sens_weight_band_shape)
R.add("sensitivity math: Spearman rho incl. tie handling", test_sens_spearman)
R.add("sensitivity math: interaction score ranks multiplicative pairs first", test_sens_interaction_detection)
R.add("sensitivity on engine: static-split wait is weightless, da_mw is not", test_sens_engine_oat_inert_vs_live_params)
R.add("real data: rev == Σ decomposed components", test_rev_equals_component_sum)
R.add("real data: SoC ∈ [0, cap]; no balancing over-sizing", test_soc_bounds_real)
R.add("real data: day-type partition all == workday + weekend/holiday", test_daytype_partition_exact)
R.add("strategy-off: charging off ⇒ 0 charged & discharge ≤ initial usable", test_charging_off_no_charge)
R.add("strategy-off: DA off ⇒ no DA sell/buy legs", test_da_off_no_da_legs)
R.add("strategy-off: dynamic discharge off ⇒ no repriced bids", test_dynamic_discharge_off_no_repricing)
R.add("strategy-off: opportunistic off ⇒ no intraday close leg", test_opportunistic_off_no_intraday_leg)
R.add("both splits static (step=0) collapse to all-mFRR (=1)", test_both_splits_static_collapse_to_one)
R.add("frozen default-config revenue + must-fulfil = 0 (prints value)", test_frozen_default_revenue)


def test_every_test_function_is_registered():
    """Meta-guard: every module-level test_* function must be R.add-registered.

    Registration is a separate manual step, so a written-but-unregistered test
    silently never runs (this orphaned seven reserve-up tests in tests.py).
    """
    registered = {fn for _, fn in R.tests}
    orphans = sorted(
        name for name, obj in globals().items()
        if name.startswith("test_") and callable(obj) and obj not in registered
    )
    assert not orphans, f"defined but never registered: {orphans}"


R.add("meta: every test_* function is registered with the runner", test_every_test_function_is_registered)

if __name__ == "__main__":
    sys.exit(R.run())
