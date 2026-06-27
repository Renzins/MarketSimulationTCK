"""
tests_bess.py — audit / regression suite for the BESS backtester (bess-engine.js).

A SEPARATE suite from tests.py. Faithful PYTHON MIRROR of bess-engine.js's
stateful state-of-charge loop, exercised three ways:

  A. FORECAST     — lag-24h (96-ISP) DA forecast + per-day peak/trough ranks.
  B. CORE MECHANICS (synthetic, hand-computed) — whole-MW offers, round-trip
     efficiency, cost-basis + min-delta gate, power cap, SoC bounds, red zones,
     dwell, must-fulfil, price-aware charging, day-ahead buy-low, opportunistic
     divert (keeps DA revenue, closes on intraday only — no imbalance clairvoyance).
  C. REAL DATA    — rev == Σ components, SoC ∈ [0,cap], whole-MW market volumes,
     day-type partition, strategy-off neutrality, frozen default revenue.

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
EPS = 1e-9
E4 = 0.25  # hours per ISP

# Cross-checked against the browser JS (BessEngine) at the default config over
# the full dataset. Re-freeze after any engine change (the test prints the value).
# Cross-checked against the browser JS (BessEngine) at the default config over
# the full dataset (opportunistic divert is mFRR-up only).
FROZEN_DEFAULT_REVENUE_EUR = 2944157.09


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


def day_type_mask(data):
    n = data["n"]
    start_ms = _iso_ms(data["start_iso"])
    step_ms = data["step_min"] * 60000
    mask = np.zeros(n, dtype=np.uint8)
    for i in range(n):
        dow = (((start_ms + int(data["offsets"][i]) * step_ms) // 86400000) + 4) % 7  # getUTCDay
        mask[i] = 1 if dow in (0, 6) else 0
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
        s_up_step=(c01(num("s_up_step", 0)) if split_on else 0.0),
        s_dn_step=(c01(num("s_dn_step", 0)) if split_on else 0.0),
        daOn=da_on, da_min_price=num("da_min_price", 100), da_charge_price=num("da_charge_price", 0),
        da_n_periods=max(0, int(params.get("da_n_periods", 0) or 0)) if da_on else 0,
        da_mw=max(0, int(math.floor(num("da_mw", 20)))),
        chargeOn=charge_on, max_charge_price=num("max_charge_price", 20) if charge_on else -1e9,
        ddOn=dd_on, dd_lookback=max(1, int(params.get("dd_lookback", 4) or 4)),
        dd_threshold=max(0.0, num("dd_threshold", 20)), dd_hold=(c01(num("dd_hold", 0.5)) if dd_on else 0.0),
        oppOn=opp_on, opp_threshold=(max(0.0, num("opp_threshold", 100)) if opp_on else 1e9),
        dayTypeFilter=params.get("dayTypeFilter", "all"),
    )


def _split_blocks(start, win, step, fxM, fxA, upto, n):
    w = 1 if win < 1 else int(win)
    nB = max(1, (max(1, upto) - 1) // w + 1)
    blocks = np.zeros(nB)
    s = 0.0 if start < 0 else (1.0 if start > 1 else start)
    blocks[0] = s
    for k in range(1, nB):
        if step > 0:
            lo, hi = (k - 1) * w, min(k * w, n)
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
    return blocks, w


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
    up, upW = _split_blocks(p["s_up_start"], p["s_up_win"], p["s_up_step"], pUM, pUA, we, n)
    dn, dnW = _split_blocks(p["s_dn_start"], p["s_dn_win"], p["s_dn_step"], pDM, pDA, we, n)
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

    soc, cb, mode, last_flip = p["socInit"], 0.0, 0, -(1 << 20)
    total = 0.0
    b = dict(DA=0.0, mFRR_up=0.0, aFRR_up=0.0, mFRR_dn=0.0, aFRR_dn=0.0, intraday=0.0, charge=0.0, imb=0.0, flat=0.0)
    c = dict(discharge=0, charge=0, idle=0, daCleared=0, upMfrr=0, upAfrr=0, dnMfrr=0, dnAfrr=0,
             withdrawn=0, short=0, unfulfilled=0, at0=0, atFull=0)
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

        mfrrUp = P_mfrr >= 1
        afrrUp = Apos > 0
        bestUp = max(P_mfrr if mfrrUp else -math.inf, Apos if afrrUp else -math.inf)

        da_dis = p["daOn"] and rhi[i] < p["da_n_periods"] and fc[i] >= p["da_min_price"] and P_da >= p["da_min_price"]
        da_buy = (not da_dis) and p["daOn"] and rlo[i] < p["da_n_periods"] and fc[i] <= p["da_charge_price"] and P_da <= p["da_charge_price"]

        if da_dis:
            dir_ = 1
            commitMW = min(p["da_mw"], eMaxMW)
            maxDelivMW = math.floor(min(budgetMW, (soc * eta) / E4))
            delivMW = min(commitMW, maxDelivMW)
            if delivMW > 0:
                soc -= delivMW * E4 / eta
                budgetMW -= delivMW
                cDA += delivMW * E4 * P_da
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
            if chgMW > 0:
                stored = chgMW * E4 * eta
                cb = (cb * soc + P_da * chgMW * E4) / (soc + stored)
                soc += stored
                budgetMW -= chgMW
                cChg -= chgMW * E4 * P_da
                chgOtherMW += chgMW

        mfrrDn = P_mfrr <= -1
        afrrDn = Aneg < 0
        mfrrChgU = mfrrDn and P_mfrr <= ceiling
        afrrChgU = afrrDn and Aneg <= ceiling
        idChgU = (not math.isnan(Vwap)) and Vwap <= ceiling
        bestChg = math.inf
        for ok, pr in ((mfrrChgU, P_mfrr), (afrrChgU, Aneg), (idChgU, Vwap)):
            if ok and pr < bestChg:
                bestChg = pr
        anyChgU = mfrrChgU or afrrChgU or idChgU

        dischargeOK = soc > loRed + EPS and budgetMW >= 1 and bestUp > -math.inf and bestUp >= effCost + minDelta
        chargeOK = soc < hiRed - EPS and budgetMW >= 1 and anyChgU
        can_flip = lambda want: mode == 0 or mode == want or (i - last_flip) >= dwell

        if da_charge_committed:
            pass
        elif dir_ == 1:
            pass
        elif dischargeOK and chargeOK:
            if mode == -1 and (i - last_flip) < dwell:
                dir_ = -1
            elif mode == 1 and (i - last_flip) < dwell:
                dir_ = 1
            else:
                dir_ = 1 if (bestUp - effCost) >= (ceiling - bestChg) else -1
        elif dischargeOK and can_flip(1):
            dir_ = 1
        elif chargeOK and can_flip(-1):
            dir_ = -1

        # 3a. discharge leg (not budget-gated: opportunistic redirects already-
        # delivered DA energy; extra-discharge below is self-gated by availMW)
        if dir_ == 1 and not da_charge_committed:
            # divert only into mFRR-up (binary/full); never aFRR (partial)
            if p["oppOn"] and daSellMW > 0 and mfrrUp and not math.isnan(Vwap) and (P_mfrr - Vwap) >= p["opp_threshold"]:
                e = daSellMW * E4
                cID -= e * Vwap
                cUpM += e * P_mfrr
                upMmw += daSellMW
                daSellMW = 0.0
            availMW = math.floor(min(budgetMW, (max(0.0, soc - loRed) * eta) / E4))
            if availMW > 0 and bestUp >= effCost + minDelta:
                hold = 0.0
                if p["ddOn"] and p["dd_hold"] > 0 and (i - p["dd_lookback"]) >= 0:
                    past = pmf[i - p["dd_lookback"]]
                    if not math.isnan(past) and (P_mfrr - past) >= p["dd_threshold"]:
                        hold = p["dd_hold"]
                offerMW = math.floor(availMW * (1 - hold))
                heldMW = availMW - offerMW
                if heldMW > 0:
                    bids.append((i, "mfrr", 1, "withdrawn"))
                    if accept:
                        c["withdrawn"] += 1
                if offerMW > 0:
                    toMfrr = sUp
                    if p["ddOn"] and afrrUp and mfrrUp and Apos > P_mfrr:
                        toMfrr = 0.0
                    routedMfrr = round(toMfrr * offerMW)
                    routedAfrr = offerMW - routedMfrr
                    budgetMW -= offerMW
                    if routedMfrr > 0 and mfrrUp:
                        soc -= routedMfrr * E4 / eta
                        cUpM += routedMfrr * E4 * P_mfrr
                        upMmw += routedMfrr
                    if routedAfrr > 0 and afrrUp:
                        disp = routedAfrr * (nposf[i] / 225)
                        soc -= disp * E4 / eta
                        cUpA += routedAfrr * E4 * Apos
                        upAmw += disp

        # 3b. charge leg
        if dir_ == -1 and not da_charge_committed and budgetMW >= 1 and chargeOK:
            headMW = math.floor(min(budgetMW, (hiRed - soc) / (E4 * eta)))
            if headMW > 0:
                mShare = round(sDn * headMW)
                aShare = headMW - mShare
                mMW = mShare if mfrrChgU else 0
                aMW = aShare if afrrChgU else 0
                if (not mfrrChgU) and afrrChgU:
                    aMW += mShare
                elif mfrrChgU and (not afrrChgU):
                    mMW += aShare
                idMW = headMW - mMW - aMW
                if not idChgU:
                    idMW = 0
                if mMW > 0:
                    stored = mMW * E4 * eta
                    cb = (cb * soc + P_mfrr * mMW * E4) / (soc + stored)
                    soc += stored
                    cDnM -= mMW * E4 * P_mfrr
                    dnMmw += mMW
                if aMW > 0:
                    absorbed = aMW * (nnegf[i] / 225)
                    stored = absorbed * E4 * eta
                    if soc + stored > 0:
                        cb = (cb * soc + Aneg * aMW * E4) / (soc + stored)
                    soc += stored
                    cDnA -= aMW * E4 * Aneg
                    dnAmw += absorbed
                if idMW > 0:
                    stored = idMW * E4 * eta
                    cb = (cb * soc + Vwap * idMW * E4) / (soc + stored)
                    soc += stored
                    cChg -= idMW * E4 * Vwap
                    chgOtherMW += idMW
                budgetMW -= mMW + aMW + idMW

        if soc < -1e-6 or soc > cap + 1e-6:
            max_viol = max(max_viol, abs(soc - min(max(soc, 0), cap)))
        soc = 0.0 if soc < 0 else (cap if soc > cap else soc)

        rev = cDA + cUpM + cUpA + cDnM + cDnA + cID + cChg - cImb - cFlat
        netDis = daSellMW + upMmw + upAmw
        netChg = dnMmw + dnAmw + chgOtherMW
        ispDir = 1 if netDis > 1e-6 else (-1 if netChg > 1e-6 else 0)
        if ispDir != 0 and ispDir != mode:
            last_flip = i
            mode = ispDir

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
        if soc <= 1e-6: c["at0"] += 1
        if soc >= cap - 1e-6: c["atFull"] += 1
        c["discharge" if ispDir == 1 else ("charge" if ispDir == -1 else "idle")] += 1

    return dict(total=total, breakdown=b, counts=c, mwhDischarged=mwhDis, mwhCharged=mwhChg,
                shortMWh=shortMWh, finalSoc=soc, soc=np.asarray(socs), rev=np.asarray(revs),
                filtered_rev=np.asarray(fr), daSell=np.asarray(daSells), upM=np.asarray(upMs),
                dnM=np.asarray(dnMs), chgOther=np.asarray(chgOs), bids=bids, max_balancing_violation=max_viol)


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
    s_up_start=1, s_up_win=96, s_up_step=0, s_dn_start=1, s_dn_win=96, s_dn_step=0,
    da_min_price=100, da_charge_price=0, da_n_periods=8, da_mw=20, max_charge_price=20,
    dd_lookback=4, dd_threshold=20, dd_hold=0.5, opp_threshold=100,
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
    A = synth(1, p_mfrr=np.array([-10.0]))
    p = dict(DEFAULT_PARAMS, init_soc_pct=25, da_n_periods=0, max_charge_price=20,
             enabled=dict(split=False, daDischarge=False, charging=True, dynamicDischarge=False, opportunistic=False))
    r = bess_run(A, p)
    eta = math.sqrt(0.9)
    soc0 = 0.25 * 40
    headMW = min(20, math.floor((0.8 * 40 - soc0) / (E4 * eta)))  # 20
    stored = headMW * E4 * eta
    assert abs(r["soc"][0] - (soc0 + stored)) < 1e-6
    assert abs(r["total"] - (headMW * E4 * 10.0)) < 1e-6, "paid 10/MWh to absorb ⇒ +revenue"
    assert r["counts"]["dnMfrr"] == 1


def test_power_cap_limits_throughput():
    A = synth(1, p_mfrr=np.array([-10.0]))
    p = dict(DEFAULT_PARAMS, power_mw=20, init_soc_pct=10, da_n_periods=0,
             enabled=dict(split=False, daDischarge=False, charging=True, dynamicDischarge=False, opportunistic=False))
    r = bess_run(A, p)
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
    A = synth(2, p_mfrr=np.array([-50.0, 300.0]))
    p = dict(DEFAULT_PARAMS, init_soc_pct=50, dwell_isps=4, min_delta=0, da_n_periods=0, max_charge_price=20,
             enabled=dict(split=False, daDischarge=False, charging=True, dynamicDischarge=False, opportunistic=False))
    assert bess_run(A, p)["mwhDischarged"] == 0


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
    # Split off (sDn=1) routes to mFRR, but its share falls back to aFRR.
    A = synth(1, p_mfrr=np.array([-2.0]), avg_p_neg=np.array([-80.0]))
    p = dict(DEFAULT_PARAMS, init_soc_pct=20, da_n_periods=0, max_charge_price=-50,
             enabled=dict(split=False, daDischarge=False, charging=True, dynamicDischarge=False, opportunistic=False))
    r = bess_run(A, p)
    eta = math.sqrt(0.9)
    headMW = min(20, math.floor((0.8 * 40 - 0.2 * 40) / (E4 * eta)))
    assert r["counts"]["dnAfrr"] == 1 and r["counts"]["dnMfrr"] == 0, "must avoid the above-ceiling mFRR side"
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
    # DA-sold peak + balancing spike ⇒ divert: KEEP DA revenue, close on intraday.
    A = synth(1, p_da=np.array([200.0]), p_mfrr=np.array([400.0]), vwap_1h=np.array([100.0]),
              fc=np.array([200.0]), rank_hi=np.array([0], dtype=np.int64))
    p = dict(DEFAULT_PARAMS, init_soc_pct=100, min_delta=0, da_min_price=100, da_n_periods=8, da_mw=20,
             opp_threshold=100,
             enabled=dict(split=False, daDischarge=True, charging=False, dynamicDischarge=False, opportunistic=True))
    r = bess_run(A, p)
    bd = r["breakdown"]
    # 20 MW × 0.25 h delivered: DA kept = 1000, balancing = 5×400 = 2000, intraday close = −5×100 = −500
    assert abs(bd["DA"] - 1000) < 1e-6, "DA revenue must be KEPT on divert"
    assert abs(bd["mFRR_up"] - 2000) < 1e-6
    assert abs(bd["intraday"] - (-500)) < 1e-6, "close on intraday only (imbalance never chosen)"
    assert abs(r["total"] - 2500) < 1e-6


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


def test_dynamic_discharge_off_no_withdrawals():
    r = bess_run(real_ctx()["A"], dict(DEFAULT_PARAMS, enabled=dict(DEFAULT_PARAMS["enabled"], dynamicDischarge=False)))
    assert r["counts"]["withdrawn"] == 0


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
R.add("must-fulfil: SoC never sized out of [0, cap] over random prices", test_must_fulfil_no_soc_violation_random)
R.add("price-aware charging skips an above-ceiling side, uses the usable one", test_charge_price_aware_skips_above_ceiling)
R.add("day-ahead buy-low fires at a committed forecast trough", test_da_buy_low_committed_at_trough)
R.add("opportunistic divert KEEPS DA revenue, closes on intraday (no imbalance)", test_opportunistic_keeps_da_and_uses_intraday)
R.add("real data: rev == Σ decomposed components", test_rev_equals_component_sum)
R.add("real data: SoC ∈ [0, cap]; no balancing over-sizing", test_soc_bounds_real)
R.add("real data: day-type partition all == workday + weekend/holiday", test_daytype_partition_exact)
R.add("strategy-off: charging off ⇒ 0 charged & discharge ≤ initial usable", test_charging_off_no_charge)
R.add("strategy-off: DA off ⇒ no DA sell/buy legs", test_da_off_no_da_legs)
R.add("strategy-off: dynamic discharge off ⇒ no withdrawn bids", test_dynamic_discharge_off_no_withdrawals)
R.add("strategy-off: opportunistic off ⇒ no intraday close leg", test_opportunistic_off_no_intraday_leg)
R.add("both splits static (step=0) collapse to all-mFRR (=1)", test_both_splits_static_collapse_to_one)
R.add("frozen default-config revenue + must-fulfil = 0 (prints value)", test_frozen_default_revenue)

if __name__ == "__main__":
    sys.exit(R.run())
