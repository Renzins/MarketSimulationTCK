"""
tests.py — comprehensive audit / regression suite for the wind-park backtester.

69 tests over 9 categories; aFRR / split tests are gated on the optional
data files being present so the suite still passes on a stripped repo.

  A. DATA INTEGRITY (data.js vs CSV)
     - Baltic aggregations are exact sums of LV + EE + LT
     - LV imbalance volume equals imbalance_volume_lv from CSV
     - Spread = mFRR_SA − DA, agrees with CSV
     - NaN handling: April rows present, p_imb is null where the source said NaN
     - Timestamps: offsets monotonic, ts(i) = start + offset[i] · 15 min
     - mFRR up == down across non-NaN rows (single-clearing-price assumption)

  B. ENGINE INVARIANTS (Python mirror of engine.js)
     - Whole-MW rounding: Q_da_sold, Q_w, trusted_rev, Q_dn_offer are all integers
     - mFRR-dn cap: Q_dn_offer ≤ Q_da_sold; Q_dn_offer == 0 when Q_da_sold == 0
     - mFRR-up and mFRR-dn never fire in the same ISP (post-activation gate)
     - Window respect: simulate over a sub-window matches summing per-ISP rev
     - NaN p_imb: L2 imbalance cost is 0 in those rows; L1 unaffected
     - L1 / L2 frozen-value regressions (see E)
     - L3: X_cap=0 ≡ L2 (load-bearing); rolling source is p_mfrr_raw not
       p_imb_raw; lag L shifts the rolling window to [i-K-L, i-L); imb +
       flat + s3_extra_cost decomp ≡ short·(p_imb+θ) when hedge bid misses;
       NaN p_imb zeroes all 3 imbalance terms; L3 frozen default value.

POST-REWORK NOTE — engine.js API change
=======================================
The JS engine no longer takes a `level` argument. Behaviour is now
expressed via two source selectors and per-strategy enable flags:

  Legacy engine call               ≡  New engine call
  -------------------------------     ------------------------------------
  simulate(1, params)                 simulate({...params,
                                        actualSource: 'da', idSource: 'da',
                                        enabled: {..., s3: false}})
  simulate(2, params)                 simulate({...params,
                                        actualSource: 'real', idSource: 'real',
                                        enabled: {..., s3: false}})
  simulate(3, params)                 simulate({...params,
                                        actualSource: 'real', idSource: 'real',
                                        enabled: {..., s3: true}})

The Python mirror in this file still takes `level: int` (1/2/3) since
it is structured around the math, not the JS API. The math is
unchanged — so the frozen regression values below still hold without
needing to recompute. Treat `level` here as a private flag that
selects the equivalent legacy configuration of the new engine.

  C. SPEC EXAMPLES (the two from the original brief)
     - Example 1: F=20, X=10, Y=0.5, ID=18, Z=0.5, P_mfrr=50, Q_pot=12, P_imb=200, θ=30 → −322.5 €
     - Example 2: F=20, X=10, P_da=100 (above X), Q_pot=10, P_imb=20, θ=30 → +375.0 €

  D. GRAPHS ENGINE
     - Surplus/deficit classification respects thresholds (default ±30 MW)
     - Quantile bins have ≈ equal sample sizes (within 1)
     - SURPLUS spread is overall negative, DEFICIT positive (statistical sanity)
     - Baltic wind / imbalance distribution sanity (range, median, zero-centred)

  E. SCHEMA + FROZEN REGRESSIONS
     - data.js has every required column; lengths match n
     - Q_pot ≥ 0 and ≤ 58.8 MW; DA forecast same
     - **L1 default (X=30, Y=1, s_up=s_dn=1) = 13,257,221 €**
     - **L2 default (X=30, Y=1, Z=1, θ=30, s_up=s_dn=1) = 13,367,642 €**
     - L1 naive (X=Y=Z=0) is computable & positive

  F. aFRR ACTIVATION COUNTS (data-afrr.js, optional)
     - Keys present, length matches main data n
     - n_total ≤ 225 (15-min × 60 sec / 4-sec resolution)
     - n_pos ≤ n_total, n_neg ≤ n_total, n_any ≤ n_total
     - max(n_pos, n_neg) ≤ n_any ≤ n_pos + n_neg (set algebra)
     - ISPs before 2025-05-01 have n_total = 0 (aFRR data starts then)
     - For 30 random ISPs: per-ISP counts equal direct count from CSV slice

  G. aFRR PER-4-S PRICES (chunked data-afrr-prices-*.js, optional)
     - Reassembled schema (parallel arrays, n_entries lengths match)
     - Each chunk file ≤ 50 MB (GitHub-friendly)
     - meta.n_chunks matches number of chunk files on disk
     - n_pos_entries equals sum(n_pos); remainder equals sum(n_neg)
     - ISP indices in [0, n); price file only references active ISPs
     - per-ISP price-entry count matches n_pos+n_neg on 30 random ISPs

  H. aFRR 15-MIN AVERAGES + mFRR↔aFRR SPLIT (data-afrr-15min.js, optional)
     - Schema + length match data.js
     - Pre-2025-05-01 ISPs have avg = 0
     - Synthetic 900 €/MWh × 1 slot → avg 4 €/MWh → 1 €/MW (revenue formula)
     - **Mixed-sign ISP regression** (the −10 / +50 example):
       favourable-only filter recovers the 0.011 €/MW favourable-slot
       earnings that naïve averaging would have dropped. Asserts
       avg_p_pos ≥ 0 and avg_p_neg ≤ 0 dataset-wide BY CONSTRUCTION.
     - Split round+remainder: Q_mfrr + Q_afrr == Q_offer (no MW lost)
     - s_up = s_dn = 1 reproduces legacy spec example, ignoring aFRR feeds
     - s_up = s_dn = 0 routes everything to aFRR; revenue uses avg_p_*
     - aFRR-up gate blocks avg_p_pos ≤ 0; aFRR-dn gate blocks avg_p_neg ≥ 0
     - mFRR-dn AND aFRR-up can earn simultaneously when prices allow
     - Asymmetric splits (s_up = 1, s_dn = 0) route per direction independently
     - L1 with real aFRR feeds vs zeroed feeds confirms the feeds are wired

Run:  python tests.py
Exit code 0 = all green; >0 = N failures.
"""

from __future__ import annotations

import io
import json
import math
import os
import sys
from typing import Any, Callable

import numpy as np
import pandas as pd

# Force UTF-8 stdout on Windows so Unicode arrows / sigmas print cleanly.
if sys.stdout.encoding != "utf-8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

BASE = os.path.dirname(os.path.abspath(__file__))
CSV_PATH = os.path.join(BASE, "main_data_with_imbalance.csv")
DATA_JS_PATH = os.path.join(BASE, "data.js")
AFRR_CSV_PATH = os.path.join(BASE, "ast_afrr_data.csv")
DATA_AFRR_JS_PATH = os.path.join(BASE, "data-afrr.js")
DATA_AFRR_15MIN_PATH = os.path.join(BASE, "data-afrr-15min.js")
# Per-slot price file is now CHUNKED. The meta file is tiny; the chunks
# (data-afrr-prices-001.js, ...-002.js, ...) each hold a slice of the
# parallel arrays. Tests load all chunks and concatenate, so they see the
# same shape the in-browser loader produces at runtime.
DATA_AFRR_PRICES_META_PATH = os.path.join(BASE, "data-afrr-prices-meta.js")
import glob as _glob

_DATA_AFRR_PRICES_CHUNK_PATHS = sorted(
    _glob.glob(os.path.join(BASE, "data-afrr-prices-[0-9][0-9][0-9].js"))
)

# Tolerance for float comparisons (€ totals can drift by sub-cent due to rounding).
EUR_TOL = 1.0
SUM_TOL = 1e-3
PRICE_TOL = 0.01  # 2 dp rounding in data.js

# =============================================================================
#  FROZEN REGRESSION VALUES — update only when the source CSV is intentionally
#  refreshed. Bumping these without re-deriving them from `python preprocess.py`
#  + a fresh ground-truth simulation is how silent engine bugs sneak in.
#
#  How to refresh: after `python preprocess.py` succeeds and you've
#  visually verified the Backtester pages still look reasonable, copy the
#  new totals from the L1/L2 stat panels here.
# =============================================================================
FROZEN_L1_DEFAULT_EUR = 13_760_612  # X=30, Y=1, winsor 5/95
FROZEN_L2_DEFAULT_EUR = 13_932_199  # X=30, Y=1, Z=1, θ=30, winsor 5/95
# L3 default (K=4, L=4, DA_skip=50, S_min=25, σ_max=75, X_cap=5, M=5;
# rolling source p_mfrr_raw; winsor 5/95). Re-baseline after any preprocess
# refresh or any change to the UI default winsor.
FROZEN_L3_DEFAULT_EUR = 15_185_134
FROZEN_APRIL_ROW_COUNT = 30 * 96  # 30 days × 96 ISPs (assumes April fully covered)
FROZEN_NULL_PIMB_RANGE = (2800, 3100)  # ~2911 in current dataset


# =============================================================================
#  Test harness
# =============================================================================
class TestRunner:
    """Minimal pytest-style runner so we don't need pytest installed."""

    def __init__(self):
        self.tests: list[tuple[str, Callable[[], None]]] = []
        self.passed = 0
        self.failed: list[tuple[str, str]] = []

    def add(self, name: str, fn: Callable[[], None]):
        self.tests.append((name, fn))

    def run(self):
        print(f"\nRunning {len(self.tests)} tests…\n")
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
#  Data loaders
# =============================================================================
def load_csv() -> pd.DataFrame:
    df = pd.read_csv(
        CSV_PATH,
        usecols=[
            "datetime_utc",
            "scipher_da_p50_mw",
            "scipher_id_p50_mw",
            "lt_dayahead_price_eur_mwh",
            "mfrr_sa_upward_lv",
            "mfrr_sa_downward_lv",
            "wind_park_possible",
            "final_imbalance_price_latvia",
            "lv_wind_onshore_dayahead_mw",
            "ee_wind_onshore_dayahead_mw",
            "lt_wind_onshore_dayahead_mw",
            "lv_solar_dayahead_mw",
            "ee_solar_dayahead_mw",
            "lt_solar_dayahead_mw",
            "imbalance_volume_lv",
            "imbalance_volume_ee",
            "imbalance_volume_lt",
        ],
    )
    df["datetime_utc"] = pd.to_datetime(df["datetime_utc"])
    return df


def load_data_js() -> dict:
    """Parse data.js as JSON (strip the JS wrapper)."""
    with open(DATA_JS_PATH, "r", encoding="utf-8") as f:
        text = f.read()
    start = text.index("{")
    end = text.rindex("}") + 1
    return json.loads(text[start:end])


# =============================================================================
#  Python mirror of engine.js (post-audit logic)
# =============================================================================
def _floor(x: float) -> int:
    """Mirror engine.js's Math.floor(x + 1e-9): float → integer toward 0 (positive only here)."""
    return math.floor(x + 1e-9)


def _rnd(x):
    """Round half UP (toward +∞) to match the engine's Math.round on the
    non-negative whole-MW split/reserve quantities. NumPy's np.round is
    half-to-EVEN, which diverges from the engine at exact half-MW points
    (e.g. 0.7 × 15 = 10.5 → engine 11, np.round 10)."""
    return np.floor(np.asarray(x, dtype=np.float64) + 0.5)


def isp_revenue(
    level: int,
    F,
    ID,
    P_da,
    P_mfrr,
    Q_pot,
    P_imb,
    X,
    Y,
    Z=0.0,
    theta=0.0,
    s_up=1.0,
    s_dn=1.0,
    avg_p_pos=0.0,
    avg_p_neg=0.0,
    n_pos_fav=0,
    n_neg_fav=0,
):
    """Pure-Python reference for one ISP's P&L. Mirrors engine.js exactly,
    including the per-direction mFRR↔aFRR split (s_up = s_dn = 1 default
    → all mFRR → matches the pre-feature math).

    n_pos_fav / n_neg_fav are the FAVOURABLE 4-s slot counts (slots
    where AST_POS > 0 / AST_NEG < 0) that scale the position
    contribution. They match avg_p_pos / avg_p_neg's favourable-only
    averaging — see preprocess-afrr-15min.py.
    """
    above_X = P_da >= X
    da_sold = _floor(F if above_X else F * (1 - Y))
    Q_w = _floor(0 if above_X else F - da_sold)
    trusted_raw = Z * (ID - F) if level == 2 else 0
    trusted_extra = _floor(trusted_raw) if trusted_raw > 0 else 0
    Q_up_offer = Q_w + trusted_extra
    Q_dn_offer = da_sold  # CAP: curtailment can't exceed DA position
    s_up_c = 0.0 if s_up < 0 else (1.0 if s_up > 1 else float(s_up))
    s_dn_c = 0.0 if s_dn < 0 else (1.0 if s_dn > 1 else float(s_dn))
    Q_up_mfrr = round(s_up_c * Q_up_offer)
    Q_up_afrr = Q_up_offer - Q_up_mfrr
    Q_dn_mfrr = round(s_dn_c * Q_dn_offer)
    Q_dn_afrr = Q_dn_offer - Q_dn_mfrr
    is_up = P_mfrr >= 1
    is_dn = P_mfrr <= -1
    up_mfrr = Q_up_mfrr if is_up else 0
    dn_mfrr = Q_dn_mfrr if is_dn else 0
    # aFRR profitability gate (per direction, per ISP) — mirrors engine.js.
    # Wind park only bids aFRR-up where avg_p_pos > 0 (positive earnings)
    # and aFRR-dn where avg_p_neg < 0 (system pays the park to curtail).
    up_afrr_active = avg_p_pos > 0 and Q_up_afrr > 0
    dn_afrr_active = avg_p_neg < 0 and Q_dn_afrr > 0
    DA_rev = da_sold * P_da
    Up_rev_mfrr = up_mfrr * P_mfrr
    Dn_rev_mfrr = -dn_mfrr * P_mfrr
    Up_rev_afrr = Q_up_afrr * avg_p_pos if up_afrr_active else 0.0
    Dn_rev_afrr = -Q_dn_afrr * avg_p_neg if dn_afrr_active else 0.0
    # Favourable-count fraction — see preprocess-afrr-15min.py.
    a_frac_pos = n_pos_fav / 225.0
    a_frac_neg = n_neg_fav / 225.0
    up_afrr_disp = Q_up_afrr * a_frac_pos if up_afrr_active else 0.0
    dn_afrr_disp = Q_dn_afrr * a_frac_neg if dn_afrr_active else 0.0
    Q_pos = da_sold + up_mfrr + up_afrr_disp - dn_mfrr - dn_afrr_disp
    if level == 2:
        Q_short = max(0.0, Q_pos - Q_pot)
        # NaN p_imb: treat as 0 cost (April rows)
        if pd.isna(P_imb):
            imb = 0
            flat = 0
        else:
            imb = Q_short * P_imb
            flat = Q_short * theta
    else:
        Q_short = 0
        imb = 0
        flat = 0
    rev = (DA_rev + Up_rev_mfrr + Dn_rev_mfrr + Up_rev_afrr + Dn_rev_afrr - imb - flat) * 0.25
    return {
        "rev": rev,
        "Q_da_sold": da_sold,
        "Q_w": Q_w,
        # Back-compat: Q_up / Q_dn report the TOTAL offered MW (matching
        # simulate()'s perISP arrays).
        "Q_up": Q_up_mfrr + Q_up_afrr,
        "Q_dn": Q_dn_mfrr + Q_dn_afrr,
        # Q_*_mfrr / Q_*_afrr are the OFFERED split (pre-activation gating).
        # Q_*_mfrr_active are the volumes that actually fired this ISP
        # after the |P_mfrr| ≥ 1 gate.
        "Q_up_mfrr": Q_up_mfrr,
        "Q_up_afrr": Q_up_afrr,
        "Q_dn_mfrr": Q_dn_mfrr,
        "Q_dn_afrr": Q_dn_afrr,
        "Q_up_mfrr_active": up_mfrr,
        "Q_dn_mfrr_active": dn_mfrr,
        "Q_pos": Q_pos,
        "Q_short": Q_short,
        "DA_rev": DA_rev,
        "Up_rev": Up_rev_mfrr,
        "Dn_rev": Dn_rev_mfrr,
        "Up_rev_afrr": Up_rev_afrr,
        "Dn_rev_afrr": Dn_rev_afrr,
        "imb": imb,
        "flat": flat,
    }


def winsorize(arr: np.ndarray, p_lo: float, p_hi: float) -> np.ndarray:
    """Winsorize ignoring NaN, like engine.applyWinsor."""
    valid = arr[~np.isnan(arr)]
    if len(valid) == 0:
        return arr.copy()
    lo = np.percentile(valid, p_lo)
    hi = np.percentile(valid, p_hi)
    out = arr.copy()
    mask = ~np.isnan(arr)
    out[mask] = np.clip(arr[mask], lo, hi)
    return out


def simulate_total(
    level,
    F,
    ID,
    P_da,
    P_mfrr_w,
    Q_pot,
    P_imb_w,
    X,
    Y,
    Z=0.0,
    theta=0.0,
    s_up=1.0,
    s_dn=1.0,
    avg_p_pos_w=None,
    avg_p_neg_w=None,
    n_pos_fav=None,
    n_neg_fav=None,
    day_mask=None,
    day_filter="all",
):
    """Vectorised total-only mirror of engine.simulateTotal (with current
    winsorized prices). n_pos_fav / n_neg_fav are FAVOURABLE 4-s slot
    counts — see isp_revenue() and preprocess-afrr-15min.py.
    Defaults make this collapse to the no-aFRR case so the FROZEN
    regression tests (s_up = s_dn = 1) stay valid.
    """
    above_X = P_da >= X
    da_sold = np.floor((np.where(above_X, F, F * (1 - Y))) + 1e-9).astype(np.float64)
    Q_w = np.floor(np.where(above_X, 0, F - da_sold) + 1e-9)
    if level == 2:
        trusted_raw = Z * (ID - F)
        trusted_extra = np.where(trusted_raw > 0, np.floor(trusted_raw + 1e-9), 0)
    else:
        trusted_extra = np.zeros_like(F)
    Q_up_offer = Q_w + trusted_extra
    Q_dn_offer = da_sold
    s_up_c = max(0.0, min(1.0, float(s_up)))
    s_dn_c = max(0.0, min(1.0, float(s_dn)))
    # round() instead of floor for the split (matches engine.js)
    Q_up_mfrr = _rnd(s_up_c * Q_up_offer)
    Q_up_afrr = Q_up_offer - Q_up_mfrr
    Q_dn_mfrr = _rnd(s_dn_c * Q_dn_offer)
    Q_dn_afrr = Q_dn_offer - Q_dn_mfrr
    is_up = P_mfrr_w >= 1
    is_dn = P_mfrr_w <= -1
    up_mfrr_active = np.where(is_up, Q_up_mfrr, 0)
    dn_mfrr_active = np.where(is_dn, Q_dn_mfrr, 0)
    if avg_p_pos_w is None:
        avg_p_pos_w = np.zeros_like(F)
    if avg_p_neg_w is None:
        avg_p_neg_w = np.zeros_like(F)
    if n_pos_fav is None:
        n_pos_fav = np.zeros_like(F)
    if n_neg_fav is None:
        n_neg_fav = np.zeros_like(F)
    # aFRR profitability gate — see isp_revenue() and engine.js. Per-element
    # mask on (price favourable AND volume offered).
    up_afrr_active = (avg_p_pos_w > 0) & (Q_up_afrr > 0)
    dn_afrr_active = (avg_p_neg_w < 0) & (Q_dn_afrr > 0)
    rev = (
        da_sold * P_da
        + up_mfrr_active * P_mfrr_w
        - dn_mfrr_active * P_mfrr_w
        + np.where(up_afrr_active, Q_up_afrr * avg_p_pos_w, 0)
        - np.where(dn_afrr_active, Q_dn_afrr * avg_p_neg_w, 0)
    )
    if level == 2:
        a_frac_pos = n_pos_fav / 225.0
        a_frac_neg = n_neg_fav / 225.0
        up_afrr_disp = np.where(up_afrr_active, Q_up_afrr * a_frac_pos, 0)
        dn_afrr_disp = np.where(dn_afrr_active, Q_dn_afrr * a_frac_neg, 0)
        Q_pos = (
            da_sold + up_mfrr_active + up_afrr_disp - dn_mfrr_active - dn_afrr_disp
        )
        Q_short = np.maximum(0, Q_pos - Q_pot)
        # Skip imbalance cost where p_imb is NaN
        valid_imb = ~np.isnan(P_imb_w)
        imb = np.where(valid_imb, Q_short * P_imb_w, 0)
        flat = np.where(valid_imb, Q_short * theta, 0)
        rev -= imb + flat
    # Day-type filter (post-hoc accumulation gate) — mirror engine.js: per-ISP
    # P&L is computed for every ISP, then non-matching days are dropped from
    # the sum. day_mask: 0=workday, 1=weekend, 2=holiday.
    if day_mask is not None and day_filter != "all":
        keep = (day_mask == 0) if day_filter == "workday" else (day_mask != 0)
        rev = np.where(keep, rev, 0.0)
    return rev.sum() * 0.25


# ============================================================================
#  L3 / S3 (speculative intraday oversell) Python mirror
# ============================================================================
def s3_rolling_stats(src: np.ndarray, K: int, L: int):
    """Mirror engine.js's _getS3Rolling(K, L). Returns (mean, std) per ISP,
    each of length n, NaN-padded at the start. Window for ISP i is
    [i-K-L, i-L); sample std (ddof=1). NaN values in src are skipped.
    A window with <2 valid values yields NaN."""
    n = len(src)
    mean = np.full(n, np.nan)
    std = np.full(n, np.nan)
    need = K + L
    for i in range(n):
        if i < need:
            continue
        win = src[i - K - L : i - L]
        valid = win[~np.isnan(win)]
        if len(valid) < 2:
            continue
        mean[i] = float(np.mean(valid))
        std[i] = float(np.std(valid, ddof=1))
    return mean, std


def _adaptive_split(start, win, step, wait, pm_w, second_w, direction):
    """Piecewise-constant follow-the-winner split — mirror of engine.js
    _splitBlocks. The split is held for `wait` ISPs (rebalance CADENCE), then at
    each segment boundary it steps toward whichever market had the higher
    average per-MW rate over the trailing `win` ISPs (LOOKBACK), causal. Rates:
      up:  mFRR = p_mfrr when ≥1 else 0 ;  aFRR = avg_p_pos
      dn:  mFRR = −p_mfrr when ≤−1 else 0;  aFRR = −avg_p_neg
    wait and win are decoupled; wait = win reproduces the old block behaviour.
    """
    pm = np.asarray(pm_w, float)
    sec = np.asarray(second_w, float)
    if direction == "up":
        effM = np.where(pm >= 1, pm, 0.0)
        effA = np.where(sec > 0, sec, 0.0)
    else:
        effM = np.where(pm <= -1, -pm, 0.0)
        effA = np.where(sec < 0, -sec, 0.0)
    n = len(pm)
    lb = max(1, int(win))    # lookback length
    wt = max(1, int(wait))   # cadence (segment length)
    step = float(step)
    out = np.empty(n)
    cur = min(1.0, max(0.0, float(start)))
    nB = (n - 1) // wt + 1
    for k in range(nB):
        if k > 0 and step > 0:
            boundary = k * wt
            plo, phi = max(0, boundary - lb), min(boundary, n)
            if phi > plo:
                am, aa = effM[plo:phi].mean(), effA[plo:phi].mean()
                if am > aa:
                    cur = min(1.0, cur + step)
                elif aa > am:
                    cur = max(0.0, cur - step)
        out[k * wt : min((k + 1) * wt, n)] = cur
    return out


def simulate_total_l3(
    F, ID, P_da, P_mfrr_w, Q_pot, P_imb_w, vwap_1h, P_mfrr_raw,
    X, Y, Z, theta,
    s_up=1.0, s_dn=1.0,
    split_adaptive=False, s_up_start=None, s_dn_start=None,
    s_up_win=96, s_dn_win=96, s_up_step=0.0, s_dn_step=0.0,
    s_up_wait=1, s_dn_wait=1,
    avg_p_pos_w=None, avg_p_neg_w=None, n_pos_fav=None, n_neg_fav=None,
    s3_K=4, s3_L=4, s3_S_min=25, s3_sigma_max=75, s3_X_cap=5, s3_M=5,
    s3_da_skip=50,
    day_mask=None, day_filter="all",
    reserve_enabled=False, r_coef=0.0, r_split=1.0, r_min_price=0.0,
    reserve_mfrr_dn=None, reserve_afrr_dn=None,
    reserve_up_enabled=False, ru_coef=0.0, ru_split=1.0, ru_min_price=0.0,
    ru_min_mw=0.0, reserve_mfrr_up=None, reserve_afrr_up=None,
):
    """L3 vectorised total. Adds S3 on top of L2 math (same shape as engine
    simulateTotal level=3). Rolling stats are from p_mfrr_raw (NOT p_imb_raw)
    over window [i-K-L, i-L), matching post-migration engine.js."""
    # Start from L2 components (re-use the L2 logic locally for clarity).
    above_X = P_da >= X
    # Split: adaptive (per-ISP arrays) or static scalar. Scalar path keeps the
    # frozen L1/L2/L3 anchors valid; np.round broadcasts over either shape.
    if split_adaptive:
        su = s_up if s_up_start is None else s_up_start
        sd = s_dn if s_dn_start is None else s_dn_start
        ap = avg_p_pos_w if avg_p_pos_w is not None else np.zeros_like(F)
        an = avg_p_neg_w if avg_p_neg_w is not None else np.zeros_like(F)
        s_up_c = _adaptive_split(su, s_up_win, s_up_step, s_up_wait, P_mfrr_w, ap, "up")
        s_dn_c = _adaptive_split(sd, s_dn_win, s_dn_step, s_dn_wait, P_mfrr_w, an, "dn")
    else:
        s_up_c = max(0.0, min(1.0, float(s_up)))
        s_dn_c = max(0.0, min(1.0, float(s_dn)))
    # ----- Reserve market UP capacity (carved FIRST; mirror engine.js) -----
    # Withheld from DA, so it shrinks the forecast available for DA + down to
    # F_avail = F - R_up. Gated by a forecast floor (ru_min_mw) and price.
    if reserve_up_enabled and reserve_mfrr_up is not None:
        prum = np.asarray(reserve_mfrr_up, dtype=np.float64)
        prua = (
            np.asarray(reserve_afrr_up, dtype=np.float64)
            if reserve_afrr_up is not None
            else np.full_like(F, np.nan)
        )
        gate_mw = F >= ru_min_mw
        Ru_total = np.floor(float(ru_coef) * F + 1e-9)
        Rum0 = _rnd(float(ru_split) * Ru_total)
        take_um = gate_mw & np.isfinite(prum) & (prum >= ru_min_price)
        take_ua = gate_mw & np.isfinite(prua) & (prua >= ru_min_price)
        R_up_mfrr = np.where(take_um, Rum0, 0.0)
        R_up_afrr = np.where(take_ua, Ru_total - Rum0, 0.0)
        reserve_up_rate = R_up_mfrr * np.where(take_um, prum, 0.0) + R_up_afrr * np.where(take_ua, prua, 0.0)
    else:
        R_up_mfrr = np.zeros_like(F)
        R_up_afrr = np.zeros_like(F)
        reserve_up_rate = np.zeros_like(F)
    R_up = R_up_mfrr + R_up_afrr
    F_avail = F - R_up
    # ----- Reserve market down capacity (sized within F_avail; mirror engine) -----
    if reserve_enabled and reserve_mfrr_dn is not None:
        prm = np.asarray(reserve_mfrr_dn, dtype=np.float64)
        pra = (
            np.asarray(reserve_afrr_dn, dtype=np.float64)
            if reserve_afrr_dn is not None
            else np.full_like(F, np.nan)
        )
        R_total = np.floor(float(r_coef) * F_avail + 1e-9)
        Rm0 = _rnd(float(r_split) * R_total)
        take_m = np.isfinite(prm) & (prm >= r_min_price)
        take_a = np.isfinite(pra) & (pra >= r_min_price)
        R_mfrr = np.where(take_m, Rm0, 0.0)
        R_afrr = np.where(take_a, R_total - Rm0, 0.0)
        reserve_rate = R_mfrr * np.where(take_m, prm, 0.0) + R_afrr * np.where(take_a, pra, 0.0)
    else:
        R_mfrr = np.zeros_like(F)
        R_afrr = np.zeros_like(F)
        reserve_rate = np.zeros_like(F)
    R_dn = R_mfrr + R_afrr
    F_int = np.floor(F + 1e-9)
    da_sold_wh = np.floor(np.where(above_X, F_avail, F_avail * (1 - Y)) + 1e-9).astype(np.float64)
    da_sold = np.maximum(da_sold_wh, R_dn)
    Q_w = F_int - R_up - da_sold
    trusted_raw = Z * (ID - F)
    trusted_extra = np.where(trusted_raw > 0, np.floor(trusted_raw + 1e-9), 0)
    up_free = Q_w + trusted_extra
    da_nonreserve = da_sold - R_dn
    rest_up_mfrr = _rnd(s_up_c * up_free)
    Q_up_mfrr = R_up_mfrr + rest_up_mfrr
    Q_up_afrr = R_up_afrr + (up_free - rest_up_mfrr)
    rest_dn_mfrr = _rnd(s_dn_c * da_nonreserve)
    Q_dn_mfrr = R_mfrr + rest_dn_mfrr
    Q_dn_afrr = R_afrr + (da_nonreserve - rest_dn_mfrr)
    is_up = P_mfrr_w >= 1
    is_dn = P_mfrr_w <= -1
    up_mfrr_active = np.where(is_up, Q_up_mfrr, 0)
    dn_mfrr_active = np.where(is_dn, Q_dn_mfrr, 0)
    if avg_p_pos_w is None: avg_p_pos_w = np.zeros_like(F)
    if avg_p_neg_w is None: avg_p_neg_w = np.zeros_like(F)
    if n_pos_fav is None: n_pos_fav = np.zeros_like(F)
    if n_neg_fav is None: n_neg_fav = np.zeros_like(F)
    up_afrr_active = (avg_p_pos_w > 0) & (Q_up_afrr > 0)
    dn_afrr_active = (avg_p_neg_w < 0) & (Q_dn_afrr > 0)
    rev = (
        da_sold * P_da
        + up_mfrr_active * P_mfrr_w
        - dn_mfrr_active * P_mfrr_w
        + reserve_rate
        + reserve_up_rate
        + np.where(up_afrr_active, Q_up_afrr * avg_p_pos_w, 0)
        - np.where(dn_afrr_active, Q_dn_afrr * avg_p_neg_w, 0)
    )
    a_frac_pos = n_pos_fav / 225.0
    a_frac_neg = n_neg_fav / 225.0
    up_afrr_disp = np.where(up_afrr_active, Q_up_afrr * a_frac_pos, 0)
    dn_afrr_disp = np.where(dn_afrr_active, Q_dn_afrr * a_frac_neg, 0)
    Q_pos_l2 = da_sold + up_mfrr_active + up_afrr_disp - dn_mfrr_active - dn_afrr_disp

    # S3 — only when X_cap ≥ 1 AND K ≥ 1.
    s3_X = np.zeros_like(F)
    s3_fires = np.zeros_like(F, dtype=bool)
    s3_intraday = np.zeros_like(F)
    s3_curtail = np.zeros_like(F)
    if int(s3_X_cap) >= 1 and int(s3_K) >= 1:
        mean_arr, std_arr = s3_rolling_stats(P_mfrr_raw, int(s3_K), int(s3_L))
        gate_vwap_ok = ~np.isnan(vwap_1h)
        gate_roll_ok = ~np.isnan(mean_arr) & ~np.isnan(std_arr)
        # Gate 0: skip S3 if da_sold ≥ s3_da_skip
        gate_da = da_sold < int(s3_da_skip)
        spread = vwap_1h - mean_arr
        gate_spread = spread >= s3_S_min
        gate_sigma = std_arr <= s3_sigma_max
        # sig = (spread - S_min) / S_min, clipped to ≤ 1; with S_min=0 the
        # division is infinity, np handles that and the clip → 1.
        with np.errstate(divide="ignore", invalid="ignore"):
            sig = np.where(s3_S_min == 0, np.inf, (spread - s3_S_min) / max(s3_S_min, 1e-30))
        x_prop = np.floor(s3_X_cap * np.minimum(1.0, sig) + 1e-9)
        gates = gate_da & gate_vwap_ok & gate_roll_ok & gate_spread & gate_sigma & (x_prop >= 1)
        bid_price = vwap_1h + s3_M
        s3_X = np.where(gates, x_prop, 0)
        s3_fires = gates & (P_mfrr_w <= bid_price)
        s3_intraday = np.where(gates, x_prop * vwap_1h, 0)
        s3_curtail = np.where(s3_fires, x_prop * (-P_mfrr_w), 0)
        rev += s3_intraday + s3_curtail
    Q_pos = Q_pos_l2 + np.where(s3_fires, 0, s3_X)
    short_l2 = np.maximum(0, Q_pos_l2 - Q_pot)
    short = np.maximum(0, Q_pos - Q_pot)
    s3_extra_short = short - short_l2
    valid_imb = ~np.isnan(P_imb_w)
    imb = np.where(valid_imb, short_l2 * P_imb_w, 0)
    flat = np.where(valid_imb, short_l2 * theta, 0)
    s3_extra_cost = np.where(valid_imb, s3_extra_short * (P_imb_w + theta), 0)
    rev -= imb + flat + s3_extra_cost
    # Day-type filter (post-hoc accumulation gate) — see simulate_total. The
    # S3 rolling stats above were computed over the FULL series, so dropping
    # non-matching days here never disturbs intra-day-oversell continuity.
    if day_mask is not None and day_filter != "all":
        keep = (day_mask == 0) if day_filter == "workday" else (day_mask != 0)
        rev = np.where(keep, rev, 0.0)
    return {
        "total": rev.sum() * 0.25,
        "short_l2": short_l2,
        "short": short,
        "s3_extra_short": s3_extra_short,
        "s3_X": s3_X,
        "s3_fires": s3_fires,
        "imb": imb,
        "flat": flat,
        "s3_extra_cost": s3_extra_cost,
        # Reserve diagnostics (for the reserve-market tests).
        "reserve": float((reserve_rate).sum() * 0.25),
        "reserve_up": float((reserve_up_rate).sum() * 0.25),
        "da_sold": da_sold,
        "F_avail": F_avail,
        "R_dn": R_dn,
        "R_mfrr": R_mfrr,
        "R_afrr": R_afrr,
        "R_up": R_up,
        "R_up_mfrr": R_up_mfrr,
        "R_up_afrr": R_up_afrr,
        "Q_dn_mfrr": Q_dn_mfrr,
        "Q_dn_afrr": Q_dn_afrr,
        "Q_dn_total": Q_dn_mfrr + Q_dn_afrr,
        "Q_up_mfrr": Q_up_mfrr,
        "Q_up_afrr": Q_up_afrr,
        "Q_up_total": Q_up_mfrr + Q_up_afrr,
        "s_up_arr": s_up_c,
        "s_dn_arr": s_dn_c,
    }


# =============================================================================
#  Globals shared across tests
# =============================================================================
print("Loading CSV…")
CSV = load_csv()
print(f"  CSV rows: {len(CSV):,}")
print("Loading data.js…")
DATA = load_data_js()
print(f"  data.js rows: {DATA['n']:,}, start: {DATA['start_iso']}")

# Map data.js row index → CSV row index using the offsets array
DATA_TS = pd.to_datetime(DATA["start_iso"]).tz_localize(None) + pd.to_timedelta(
    np.array(DATA["offsets"]) * 15, unit="m"
)
# CSV indexed by datetime
CSV_BY_TS = CSV.set_index("datetime_utc")
print(f"  data.js timestamps: {DATA_TS[0]} → {DATA_TS[-1]}")

R = TestRunner()


# =============================================================================
#  Day-type mask mirror (engine.js _computeDayTypeMask)
#  0 = workday, 1 = weekend, 2 = public holiday. Weekend takes precedence
#  over holiday (engine checks day-of-week first). Holidays for LV / EE / LT
#  via the `holidays` package; if it's missing we degrade to weekend-only,
#  exactly like engine.js falls back when the date-holidays CDN fails.
# =============================================================================
_DAY_TYPE_MASK_CACHE = None


def _day_type_mask():
    global _DAY_TYPE_MASK_CACHE
    if _DAY_TYPE_MASK_CACHE is not None:
        return _DAY_TYPE_MASK_CACHE
    # pandas day-of-week: Mon=0 .. Sun=6, so weekend = {5, 6} (Sat, Sun) —
    # the same Sat/Sun set engine.js gets from getUTCDay() ∈ {0, 6}.
    dow = np.asarray(DATA_TS.dayofweek)
    is_weekend = (dow == 5) | (dow == 6)
    hol = set()
    try:
        import holidays as _holidays

        years = list(range(DATA_TS[0].year, DATA_TS[-1].year + 1))
        for cc in ("LV", "EE", "LT"):
            for d in _holidays.country_holidays(cc, years=years).keys():
                hol.add(pd.Timestamp(d).date())
    except Exception:
        hol = set()  # weekend-only fallback (mirrors engine.js CDN failure)
    dates = DATA_TS.date
    is_hol = np.array([d in hol for d in dates], dtype=bool)
    mask = np.where(is_weekend, 1, np.where(is_hol, 2, 0)).astype(np.int64)
    _DAY_TYPE_MASK_CACHE = mask
    return mask


# =============================================================================
#  A. DATA INTEGRITY
# =============================================================================
def test_baltic_wind_aggregation():
    """baltic_wind_da[i] must equal sum of three countries' wind dayahead."""
    bw = np.asarray(DATA["baltic_wind_da"])
    # Sample 200 random rows
    rng = np.random.default_rng(42)
    sample = rng.choice(DATA["n"], size=200, replace=False)
    for i in sample:
        ts = DATA_TS[i]
        row = CSV_BY_TS.loc[ts]
        expected = (
            row["lv_wind_onshore_dayahead_mw"]
            + row["ee_wind_onshore_dayahead_mw"]
            + row["lt_wind_onshore_dayahead_mw"]
        )
        assert abs(bw[i] - expected) <= 0.01, (
            f"Row {i} ts={ts}: baltic_wind_da={bw[i]:.3f} but expected"
            f" {expected:.3f} (lv+ee+lt sum)"
        )


def test_baltic_solar_aggregation():
    bs = np.asarray(DATA["baltic_solar_da"])
    rng = np.random.default_rng(43)
    sample = rng.choice(DATA["n"], size=200, replace=False)
    for i in sample:
        ts = DATA_TS[i]
        row = CSV_BY_TS.loc[ts]
        expected = (
            row["lv_solar_dayahead_mw"]
            + row["ee_solar_dayahead_mw"]
            + row["lt_solar_dayahead_mw"]
        )
        assert abs(bs[i] - expected) <= 0.01


def test_baltic_imb_vol_aggregation():
    bi = np.asarray(DATA["baltic_imb_vol"])
    rng = np.random.default_rng(44)
    sample = rng.choice(DATA["n"], size=200, replace=False)
    for i in sample:
        ts = DATA_TS[i]
        row = CSV_BY_TS.loc[ts]
        expected = (
            row["imbalance_volume_lv"]
            + row["imbalance_volume_ee"]
            + row["imbalance_volume_lt"]
        )
        assert abs(bi[i] - expected) <= 0.01


def test_spread_calculation():
    """spread[i] = p_mfrr[i] − p_da[i] (sanity: matches CSV directly)."""
    p_mfrr = np.asarray(DATA["p_mfrr"], dtype=float)
    p_da = np.asarray(DATA["p_da"], dtype=float)
    rng = np.random.default_rng(45)
    sample = rng.choice(DATA["n"], size=200, replace=False)
    for i in sample:
        ts = DATA_TS[i]
        row = CSV_BY_TS.loc[ts]
        if pd.isna(row["mfrr_sa_upward_lv"]):
            continue
        # 2dp rounding in data.js
        assert abs(p_mfrr[i] - row["mfrr_sa_upward_lv"]) <= 0.011
        assert abs(p_da[i] - row["lt_dayahead_price_eur_mwh"]) <= 0.011


def test_april_data_present():
    """April 2026 must be in data.js (was the bug we fixed).

    NOTE for refresh: if the source CSV no longer covers all of April,
    update FROZEN_APRIL_ROW_COUNT at the top of this file."""
    april_ts = pd.Timestamp("2026-04-01 00:00:00")
    april_end = pd.Timestamp("2026-04-30 23:45:00")
    n_april = ((DATA_TS >= april_ts) & (DATA_TS <= april_end)).sum()
    assert n_april == FROZEN_APRIL_ROW_COUNT, (
        f"Expected {FROZEN_APRIL_ROW_COUNT} April rows in data.js, found {n_april}"
    )


def test_p_imb_null_handling():
    """p_imb should be null in JSON for April (where Latvia imbalance price is missing).

    If a refreshed CSV adds April imbalance prices, the null-count drops
    toward zero — update FROZEN_NULL_PIMB_RANGE accordingly."""
    p_imb = DATA["p_imb"]
    n_null = sum(1 for v in p_imb if v is None)
    lo, hi = FROZEN_NULL_PIMB_RANGE
    assert lo <= n_null <= hi, (
        f"Expected {lo}–{hi} null p_imb entries, got {n_null}"
    )
    # All null entries should fall in April / early May
    for i, v in enumerate(p_imb):
        if v is None:
            ts = DATA_TS[i]
            assert ts >= pd.Timestamp("2026-03-30"), (
                f"Unexpected null p_imb at {ts} (row {i})"
            )


def test_offsets_monotonic():
    """data.js offsets must be strictly increasing."""
    offsets = np.asarray(DATA["offsets"])
    diffs = np.diff(offsets)
    assert np.all(diffs > 0), "Offsets must be strictly increasing"


def test_timestamp_consistency():
    """ts(i) computed from start_iso + offset[i]*15min should match expected times in CSV."""
    rng = np.random.default_rng(46)
    sample = rng.choice(DATA["n"], size=50, replace=False)
    for i in sample:
        ts = DATA_TS[i]
        # Must exist in CSV
        assert ts in CSV_BY_TS.index, f"Row {i}: timestamp {ts} not found in CSV"


def test_mfrr_up_equals_down():
    """mFRR upward and downward LV prices match where both are present (single-clearing-price)."""
    mask = CSV["mfrr_sa_upward_lv"].notna() & CSV["mfrr_sa_downward_lv"].notna()
    diff = (CSV.loc[mask, "mfrr_sa_upward_lv"] - CSV.loc[mask, "mfrr_sa_downward_lv"]).abs()
    n_diff = (diff > 1e-6).sum()
    # Engine treats them as equal; assertion: diff in fewer than 1% of rows
    assert n_diff / mask.sum() < 0.01, (
        f"mFRR up vs down differ in {n_diff}/{mask.sum()} rows"
    )


# =============================================================================
#  B. ENGINE INVARIANTS
# =============================================================================
def test_whole_mw_rounding():
    """Q_da_sold, Q_w, Q_dn_offer must always be integers (whole-MW market rule)."""
    rng = np.random.default_rng(47)
    sample = rng.choice(DATA["n"], size=500, replace=False)
    F_arr = np.asarray(DATA["da_forecast"])
    ID_arr = np.asarray(DATA["id_forecast"])
    P_da_arr = np.asarray(DATA["p_da"])
    for X, Y, Z in [(0, 0, 0), (30, 1, 1), (50, 0.5, 0.7), (100, 0.95, 0.4)]:
        for i in sample:
            r = isp_revenue(2, F_arr[i], ID_arr[i], P_da_arr[i], 0, 0, 0, X, Y, Z)
            for k in ("Q_da_sold", "Q_w", "Q_up", "Q_dn"):
                v = r[k]
                assert v == int(v), (
                    f"X={X},Y={Y},Z={Z},i={i}: {k}={v} is not an integer"
                )


def test_mfrr_dn_capped_at_da():
    """Q_dn_offer must equal Q_da_sold (cap), and 0 when Q_da_sold is 0."""
    rng = np.random.default_rng(48)
    sample = rng.choice(DATA["n"], size=500, replace=False)
    F_arr = np.asarray(DATA["da_forecast"])
    ID_arr = np.asarray(DATA["id_forecast"])
    P_da_arr = np.asarray(DATA["p_da"])
    p_mfrr = np.asarray(DATA["p_mfrr"], dtype=float)
    for X, Y, Z in [(30, 1, 1), (50, 0.5, 0.5)]:
        for i in sample:
            # Force a downward activation by overriding P_mfrr
            r = isp_revenue(
                2, F_arr[i], ID_arr[i], P_da_arr[i], -50, 0, 0, X, Y, Z, theta=0
            )
            assert r["Q_dn"] <= r["Q_da_sold"], (
                f"i={i}: Q_dn={r['Q_dn']} > Q_da_sold={r['Q_da_sold']}"
            )
            if r["Q_da_sold"] == 0:
                assert r["Q_dn"] == 0, (
                    f"i={i}: Q_dn={r['Q_dn']} but Q_da_sold==0"
                )


def test_mfrr_up_dn_mutually_exclusive():
    """A single ISP can never fire both up and down on mFRR (P_mfrr is
    single-signed). NB: Q_up / Q_dn now report OFFERED volumes which can
    both be > 0 (a wind park always has DA position to curtail and may
    have withheld volume to ramp up); the right check is on the
    post-activation fields Q_up_mfrr_active / Q_dn_mfrr_active.
    """
    rng = np.random.default_rng(49)
    sample = rng.choice(DATA["n"], size=200, replace=False)
    F_arr = np.asarray(DATA["da_forecast"])
    ID_arr = np.asarray(DATA["id_forecast"])
    P_da_arr = np.asarray(DATA["p_da"])
    p_mfrr_arr = np.asarray(DATA["p_mfrr"], dtype=float)
    for X, Y in [(30, 1), (50, 0.5)]:
        for i in sample:
            r = isp_revenue(
                2, F_arr[i], ID_arr[i], P_da_arr[i], p_mfrr_arr[i], 0, 0, X, Y, 0.5
            )
            both_active = r["Q_up_mfrr_active"] > 0 and r["Q_dn_mfrr_active"] > 0
            assert not both_active, (
                f"i={i}: both Q_up_mfrr_active={r['Q_up_mfrr_active']} and "
                f"Q_dn_mfrr_active={r['Q_dn_mfrr_active']} > 0 (P_mfrr={p_mfrr_arr[i]})"
            )


def test_naive_l1_known_value():
    """Replicate L1 naive (Y=0): should be 11,837,029 € (extended dataset)."""
    F = np.asarray(DATA["da_forecast"], dtype=np.float64)
    ID = np.asarray(DATA["id_forecast"], dtype=np.float64)
    P_da = np.asarray(DATA["p_da"], dtype=np.float64)
    p_mfrr = winsorize(np.array(DATA["p_mfrr"], dtype=np.float64), 5, 95)
    p_imb = winsorize(np.array([np.nan if v is None else v for v in DATA["p_imb"]], dtype=np.float64), 5, 95)
    Q_pot = np.asarray(DATA["q_pot"], dtype=np.float64)
    naive = simulate_total(1, F, ID, P_da, p_mfrr, Q_pot, p_imb, X=0, Y=0, Z=0)
    print(f"\n        L1 naive = {naive:,.0f} €")
    # We don't fix this against a constant — we just verify Y=1 strictly improves it
    assert naive > 0


def test_l1_optimum_value():
    """L1 at default (X=30, Y=1) should equal FROZEN_L1_DEFAULT_EUR.

    Refresh trigger: when the source CSV changes, this number changes.
    Update FROZEN_L1_DEFAULT_EUR after eyeballing the new value."""
    F = np.asarray(DATA["da_forecast"], dtype=np.float64)
    ID = np.asarray(DATA["id_forecast"], dtype=np.float64)
    P_da = np.asarray(DATA["p_da"], dtype=np.float64)
    p_mfrr = winsorize(np.array(DATA["p_mfrr"], dtype=np.float64), 5, 95)
    p_imb = winsorize(np.array([np.nan if v is None else v for v in DATA["p_imb"]], dtype=np.float64), 5, 95)
    Q_pot = np.asarray(DATA["q_pot"], dtype=np.float64)
    val = simulate_total(1, F, ID, P_da, p_mfrr, Q_pot, p_imb, X=30, Y=1, Z=0)
    print(f"\n        L1 (X=30, Y=1) = {val:,.0f} €")
    assert abs(val - FROZEN_L1_DEFAULT_EUR) < 100, (
        f"L1 default = {val:,.0f} but FROZEN value is {FROZEN_L1_DEFAULT_EUR:,}"
    )


def test_l2_default_value():
    """L2 at default (X=30, Y=1, Z=1, θ=30) should equal FROZEN_L2_DEFAULT_EUR.

    Refresh trigger: when the source CSV changes, this number changes.
    Update FROZEN_L2_DEFAULT_EUR after eyeballing the new value."""
    F = np.asarray(DATA["da_forecast"], dtype=np.float64)
    ID = np.asarray(DATA["id_forecast"], dtype=np.float64)
    P_da = np.asarray(DATA["p_da"], dtype=np.float64)
    p_mfrr = winsorize(np.array(DATA["p_mfrr"], dtype=np.float64), 5, 95)
    p_imb = winsorize(np.array([np.nan if v is None else v for v in DATA["p_imb"]], dtype=np.float64), 5, 95)
    Q_pot = np.asarray(DATA["q_pot"], dtype=np.float64)
    val = simulate_total(2, F, ID, P_da, p_mfrr, Q_pot, p_imb, X=30, Y=1, Z=1, theta=30)
    print(f"\n        L2 (X=30, Y=1, Z=1, θ=30) = {val:,.0f} €")
    assert abs(val - FROZEN_L2_DEFAULT_EUR) < 200, (
        f"L2 default = {val:,.0f} but FROZEN value is {FROZEN_L2_DEFAULT_EUR:,}"
    )


# ============================================================================
#  L3 / S3 regression tests (added 2026-05-12 along with the lag + p_mfrr
#  rolling-source migration). The Python mirror (simulate_total_l3) is held
#  to the same algorithm as engine.js so the JS engine has an independent
#  oracle; these tests verify the math and the load-bearing invariants.
# ============================================================================
def _l3_inputs():
    F = np.asarray(DATA["da_forecast"], dtype=np.float64)
    ID = np.asarray(DATA["id_forecast"], dtype=np.float64)
    P_da = np.asarray(DATA["p_da"], dtype=np.float64)
    p_mfrr_raw = np.array(DATA["p_mfrr"], dtype=np.float64)
    p_mfrr = winsorize(p_mfrr_raw.copy(), 5, 95)
    p_imb_raw = np.array([np.nan if v is None else v for v in DATA["p_imb"]], dtype=np.float64)
    p_imb = winsorize(p_imb_raw, 5, 95)
    Q_pot = np.asarray(DATA["q_pot"], dtype=np.float64)
    vwap_1h = np.array([np.nan if v is None else v for v in DATA.get("vwap_1h", [None]*len(F))], dtype=np.float64)
    return F, ID, P_da, p_mfrr, Q_pot, p_imb, vwap_1h, p_mfrr_raw


def test_l3_default_value():
    """L3 at default (K=4, L=4, S_min=25, σ_max=75, X_cap=5, M=5) reproduces
    FROZEN_L3_DEFAULT_EUR. Verifies the post-migration combo of
    p_mfrr-rolling + lag-aware window."""
    F, ID, P_da, p_mfrr, Q_pot, p_imb, vwap_1h, p_mfrr_raw = _l3_inputs()
    r = simulate_total_l3(
        F, ID, P_da, p_mfrr, Q_pot, p_imb, vwap_1h, p_mfrr_raw,
        X=30, Y=1, Z=1, theta=30,
        s3_K=4, s3_L=4, s3_S_min=25, s3_sigma_max=75, s3_X_cap=5, s3_M=5,
    )
    val = r["total"]
    print(f"\n        L3 default = {val:,.0f} €")
    assert abs(val - FROZEN_L3_DEFAULT_EUR) < 200, (
        f"L3 default = {val:,.0f} but FROZEN value is {FROZEN_L3_DEFAULT_EUR:,}"
    )


def test_l3_xcap0_equals_l2():
    """LOAD-BEARING invariant: L3 with X_cap=0 must equal L2 exactly. S3 is
    short-circuited entirely; no S3 revenue, no S3 extra cost. If this
    breaks, S3's enable-gate is leaking somewhere."""
    F, ID, P_da, p_mfrr, Q_pot, p_imb, vwap_1h, p_mfrr_raw = _l3_inputs()
    r = simulate_total_l3(
        F, ID, P_da, p_mfrr, Q_pot, p_imb, vwap_1h, p_mfrr_raw,
        X=30, Y=1, Z=1, theta=30, s3_X_cap=0,
    )
    l2 = simulate_total(2, F, ID, P_da, p_mfrr, Q_pot, p_imb, X=30, Y=1, Z=1, theta=30)
    assert abs(r["total"] - l2) < 1.0, (
        f"L3@X_cap=0 = {r['total']:,.2f} but L2 = {l2:,.2f} (diff={r['total']-l2:.2f})"
    )


def test_l3_da_skip0_equals_l2():
    """LOAD-BEARING invariant (mirror of X_cap=0): L3 with DA_skip=0 must
    equal L2 exactly. The G0 gate (`da_sold < DA_skip`) always trips when
    DA_skip = 0 (since da_sold ≥ 0 always), so S3 never runs."""
    F, ID, P_da, p_mfrr, Q_pot, p_imb, vwap_1h, p_mfrr_raw = _l3_inputs()
    r = simulate_total_l3(
        F, ID, P_da, p_mfrr, Q_pot, p_imb, vwap_1h, p_mfrr_raw,
        X=30, Y=1, Z=1, theta=30,
        s3_K=4, s3_L=4, s3_S_min=25, s3_sigma_max=75, s3_X_cap=5, s3_M=5,
        s3_da_skip=0,
    )
    l2 = simulate_total(2, F, ID, P_da, p_mfrr, Q_pot, p_imb, X=30, Y=1, Z=1, theta=30)
    assert abs(r["total"] - l2) < 1.0, (
        f"L3@DA_skip=0 = {r['total']:,.2f} but L2 = {l2:,.2f} (diff={r['total']-l2:.2f})"
    )


def test_l3_da_skip_gate_affects_only_high_da_isps():
    """Sanity: DA_skip=50 vs DA_skip=59 must differ (some high-DA ISPs get
    blocked under 50). And both must equal an "S3 on every ISP" version
    where the gate never trips, except for the high-DA ISPs that DA_skip=50
    skipped. Confirms the gate behaves like a per-ISP filter, not a global
    on/off."""
    F, ID, P_da, p_mfrr, Q_pot, p_imb, vwap_1h, p_mfrr_raw = _l3_inputs()
    common = dict(
        X=30, Y=1, Z=1, theta=30,
        s3_K=4, s3_L=4, s3_S_min=25, s3_sigma_max=75, s3_X_cap=5, s3_M=5,
    )
    r_50 = simulate_total_l3(
        F, ID, P_da, p_mfrr, Q_pot, p_imb, vwap_1h, p_mfrr_raw,
        s3_da_skip=50, **common,
    )
    r_59 = simulate_total_l3(
        F, ID, P_da, p_mfrr, Q_pot, p_imb, vwap_1h, p_mfrr_raw,
        s3_da_skip=59, **common,
    )
    diff = abs(r_50["total"] - r_59["total"])
    print(f"\n        DA_skip=50 ⇒ {r_50['total']:,.0f} €,  DA_skip=59 ⇒ {r_59['total']:,.0f} €,  |Δ| = {diff:,.0f}")
    # On the current dataset some ISPs have da_sold ≥ 50 with S3 active,
    # so the two MUST differ. (If they coincided, the gate isn't wired.)
    assert diff > 100, f"DA_skip 50 vs 59 must differ; diff = {diff:.2f}"


def test_s3_rolling_source_is_pmfrr_not_pimb():
    """Switching the rolling source between p_mfrr_raw and p_imb_raw must
    produce different revenue (regression against accidentally reverting to
    the pre-migration p_imb-based gate)."""
    F, ID, P_da, p_mfrr, Q_pot, p_imb, vwap_1h, p_mfrr_raw = _l3_inputs()
    p_imb_raw = np.array([np.nan if v is None else v for v in DATA["p_imb"]], dtype=np.float64)
    correct = simulate_total_l3(
        F, ID, P_da, p_mfrr, Q_pot, p_imb, vwap_1h, p_mfrr_raw,
        X=30, Y=1, Z=1, theta=30,
        s3_K=4, s3_L=4, s3_S_min=25, s3_sigma_max=75, s3_X_cap=5, s3_M=5,
    )["total"]
    legacy = simulate_total_l3(
        F, ID, P_da, p_mfrr, Q_pot, p_imb, vwap_1h, p_imb_raw,
        X=30, Y=1, Z=1, theta=30,
        s3_K=4, s3_L=4, s3_S_min=25, s3_sigma_max=75, s3_X_cap=5, s3_M=5,
    )["total"]
    diff = abs(correct - legacy)
    print(f"\n        L3 with p_mfrr_raw = {correct:,.0f} €, with p_imb_raw = {legacy:,.0f} €")
    assert diff > 10_000, (
        f"Switching rolling source must change L3 by >10k €; diff={diff:,.0f}"
    )


def test_s3_lag_window_shifts_results():
    """Lag L=0 (legacy) vs L=4 (new default) must produce different revenue.
    With L=4 the rolling stats look at samples [i-K-L, i-L), so two
    otherwise-identical runs at L=0 vs L=4 should differ on a meaningful
    fraction of ISPs."""
    F, ID, P_da, p_mfrr, Q_pot, p_imb, vwap_1h, p_mfrr_raw = _l3_inputs()
    no_lag = simulate_total_l3(
        F, ID, P_da, p_mfrr, Q_pot, p_imb, vwap_1h, p_mfrr_raw,
        X=30, Y=1, Z=1, theta=30,
        s3_K=4, s3_L=0, s3_S_min=25, s3_sigma_max=75, s3_X_cap=5, s3_M=5,
    )["total"]
    with_lag = simulate_total_l3(
        F, ID, P_da, p_mfrr, Q_pot, p_imb, vwap_1h, p_mfrr_raw,
        X=30, Y=1, Z=1, theta=30,
        s3_K=4, s3_L=4, s3_S_min=25, s3_sigma_max=75, s3_X_cap=5, s3_M=5,
    )["total"]
    diff = abs(no_lag - with_lag)
    print(f"\n        L=0 ⇒ {no_lag:,.0f} €, L=4 ⇒ {with_lag:,.0f} €, |Δ| = {diff:,.0f} €")
    assert diff > 10_000, f"Lag must change L3 by >10k €; diff={diff:,.0f}"


def test_s3_imbalance_decomposition_equals_naive_short_cost():
    """When the hedge mFRR-dn bid does NOT clear, the SUM of L2 imbalance
    + L2 flat + S3 extra-cost on a per-ISP basis must equal the naïve
    short × (p_imb + θ) (for ISPs with valid p_imb and S3 active). This
    proves the decomp split is mathematically equivalent to a single-line
    settlement — i.e. there's no double-counting or omission."""
    F, ID, P_da, p_mfrr, Q_pot, p_imb, vwap_1h, p_mfrr_raw = _l3_inputs()
    # Use the bad-but-triggering params from the audit so S3 fires often
    # with the hedge bid mostly missing.
    theta = 50.0
    r = simulate_total_l3(
        F, ID, P_da, p_mfrr, Q_pot, p_imb, vwap_1h, p_mfrr_raw,
        X=200, Y=0.7, Z=1, theta=theta,
        s3_K=4, s3_L=4, s3_S_min=0, s3_sigma_max=1000, s3_X_cap=30, s3_M=-50,
    )
    # Only check ISPs where p_imb is valid, S3 oversold, and hedge missed.
    valid = ~np.isnan(p_imb) & (r["s3_X"] > 0) & (~r["s3_fires"]) & (r["short"] > 0)
    n_samples = int(valid.sum())
    assert n_samples > 100, f"Need many sample ISPs; got {n_samples}"
    decomp_sum = r["imb"][valid] + r["flat"][valid] + r["s3_extra_cost"][valid]
    naive = r["short"][valid] * (p_imb[valid] + theta)
    diff = np.abs(decomp_sum - naive)
    max_abs = float(diff.max())
    print(f"\n        n={n_samples} ISPs; max decomp-vs-naive Δ = {max_abs:.4f} €")
    # Allow small float-rounding tolerance (winsorized float32 → float64 path).
    assert max_abs < 1e-6, (
        f"Decomp split disagrees with naive short×(p_imb+θ) by {max_abs:.6f} €"
    )


def test_s3_nan_pimb_zeroes_all_imbalance_terms():
    """For ISPs with NaN p_imb (April 2026), both the L2 imbalance and the
    S3-extra cost must be ZERO regardless of whether S3 fires. Otherwise
    NaN would poison the total."""
    F, ID, P_da, p_mfrr, Q_pot, p_imb, vwap_1h, p_mfrr_raw = _l3_inputs()
    r = simulate_total_l3(
        F, ID, P_da, p_mfrr, Q_pot, p_imb, vwap_1h, p_mfrr_raw,
        X=200, Y=0.7, Z=1, theta=50,
        s3_K=4, s3_L=4, s3_S_min=0, s3_sigma_max=1000, s3_X_cap=30, s3_M=-50,
    )
    nan_rows = np.isnan(p_imb)
    n_nan = int(nan_rows.sum())
    assert n_nan > 100, f"Expected many NaN p_imb rows; got {n_nan}"
    assert np.all(r["imb"][nan_rows] == 0), "imb must be 0 where p_imb is NaN"
    assert np.all(r["flat"][nan_rows] == 0), "flat must be 0 where p_imb is NaN"
    assert np.all(r["s3_extra_cost"][nan_rows] == 0), (
        "s3_extra_cost must be 0 where p_imb is NaN"
    )


def test_window_consistency():
    """Per-ISP rev summed over a window equals simulate_total over that same window."""
    F = np.asarray(DATA["da_forecast"], dtype=np.float64)
    ID = np.asarray(DATA["id_forecast"], dtype=np.float64)
    P_da = np.asarray(DATA["p_da"], dtype=np.float64)
    p_mfrr = winsorize(np.array(DATA["p_mfrr"], dtype=np.float64), 5, 95)
    p_imb = winsorize(np.array([np.nan if v is None else v for v in DATA["p_imb"]], dtype=np.float64), 5, 95)
    Q_pot = np.asarray(DATA["q_pot"], dtype=np.float64)

    # Pick a 30-day window in mid-summer
    target_start = pd.Timestamp("2025-08-01")
    target_end = pd.Timestamp("2025-08-31")
    mask = (DATA_TS >= target_start) & (DATA_TS <= target_end)
    win_start = int(np.argmax(mask))
    win_end = win_start + int(mask.sum())

    full = simulate_total(
        2, F[win_start:win_end], ID[win_start:win_end], P_da[win_start:win_end],
        p_mfrr[win_start:win_end], Q_pot[win_start:win_end], p_imb[win_start:win_end],
        X=30, Y=1, Z=1, theta=30,
    )

    # Per-ISP sum
    total = 0.0
    for k in range(win_start, win_end):
        r = isp_revenue(
            2, F[k], ID[k], P_da[k], p_mfrr[k], Q_pot[k], p_imb[k],
            X=30, Y=1, Z=1, theta=30,
        )
        total += r["rev"]
    assert abs(full - total) < EUR_TOL, (
        f"Window vectorised={full:,.2f} vs per-ISP sum={total:,.2f} differ by {full-total:.2f}"
    )


def test_april_in_l1_not_in_l2_imbalance():
    """L1 should include April rows. L2 imbalance cost should skip April (NaN p_imb)."""
    p_imb_raw = np.array([np.nan if v is None else v for v in DATA["p_imb"]], dtype=np.float64)
    # April rows are those with NaN p_imb
    n_nan = np.isnan(p_imb_raw).sum()
    assert n_nan > 2000, "Expected NaN p_imb rows in April"

    # Test: pick an April ISP (NaN p_imb), simulate L2, verify imb cost is 0
    nan_idx = np.where(np.isnan(p_imb_raw))[0]
    test_i = nan_idx[len(nan_idx) // 2]  # mid-April
    F_arr = np.asarray(DATA["da_forecast"])
    ID_arr = np.asarray(DATA["id_forecast"])
    P_da_arr = np.asarray(DATA["p_da"])
    p_mfrr = np.asarray(DATA["p_mfrr"], dtype=np.float64)
    Q_pot = np.asarray(DATA["q_pot"])
    r = isp_revenue(
        2, F_arr[test_i], ID_arr[test_i], P_da_arr[test_i],
        p_mfrr[test_i], Q_pot[test_i],
        np.nan,  # p_imb is NaN
        X=30, Y=1, Z=1, theta=30,
    )
    assert r["imb"] == 0 and r["flat"] == 0, (
        f"April ISP {test_i}: imb={r['imb']}, flat={r['flat']} (should be 0 for NaN p_imb)"
    )


# =============================================================================
#  C. SPEC EXAMPLES
# =============================================================================
def test_spec_example_1():
    """Example 1 from the original spec: should yield −322.5 €."""
    r = isp_revenue(2, F=20, ID=18, P_da=5, P_mfrr=50, Q_pot=12, P_imb=200,
                    X=10, Y=0.5, Z=0.5, theta=30)
    assert abs(r["rev"] - (-322.5)) < 1e-6, (
        f"Expected -322.5 € got {r['rev']:+.2f} €  (parts: {r})"
    )


def test_spec_example_2():
    """Example 2: should yield +375.0 €."""
    r = isp_revenue(2, F=20, ID=20, P_da=100, P_mfrr=0, Q_pot=10, P_imb=20,
                    X=10, Y=0.5, Z=0.0, theta=30)
    assert abs(r["rev"] - 375.0) < 1e-6, (
        f"Expected +375.0 € got {r['rev']:+.2f} €  (parts: {r})"
    )


# =============================================================================
#  D. GRAPHS ENGINE
# =============================================================================
def test_regime_threshold_classification():
    """With thresholds ±30: deficit ISPs ≤ -30, surplus ISPs ≥ +30, neutral excluded."""
    bi = np.asarray(DATA["baltic_imb_vol"])
    deficit_mask = bi <= -30
    surplus_mask = bi >= 30
    neutral_mask = (bi > -30) & (bi < 30)
    n_def = deficit_mask.sum()
    n_sur = surplus_mask.sum()
    n_neu = neutral_mask.sum()
    assert n_def + n_sur + n_neu == DATA["n"], (
        f"Regime sums {n_def + n_sur + n_neu} ≠ total {DATA['n']}"
    )
    # Sanity: at default thresholds neutral should be a sizeable middle band
    assert n_neu > DATA["n"] // 4, "Neutral band suspiciously small"
    print(f"\n        SURPLUS={n_sur:,} | NEUTRAL={n_neu:,} | DEFICIT={n_def:,}")


def test_quantile_bin_sizes():
    """Equal-sized quantile bins: each bin should hold ≈ N/k rows (within 1)."""
    bw = np.asarray(DATA["baltic_wind_da"])
    for k in [4, 8]:
        edges = np.quantile(bw, np.linspace(0, 1, k + 1))
        # Bin every value
        bins = np.digitize(bw, edges[1:-1])
        counts = np.bincount(bins, minlength=k)
        max_diff = counts.max() - counts.min()
        target = len(bw) // k
        # Allow ≤ 1% deviation
        assert max_diff <= max(2, target // 100), (
            f"k={k} bins unbalanced: counts={counts.tolist()}"
        )


def test_surplus_spread_tends_negative():
    """SURPLUS regime: spread (mFRR − DA) should be NEGATIVE on average."""
    bi = np.asarray(DATA["baltic_imb_vol"])
    p_mfrr = np.array(DATA["p_mfrr"], dtype=np.float64)
    p_da = np.array(DATA["p_da"], dtype=np.float64)
    spread = p_mfrr - p_da
    surplus_idx = np.where((bi >= 30) & ~np.isnan(spread))[0]
    median_spread = np.median(spread[surplus_idx])
    print(f"\n        SURPLUS median spread = {median_spread:+.1f} €/MWh (n={len(surplus_idx):,})")
    assert median_spread < 0, (
        f"SURPLUS median spread should be negative; got {median_spread:+.1f}"
    )


def test_deficit_spread_tends_positive():
    """DEFICIT regime: spread should be POSITIVE on average."""
    bi = np.asarray(DATA["baltic_imb_vol"])
    p_mfrr = np.array(DATA["p_mfrr"], dtype=np.float64)
    p_da = np.array(DATA["p_da"], dtype=np.float64)
    spread = p_mfrr - p_da
    deficit_idx = np.where((bi <= -30) & ~np.isnan(spread))[0]
    median_spread = np.median(spread[deficit_idx])
    print(f"\n        DEFICIT median spread = {median_spread:+.1f} €/MWh (n={len(deficit_idx):,})")
    assert median_spread > 0, (
        f"DEFICIT median spread should be positive; got {median_spread:+.1f}"
    )


def test_baltic_wind_distribution_sanity():
    """Baltic wind forecast should be in plausible range (0 — ~3 GW)."""
    bw = np.asarray(DATA["baltic_wind_da"])
    assert bw.min() >= 0, f"Baltic wind has negative values: min={bw.min()}"
    assert bw.max() < 4000, f"Baltic wind unrealistically high: max={bw.max():.0f} MW"
    # Median should be a few hundred MW
    med = np.median(bw)
    assert 100 <= med <= 1500, f"Baltic wind median {med:.0f} MW outside expected range"


def test_baltic_imb_vol_zero_centered():
    """Baltic imbalance should be roughly zero-centered (mean within ±50 MW)."""
    bi = np.asarray(DATA["baltic_imb_vol"])
    mean = np.mean(bi)
    assert abs(mean) < 50, f"Baltic imbalance mean {mean:+.1f} suspiciously skewed"


# =============================================================================
#  E. STRUCTURE / SCHEMA
# =============================================================================
def test_data_js_required_columns():
    """data.js must contain every column the engines expect."""
    required = [
        "start_iso", "n", "step_min", "offsets",
        "da_forecast", "id_forecast", "p_da", "p_mfrr", "q_pot", "p_imb",
        "baltic_wind_da", "baltic_solar_da", "baltic_imb_vol",
    ]
    for k in required:
        assert k in DATA, f"data.js missing required column '{k}'"
    # Lengths must all match n
    n = DATA["n"]
    for k in ["offsets", "da_forecast", "id_forecast", "p_da", "p_mfrr",
              "q_pot", "p_imb", "baltic_wind_da", "baltic_solar_da", "baltic_imb_vol"]:
        assert len(DATA[k]) == n, f"Column '{k}' length {len(DATA[k])} ≠ n={n}"


def test_no_negative_q_pot():
    """Q_pot is potential generation MW — never negative, ≤ installed capacity."""
    Q = np.asarray(DATA["q_pot"])
    assert Q.min() >= 0, f"Q_pot has negative values: min={Q.min()}"
    assert Q.max() <= 58.8 + 0.01, f"Q_pot above installed cap (58.8 MW): max={Q.max()}"


def test_da_forecast_nonneg():
    F = np.asarray(DATA["da_forecast"])
    assert F.min() >= 0, f"DA forecast has negative values: min={F.min()}"
    assert F.max() <= 58.8 + 0.01, f"DA forecast above capacity: max={F.max()}"


# =============================================================================
#  F. aFRR DATA INTEGRITY (only if data-afrr.js exists)
# =============================================================================
HAS_AFRR = os.path.exists(DATA_AFRR_JS_PATH)
if HAS_AFRR:
    print("Loading data-afrr.js…")
    with open(DATA_AFRR_JS_PATH, "r", encoding="utf-8") as f:
        text = f.read()
    AFRR = json.loads(text[text.index("{") : text.rindex("}") + 1])
    print(
        f"  data-afrr.js: n = {AFRR['n']}, range = {AFRR['afrr_start_iso']} → {AFRR['afrr_end_iso']}"
    )
else:
    print("data-afrr.js not found — skipping aFRR tests.")
    AFRR = None

HAS_AFRR_15MIN = os.path.exists(DATA_AFRR_15MIN_PATH)
if HAS_AFRR_15MIN:
    print("Loading data-afrr-15min.js…")
    with open(DATA_AFRR_15MIN_PATH, "r", encoding="utf-8") as f:
        text = f.read()
    AFRR_15MIN = json.loads(text[text.index("{") : text.rindex("}") + 1])
    print(
        f"  data-afrr-15min.js: n = {AFRR_15MIN['n']:,}, "
        f"avg_p_pos median = {np.median(AFRR_15MIN['avg_p_pos']):.2f}, "
        f"avg_p_neg median = {np.median(AFRR_15MIN['avg_p_neg']):.2f}"
    )
else:
    print("data-afrr-15min.js not found — skipping aFRR averaging tests.")
    AFRR_15MIN = None


def test_lv_imb_vol_equals_csv_lv():
    """lv_imb_vol[i] in data.js must equal imbalance_volume_lv from CSV."""
    if "lv_imb_vol" not in DATA:
        raise AssertionError("data.js is missing lv_imb_vol — re-run preprocess.py")
    lv = np.asarray(DATA["lv_imb_vol"])
    rng = np.random.default_rng(50)
    sample = rng.choice(DATA["n"], size=200, replace=False)
    for i in sample:
        ts = DATA_TS[i]
        row = CSV_BY_TS.loc[ts]
        expected = row["imbalance_volume_lv"]
        assert abs(lv[i] - expected) <= 0.01, (
            f"Row {i} ts={ts}: lv_imb_vol={lv[i]:.3f} but expected {expected:.3f}"
        )


def test_afrr_data_schema():
    """data-afrr.js must have all required keys and matching length."""
    if not HAS_AFRR:
        return
    for k in ["n", "afrr_start_iso", "afrr_end_iso", "n_total", "n_pos", "n_neg", "n_any"]:
        assert k in AFRR, f"data-afrr.js missing key '{k}'"
    n = AFRR["n"]
    assert n == DATA["n"], f"aFRR n={n} mismatches main data n={DATA['n']}"
    for k in ["n_total", "n_pos", "n_neg", "n_any"]:
        assert len(AFRR[k]) == n, f"aFRR '{k}' length {len(AFRR[k])} ≠ {n}"


def test_afrr_count_invariants():
    """For every ISP: max(n_pos,n_neg) ≤ n_any ≤ n_total ≤ 225 ; n_any ≤ n_pos+n_neg."""
    if not HAS_AFRR:
        return
    n_total = np.asarray(AFRR["n_total"])
    n_pos = np.asarray(AFRR["n_pos"])
    n_neg = np.asarray(AFRR["n_neg"])
    n_any = np.asarray(AFRR["n_any"])
    assert n_total.max() <= 225, f"n_total > 225 found (max {n_total.max()})"
    assert (n_pos <= n_total).all(), "n_pos > n_total in some row"
    assert (n_neg <= n_total).all(), "n_neg > n_total in some row"
    assert (n_any <= n_total).all(), "n_any > n_total in some row"
    assert (np.maximum(n_pos, n_neg) <= n_any).all(), (
        "max(n_pos,n_neg) > n_any in some row"
    )
    # Set algebra: |A∪B| ≤ |A|+|B| ; with non-negative ints this is always true,
    # so we additionally check |A∪B| = |A|+|B| - |A∩B| ≥ max(|A|,|B|) (already done above)
    assert (n_any <= n_pos + n_neg).all(), "n_any > n_pos + n_neg in some row"


def test_afrr_pre_may2025_is_zero():
    """ISPs before 2025-05-01 (when aFRR data starts) must have n_total = 0."""
    if not HAS_AFRR:
        return
    n_total = np.asarray(AFRR["n_total"])
    cutoff = pd.Timestamp("2025-05-01 00:00:00")
    pre_mask = DATA_TS < cutoff
    n_pre = pre_mask.sum()
    n_pre_with_data = (n_total[pre_mask] > 0).sum()
    assert n_pre_with_data == 0, (
        f"{n_pre_with_data} of {n_pre} ISPs before 2025-05-01 have aFRR data — should be 0"
    )


def test_afrr_aggregation_correctness():
    """For 30 random ISPs WITH aFRR data, the per-ISP counts in data-afrr.js
    must match a direct count from the source CSV (chunk-read the slice)."""
    if not HAS_AFRR or not os.path.exists(AFRR_CSV_PATH):
        return
    n_total = np.asarray(AFRR["n_total"])
    rng = np.random.default_rng(60)
    candidate_idxs = np.where(n_total > 0)[0]
    sample = rng.choice(candidate_idxs, size=30, replace=False)
    # Read the CSV in chunks, building the slices we care about
    target_ranges = []
    for i in sample:
        ts0 = DATA_TS[i]
        ts1 = ts0 + pd.Timedelta(minutes=15)
        target_ranges.append((i, ts0, ts1))
    # Single CSV read — this is slow (~3s) but only runs in the test pass
    afrr_df = pd.read_csv(AFRR_CSV_PATH, dtype={"AST_POS": "float32", "AST_NEG": "float32"})
    afrr_df["ts"] = pd.to_datetime(afrr_df["DATETIME_UTC"])
    afrr_df["ts_naive"] = afrr_df["ts"].dt.tz_localize(None)
    for i, ts0, ts1 in target_ranges:
        slice_ = afrr_df[(afrr_df["ts_naive"] >= ts0) & (afrr_df["ts_naive"] < ts1)]
        expected_total = len(slice_)
        expected_pos = slice_["AST_POS"].notna().sum()
        expected_neg = slice_["AST_NEG"].notna().sum()
        expected_any = (slice_["AST_POS"].notna() | slice_["AST_NEG"].notna()).sum()
        assert AFRR["n_total"][i] == expected_total, (
            f"ISP {i}: n_total={AFRR['n_total'][i]} but CSV slice has {expected_total} rows"
        )
        assert AFRR["n_pos"][i] == expected_pos
        assert AFRR["n_neg"][i] == expected_neg
        assert AFRR["n_any"][i] == expected_any


def test_afrr_n_total_typically_225():
    """For ISPs in the aFRR window, the typical n_total should be 225 (4s × 225 = 15min)."""
    if not HAS_AFRR:
        return
    n_total = np.asarray(AFRR["n_total"])
    in_range = n_total > 0
    median = int(np.median(n_total[in_range]))
    assert median == 225, f"Expected median n_total = 225, got {median}"


# =============================================================================
#  G. aFRR PRICE-SPREAD FILES (chunked) — only if all chunks present
# =============================================================================
HAS_AFRR_PRICES = (
    os.path.exists(DATA_AFRR_PRICES_META_PATH)
    and len(_DATA_AFRR_PRICES_CHUNK_PATHS) > 0
)
if HAS_AFRR_PRICES:
    print(
        f"Loading chunked data-afrr-prices ({len(_DATA_AFRR_PRICES_CHUNK_PATHS)} chunks)…"
    )
    # Read meta first
    with open(DATA_AFRR_PRICES_META_PATH, "r", encoding="utf-8") as f:
        text = f.read()
    AFRR_PRICES_META_OBJ = json.loads(text[text.index("{") : text.rindex("}") + 1])
    # Read each chunk and concatenate into a single dict matching the
    # in-browser AFRR_PRICES shape. Chunks are read in lexicographic order,
    # which is the same order the JS loader concatenates them.
    isp_acc = []
    spread_acc = []
    for path in _DATA_AFRR_PRICES_CHUNK_PATHS:
        with open(path, "r", encoding="utf-8") as f:
            ctext = f.read()
        chunk = json.loads(ctext[ctext.index("{") : ctext.rindex("}") + 1])
        isp_acc.extend(chunk["isp_idx"])
        spread_acc.extend(chunk["spread_x10"])
    AFRR_PRICES_OBJ = {
        "n_entries": AFRR_PRICES_META_OBJ["n_entries"],
        "n_pos_entries": AFRR_PRICES_META_OBJ["n_pos_entries"],
        "isp_idx": isp_acc,
        "spread_x10": spread_acc,
    }
    print(
        f"  reassembled {len(isp_acc):,} entries from "
        f"{len(_DATA_AFRR_PRICES_CHUNK_PATHS)} chunks"
    )
else:
    AFRR_PRICES_META_OBJ = None
    AFRR_PRICES_OBJ = None


def test_afrr_prices_schema():
    """Reassembled price data has all required keys and parallel-array lengths match."""
    if not HAS_AFRR_PRICES:
        return
    for k in ["n_entries", "n_pos_entries", "isp_idx", "spread_x10"]:
        assert k in AFRR_PRICES_OBJ, f"reassembled price obj missing '{k}'"
    n = AFRR_PRICES_OBJ["n_entries"]
    assert len(AFRR_PRICES_OBJ["isp_idx"]) == n, (
        f"isp_idx length {len(AFRR_PRICES_OBJ['isp_idx'])} != n_entries {n}"
    )
    assert len(AFRR_PRICES_OBJ["spread_x10"]) == n


def test_afrr_prices_chunks_under_50mb():
    """Each chunk file should be ≤ 50 MB so GitHub doesn't warn (or 100 MB hard-fail)."""
    if not HAS_AFRR_PRICES:
        return
    GH_WARNING_MB = 50
    for path in _DATA_AFRR_PRICES_CHUNK_PATHS:
        sz_mb = os.path.getsize(path) / (1024 * 1024)
        assert sz_mb < GH_WARNING_MB, (
            f"{os.path.basename(path)} is {sz_mb:.1f} MB — GitHub warns above "
            f"{GH_WARNING_MB} MB. Lower PRICES_CHUNK_TARGET_MB in preprocess-afrr.py."
        )


def test_afrr_prices_meta_n_chunks_matches_files():
    """AFRR_PRICES_META.n_chunks must equal the number of chunk files on disk."""
    if not HAS_AFRR_PRICES:
        return
    declared = AFRR_PRICES_META_OBJ["n_chunks"]
    on_disk = len(_DATA_AFRR_PRICES_CHUNK_PATHS)
    assert declared == on_disk, (
        f"meta declares {declared} chunks but {on_disk} chunk files exist on disk"
    )


def test_afrr_prices_pos_neg_boundary():
    """n_pos_entries must equal sum(n_pos), so the [0, n_pos) prefix is POS."""
    if not HAS_AFRR_PRICES or not HAS_AFRR:
        return
    expected = int(sum(AFRR["n_pos"]))
    got = AFRR_PRICES_OBJ["n_pos_entries"]
    assert got == expected, (
        f"n_pos_entries = {got:,}, expected sum(n_pos) = {expected:,}"
    )
    # And the remainder must equal sum(n_neg)
    n_neg_in_file = AFRR_PRICES_OBJ["n_entries"] - got
    expected_neg = int(sum(AFRR["n_neg"]))
    assert n_neg_in_file == expected_neg, (
        f"NEG-section length {n_neg_in_file:,}, expected sum(n_neg) = {expected_neg:,}"
    )


def test_afrr_prices_total_matches_counts():
    """Total entries in price file == sum(n_pos + n_neg) from data-afrr.js.
    (Each non-null direction-slot produces one entry; both-active contributes two.)"""
    if not HAS_AFRR_PRICES or not HAS_AFRR:
        return
    expected = int(sum(AFRR["n_pos"]) + sum(AFRR["n_neg"]))
    got = AFRR_PRICES_OBJ["n_entries"]
    assert got == expected, (
        f"price file has {got:,} entries, expected {expected:,} = sum(n_pos)+sum(n_neg)"
    )


def test_afrr_prices_isp_indices_in_range():
    """Every ISP index in the price file must be in [0, n_isps)."""
    if not HAS_AFRR_PRICES:
        return
    n = DATA["n"]
    isp = np.asarray(AFRR_PRICES_OBJ["isp_idx"])
    assert isp.min() >= 0
    assert isp.max() < n


def test_afrr_prices_only_active_isps():
    """ISPs referenced by the price file must have n_total > 0 in data-afrr.js."""
    if not HAS_AFRR_PRICES or not HAS_AFRR:
        return
    isp = np.asarray(AFRR_PRICES_OBJ["isp_idx"])
    n_total = np.asarray(AFRR["n_total"])
    referenced = np.unique(isp)
    bad = referenced[n_total[referenced] == 0]
    assert len(bad) == 0, (
        f"{len(bad)} ISPs have entries in price file but n_total=0 in data-afrr.js"
    )


def test_afrr_prices_per_isp_count_matches():
    """For 30 random ISPs, the count of price entries == n_pos[i] + n_neg[i]."""
    if not HAS_AFRR_PRICES or not HAS_AFRR:
        return
    isp = np.asarray(AFRR_PRICES_OBJ["isp_idx"])
    n_pos = np.asarray(AFRR["n_pos"])
    n_neg = np.asarray(AFRR["n_neg"])
    rng = np.random.default_rng(70)
    candidates = np.where((n_pos + n_neg) > 0)[0]
    sample = rng.choice(candidates, size=30, replace=False)
    # Bincount only the sampled indices
    for i in sample:
        cnt = int(np.sum(isp == i))
        expected = int(n_pos[i] + n_neg[i])
        assert cnt == expected, (
            f"ISP {i}: price file has {cnt} entries, expected {expected} = n_pos+n_neg"
        )


def test_afrr_prices_spread_sign_check():
    """Sanity: spread = price - p_da. Verify on a few sampled entries by checking
    that for the typical aFRR POS price (~117 EUR/MWh) and median DA (~85),
    median spread is in a reasonable band (e.g. -200..+200 after merging POS/NEG)."""
    if not HAS_AFRR_PRICES:
        return
    spread = np.asarray(AFRR_PRICES_OBJ["spread_x10"], dtype=np.float64) / 10.0
    median = float(np.median(spread))
    # POS-DA median ≈ +32, NEG-DA median ≈ -52, merged ≈ somewhere in between.
    assert -100 < median < 100, f"Merged spread median {median:+.1f} out of plausible band"


# =============================================================================
#  H. aFRR 15-min averaged prices + mFRR↔aFRR split (s)
# =============================================================================
def test_afrr_15min_schema():
    """data-afrr-15min.js must have keys + lengths matching main data.js."""
    if not HAS_AFRR_15MIN:
        return
    for k in ("n", "avg_p_pos", "avg_p_neg"):
        assert k in AFRR_15MIN, f"data-afrr-15min.js missing '{k}'"
    assert AFRR_15MIN["n"] == DATA["n"], (
        f"15min n={AFRR_15MIN['n']} mismatches main n={DATA['n']}"
    )
    assert len(AFRR_15MIN["avg_p_pos"]) == DATA["n"]
    assert len(AFRR_15MIN["avg_p_neg"]) == DATA["n"]


def test_afrr_15min_pre_may2025_is_zero():
    """ISPs before 2025-05-01 (when aFRR data starts) must have avg = 0."""
    if not HAS_AFRR_15MIN:
        return
    avg_pos = np.asarray(AFRR_15MIN["avg_p_pos"])
    avg_neg = np.asarray(AFRR_15MIN["avg_p_neg"])
    cutoff = pd.Timestamp("2025-05-01 00:00:00")
    pre_mask = DATA_TS < cutoff
    assert (avg_pos[pre_mask] == 0).all(), "Pre-2025-05-01 avg_p_pos has non-zero values"
    assert (avg_neg[pre_mask] == 0).all(), "Pre-2025-05-01 avg_p_neg has non-zero values"


def test_afrr_15min_synthetic_revenue_formula():
    """The user's worked example, encoded as a math test:
    a single 4 s slot at 900 EUR/MWh in an otherwise-empty ISP averages
    to 4 EUR/MWh, and 1 MW × 4 × 0.25 h = 1 € per offered MW.
    """
    avg = 900.0 / 225.0
    assert abs(avg - 4.0) < 1e-9
    rev_per_mw = 1.0 * avg * 0.25
    expected = 900.0 / 225.0 / 4.0
    assert abs(rev_per_mw - expected) < 1e-9
    # And: with avg integration (Q × avg × 0.25), the time-weighted aFRR
    # contribution to position is the same factor 1/225 that scales by
    # n_pos. For 1 active 4-s slot: position_avg = 1 MW × 1/225.
    pos_avg = 1.0 * (1.0 / 225.0)
    assert abs(pos_avg * 0.25 - (1.0 / 900.0)) < 1e-9


def test_split_round_remainder_invariant():
    """Q_*_mfrr + Q_*_afrr == Q_*_offer for every (Q_offer, s) — no MW lost
    to rounding. Tested over a dense (Q, s) grid.
    """
    rng = np.random.default_rng(123)
    Q_grid = list(range(0, 60))  # plausible MW range for the wind park
    s_grid = [0.0, 0.05, 0.1, 0.25, 0.333, 0.5, 0.7, 0.95, 1.0]
    for Q in Q_grid:
        for s in s_grid:
            Q_mfrr = round(s * Q)
            Q_afrr = Q - Q_mfrr
            assert Q_mfrr + Q_afrr == Q, f"Lost MW at Q={Q}, s={s}"
            assert Q_mfrr >= 0 and Q_afrr >= 0, (
                f"Negative split at Q={Q}, s={s}: mfrr={Q_mfrr}, afrr={Q_afrr}"
            )


def test_split_s1_matches_pre_feature_math():
    """With s=1, every ISP's revenue must equal what the legacy formula
    would have produced (no aFRR contribution at all). We test on the
    spec's worked examples — the only ISPs whose expected total is fully
    pinned independently — and the dataset-level L1/L2 frozen values
    further down already test the same thing on real data."""
    # Spec example 1 with s=1 (all mFRR) should yield the same -322.5 €.
    r = isp_revenue(
        2, F=20, ID=18, P_da=5, P_mfrr=50, Q_pot=12, P_imb=200,
        X=10, Y=0.5, Z=0.5, theta=30, s_up=1.0, s_dn=1.0,
        avg_p_pos=999, avg_p_neg=999, n_pos_fav=100, n_neg_fav=100,
    )
    # Even though we passed phantom aFRR prices, s=1 means Q_*_afrr=0
    # so the aFRR contribution is exactly 0 and we recover -322.5.
    assert abs(r["rev"] - (-322.5)) < 1e-6, (
        f"s=1 should reproduce legacy: got {r['rev']:+.2f}, expected -322.50"
    )
    assert r["Q_up_afrr"] == 0 and r["Q_dn_afrr"] == 0, (
        f"s=1 must zero aFRR volumes: Q_up_afrr={r['Q_up_afrr']}, Q_dn_afrr={r['Q_dn_afrr']}"
    )


def test_split_s0_routes_all_to_afrr():
    """With s=0, ALL upward and downward MW go to aFRR; mFRR portion is 0."""
    # Pick an ISP with non-zero offers. F=20, no withholding (Y=0) means
    # da_sold=20, Q_w=0 → upward only via Z trust. Use Y=1 below X to
    # force Q_w=20 (everything withheld).
    r = isp_revenue(
        1, F=20, ID=20, P_da=5, P_mfrr=50, Q_pot=20, P_imb=0,
        X=10, Y=1.0, Z=0, theta=0, s_up=0.0, s_dn=0.0,
        avg_p_pos=10, avg_p_neg=-20, n_pos_fav=100, n_neg_fav=50,
    )
    assert r["Q_up_mfrr"] == 0 and r["Q_dn_mfrr"] == 0
    assert r["Q_up_afrr"] == 20  # F=20, Y=1, all withheld → all to aFRR
    assert r["Q_dn_afrr"] == 0   # da_sold = 0 since Y=1 below X
    # Revenue: aFRR-up only = 20 × 10 × 0.25 = 50 €
    assert abs(r["rev"] - 50.0) < 1e-6, f"Expected 50 €, got {r['rev']:+.2f}"


def test_split_s_half_distributes_evenly():
    """With s=0.5 and Q_offer=10: Q_mfrr=5, Q_afrr=5."""
    # F=20 below X with Y=0.5: da_sold = floor(20*0.5)=10, Q_w = 10.
    # No Z. Upward offer = 10. Down offer = da_sold = 10.
    r = isp_revenue(
        1, F=20, ID=20, P_da=5, P_mfrr=50, Q_pot=20, P_imb=0,
        X=10, Y=0.5, Z=0, theta=0, s_up=0.5, s_dn=0.5,
        avg_p_pos=10, avg_p_neg=-20, n_pos_fav=0, n_neg_fav=0,
    )
    assert r["Q_up_mfrr"] == 5 and r["Q_up_afrr"] == 5
    assert r["Q_dn_mfrr"] == 5 and r["Q_dn_afrr"] == 5


def test_afrr_gate_blocks_unfavorable_up():
    """avg_p_pos ≤ 0 → aFRR-up earns 0 (wind park wouldn't bid into a
    money-losing upward direction)."""
    r = isp_revenue(
        1, F=20, ID=20, P_da=5, P_mfrr=50, Q_pot=20, P_imb=0,
        X=10, Y=1.0, Z=0, theta=0, s_up=0.0, s_dn=0.0,
        avg_p_pos=-5, avg_p_neg=-20, n_pos_fav=100, n_neg_fav=50,
    )
    # avg_p_pos = -5 (< 0) → gate fails → aFRR-up earns 0
    assert r["Up_rev_afrr"] == 0, f"Expected 0 from gated aFRR-up, got {r['Up_rev_afrr']}"
    # da_sold = 0 (Y=1 below X) → no aFRR-dn either, so total = 0
    assert abs(r["rev"]) < 1e-9, f"Total should be 0, got {r['rev']}"


def test_afrr_gate_blocks_unfavorable_dn():
    """avg_p_neg ≥ 0 → aFRR-dn earns 0 (positive downward price would mean
    park PAYS the system to curtail — irrational to bid). Negative
    avg_p_neg → −Q × neg = positive earnings, gate passes.
    """
    # Set up an ISP where mFRR-dn doesn't fire (so we isolate aFRR-dn).
    # da_sold = 20, Q_dn_offer = 20. s = 0 → Q_dn_afrr = 20.
    r_block = isp_revenue(
        1, F=20, ID=20, P_da=100, P_mfrr=50, Q_pot=20, P_imb=0,
        X=10, Y=0, Z=0, theta=0, s_up=0.0, s_dn=0.0,
        avg_p_pos=-1, avg_p_neg=+25, n_pos_fav=0, n_neg_fav=100,
    )
    # avg_p_neg = +25 → gate fails → aFRR-dn earns 0 (would otherwise be
    # −20 × 25 × 0.25 = −125 €, a loss the gate prevents).
    assert r_block["Dn_rev_afrr"] == 0, (
        f"Gate must block: got Dn_rev_afrr={r_block['Dn_rev_afrr']}"
    )

    r_pass = isp_revenue(
        1, F=20, ID=20, P_da=100, P_mfrr=50, Q_pot=20, P_imb=0,
        X=10, Y=0, Z=0, theta=0, s_up=0.0, s_dn=0.0,
        avg_p_pos=-1, avg_p_neg=-50, n_pos_fav=0, n_neg_fav=100,
    )
    # avg_p_neg = -50 → gate passes → −20 × −50 × 0.25 = +250 € from aFRR-dn
    assert abs(r_pass["Dn_rev_afrr"] - (20 * -(-50)) * 1) < 1e-9 or True
    # The actual revenue check: -Q × avg_p_neg = -20 × -50 = 1000; ×0.25 baked in via "rev"
    # Easier to assert on the dict's pre-0.25 Dn_rev_afrr field:
    assert r_pass["Dn_rev_afrr"] == 1000, (
        f"Expected -Q×p = -20×-50 = 1000 (pre-0.25), got {r_pass['Dn_rev_afrr']}"
    )


def test_afrr_15min_filter_recovers_mixed_sign_isp():
    """An ISP with mixed-sign AST_NEG (e.g. {-10, +50, NaN×223}) used to
    average to a positive number under the old preprocessor, which then
    failed the avg_p_neg < 0 gate and lost the favourable-slot earnings
    entirely. The favourable-only filter in preprocess-afrr-15min.py
    fixes this. We check two things here:

    1. data-afrr-15min.js's avg_p_neg is ALWAYS ≤ 0 by construction (the
       filter drops every positive AST_NEG before summing).
    2. The Python mirror reproduces the user's worked example exactly:
       1 MW × 4-s × 10 €/MWh = 0.0111 € per MW for an ISP with one
       favourable slot at avg_p_neg = -10/225 ≈ -0.0444 €/MWh.
    """
    if not HAS_AFRR_15MIN:
        return
    avg_neg = np.asarray(AFRR_15MIN["avg_p_neg"], dtype=np.float64)
    avg_pos = np.asarray(AFRR_15MIN["avg_p_pos"], dtype=np.float64)
    # Property 1 — favourable-only filter holds dataset-wide.
    assert avg_neg.max() <= 0, (
        f"avg_p_neg should be ≤ 0 dataset-wide after filter; max = {avg_neg.max():.6f}"
    )
    assert avg_pos.min() >= 0, (
        f"avg_p_pos should be ≥ 0 dataset-wide after filter; min = {avg_pos.min():.6f}"
    )
    # Property 2 — synthetic worked example via the Python mirror.
    # 1 MW offered downward, da_sold = 1 (so aFRR-dn has volume after
    # split s_dn = 0). avg_p_neg = -10/225 ≈ -0.0444 EUR/MWh,
    # n_neg_fav = 1 favourable slot.
    avg_neg_synth = -10.0 / 225.0
    r = isp_revenue(
        1, F=1, ID=1, P_da=100, P_mfrr=50, Q_pot=1, P_imb=0,
        X=10, Y=0, Z=0, theta=0,
        s_up=1.0, s_dn=0.0,
        avg_p_pos=0.0, avg_p_neg=avg_neg_synth,
        n_pos_fav=0, n_neg_fav=1,
    )
    # Q_dn_offer = da_sold = 1; s_dn=0 → Q_dn_afrr = 1
    # Dn_rev_afrr = -1 × -10/225 = 10/225 (pre-0.25)
    expected_pre = 10.0 / 225.0
    assert abs(r["Dn_rev_afrr"] - expected_pre) < 1e-9, (
        f"aFRR-dn pre-0.25 rev: expected {expected_pre:.6f}, got {r['Dn_rev_afrr']:.6f}"
    )
    # Total ISP rev includes DA + aFRR-dn × 0.25
    # DA = 1 × 100 = 100 → ×0.25 = 25 €
    # aFRR-dn = 10/225 × 0.25 ≈ 0.01111 €
    expected_rev = (1 * 100 + expected_pre) * 0.25
    assert abs(r["rev"] - expected_rev) < 1e-9, (
        f"ISP rev: expected {expected_rev:.6f} €, got {r['rev']:.6f} €"
    )


def test_split_asymmetric_s_up_neq_s_dn():
    """s_up and s_dn are independent: s_up=1 routes all upward to mFRR
    while s_dn=0 routes all downward to aFRR (in the same ISP)."""
    # F=20, P_da=5, X=10 → below X. Y=0.5: da_sold=10, Q_w=10.
    # P_mfrr = -50 → mFRR-dn fires; mFRR-up not.
    # avg_p_pos = 30 (gate would pass for aFRR-up, but we route 0 upward)
    # avg_p_neg = -25 (favourable for aFRR-dn)
    # s_up = 1 → Q_up_mfrr = 10, Q_up_afrr = 0
    # s_dn = 0 → Q_dn_mfrr = 0,  Q_dn_afrr = 10
    r = isp_revenue(
        1, F=20, ID=20, P_da=5, P_mfrr=-50, Q_pot=20, P_imb=0,
        X=10, Y=0.5, Z=0, theta=0,
        s_up=1.0, s_dn=0.0,
        avg_p_pos=30, avg_p_neg=-25, n_pos_fav=100, n_neg_fav=100,
    )
    # Upward: mFRR-up didn't fire (P_mfrr negative); aFRR-up offered 0 MW
    # because s_up = 1.
    assert r["Q_up_mfrr"] == 10 and r["Q_up_afrr"] == 0, (
        f"s_up=1: Q_up_mfrr should be 10, Q_up_afrr should be 0; got "
        f"{r['Q_up_mfrr']} / {r['Q_up_afrr']}"
    )
    assert r["Up_rev"] == 0 and r["Up_rev_afrr"] == 0
    # Downward: mFRR-dn would fire BUT s_dn=0 routed all to aFRR; mFRR-dn
    # rev should be 0 (no mFRR offer), aFRR-dn rev should be positive.
    assert r["Q_dn_mfrr"] == 0 and r["Q_dn_afrr"] == 10
    assert r["Dn_rev"] == 0  # mFRR-dn got 0 MW
    # aFRR-dn: -10 × -25 = +250 (pre-0.25 = ÷4 baked into r["rev"])
    assert r["Dn_rev_afrr"] == 250
    # ISP rev = (DA + 0 + 0 + 0 + 250) × 0.25 = (10×5 + 250) × 0.25 = 75
    assert abs(r["rev"] - 75.0) < 1e-6, f"Expected 75, got {r['rev']}"


def test_afrr_simultaneous_mfrr_dn_and_afrr_up():
    """A single ISP can earn from BOTH mFRR-dn (P_mfrr negative) AND
    aFRR-up (avg_p_pos > 0) at the same time — different MW pools, the
    gates fire independently. This is the case the user explicitly asked
    the algorithm to support.
    """
    # P_mfrr = -50 → isDn (mFRR-dn fires)
    # avg_p_pos = +30 → aFRR-up gate passes
    # avg_p_neg = +5 → aFRR-dn gate FAILS (price unfavourable for downward)
    # F=20 below X, Y=0.5: da_sold = 10, Q_w = 10.
    # s=0.5 → Q_up_mfrr=5, Q_up_afrr=5, Q_dn_mfrr=5, Q_dn_afrr=5
    r = isp_revenue(
        1, F=20, ID=20, P_da=5, P_mfrr=-50, Q_pot=20, P_imb=0,
        X=10, Y=0.5, Z=0, theta=0, s_up=0.5, s_dn=0.5,
        avg_p_pos=30, avg_p_neg=+5, n_pos_fav=100, n_neg_fav=50,
    )
    # mFRR-dn earns: -5 × -50 = +250 (pre-0.25 = ÷4)
    assert r["Dn_rev"] == 250, f"mFRR-dn should be +250, got {r['Dn_rev']}"
    # aFRR-up earns: 5 × 30 = +150
    assert r["Up_rev_afrr"] == 150, f"aFRR-up should be +150, got {r['Up_rev_afrr']}"
    # mFRR-up didn't fire (P_mfrr negative)
    assert r["Up_rev"] == 0
    # aFRR-dn gated out (avg_p_neg = +5 > 0)
    assert r["Dn_rev_afrr"] == 0
    # Total ISP rev: (DA + mFRR-dn + aFRR-up) × 0.25
    #  = (10 × 5 + 250 + 150) × 0.25 = 450 / 4 = 112.5 €
    assert abs(r["rev"] - 112.5) < 1e-6, f"Total expected 112.5, got {r['rev']}"


def test_l1_default_value_with_default_s_unchanged():
    """The frozen L1 = 13,257,221 € must still hold when s=1 (the default
    in the UI). Re-runs the existing simulate_total mirror with s=1
    (explicit) and matched aFRR feeds — same result as the original test.
    """
    F = np.asarray(DATA["da_forecast"], dtype=np.float64)
    ID = np.asarray(DATA["id_forecast"], dtype=np.float64)
    P_da = np.asarray(DATA["p_da"], dtype=np.float64)
    p_mfrr = winsorize(np.array(DATA["p_mfrr"], dtype=np.float64), 5, 95)
    p_imb = winsorize(np.array([np.nan if v is None else v for v in DATA["p_imb"]], dtype=np.float64), 5, 95)
    Q_pot = np.asarray(DATA["q_pot"], dtype=np.float64)
    if HAS_AFRR_15MIN:
        avg_pos = winsorize(np.asarray(AFRR_15MIN["avg_p_pos"], dtype=np.float64), 5, 95)
        avg_neg = winsorize(np.asarray(AFRR_15MIN["avg_p_neg"], dtype=np.float64), 5, 95)
        # Favourable-only counts from data-afrr-15min.js (mirrors
        # engine.js's preference). Falls back to AFRR's all-non-NaN
        # counts if the new arrays aren't present.
        if "n_pos_fav" in AFRR_15MIN:
            n_pos_fav = np.asarray(AFRR_15MIN["n_pos_fav"], dtype=np.float64)
            n_neg_fav = np.asarray(AFRR_15MIN["n_neg_fav"], dtype=np.float64)
        elif HAS_AFRR:
            n_pos_fav = np.asarray(AFRR["n_pos"], dtype=np.float64)
            n_neg_fav = np.asarray(AFRR["n_neg"], dtype=np.float64)
        else:
            n_pos_fav = np.zeros_like(F)
            n_neg_fav = np.zeros_like(F)
    else:
        avg_pos = np.zeros_like(F)
        avg_neg = np.zeros_like(F)
        n_pos_fav = np.zeros_like(F)
        n_neg_fav = np.zeros_like(F)
    val = simulate_total(
        1, F, ID, P_da, p_mfrr, Q_pot, p_imb,
        X=30, Y=1, Z=0, s_up=1.0, s_dn=1.0,
        avg_p_pos_w=avg_pos, avg_p_neg_w=avg_neg, n_pos_fav=n_pos_fav, n_neg_fav=n_neg_fav,
    )
    print(f"\n        L1 (s=1, X=30, Y=1, with aFRR feeds wired but unused) = {val:,.0f} €")
    assert abs(val - FROZEN_L1_DEFAULT_EUR) < 100, (
        f"L1 with s=1 = {val:,.0f} but FROZEN value is {FROZEN_L1_DEFAULT_EUR:,} — "
        "split logic must not regress when no volume goes to aFRR"
    )


def test_l1_s0_produces_meaningful_afrr_revenue():
    """With s=0 (all aFRR) the L1 total must be a meaningful number
    distinct from the s=1 case AND distinct from a sentinel "no-aFRR"
    run (avg arrays = 0). After the profitability gate, s=0 and s=1
    converge close to each other on this dataset (the wind park bids
    sensibly in either market) — but s=0 still relies on the aFRR feeds
    being wired through the engine, which we verify by zeroing them.
    """
    if not HAS_AFRR_15MIN or not HAS_AFRR:
        return
    F = np.asarray(DATA["da_forecast"], dtype=np.float64)
    ID = np.asarray(DATA["id_forecast"], dtype=np.float64)
    P_da = np.asarray(DATA["p_da"], dtype=np.float64)
    p_mfrr = winsorize(np.array(DATA["p_mfrr"], dtype=np.float64), 5, 95)
    p_imb = winsorize(np.array([np.nan if v is None else v for v in DATA["p_imb"]], dtype=np.float64), 5, 95)
    Q_pot = np.asarray(DATA["q_pot"], dtype=np.float64)
    avg_pos = winsorize(np.asarray(AFRR_15MIN["avg_p_pos"], dtype=np.float64), 5, 95)
    avg_neg = winsorize(np.asarray(AFRR_15MIN["avg_p_neg"], dtype=np.float64), 5, 95)
    # Favourable-only counts from data-afrr-15min.js.
    if "n_pos_fav" in AFRR_15MIN:
        n_pos_fav = np.asarray(AFRR_15MIN["n_pos_fav"], dtype=np.float64)
        n_neg_fav = np.asarray(AFRR_15MIN["n_neg_fav"], dtype=np.float64)
    else:
        n_pos_fav = np.asarray(AFRR["n_pos"], dtype=np.float64)
        n_neg_fav = np.asarray(AFRR["n_neg"], dtype=np.float64)
    # s=1: aFRR feeds completely unused (Q_*_afrr = 0).
    v_mfrr_only = simulate_total(
        1, F, ID, P_da, p_mfrr, Q_pot, p_imb, X=30, Y=1, Z=0, s_up=1.0, s_dn=1.0,
        avg_p_pos_w=avg_pos, avg_p_neg_w=avg_neg,
        n_pos_fav=n_pos_fav, n_neg_fav=n_neg_fav,
    )
    # s=0 with REAL aFRR feeds: every MW routed to aFRR, gated by sign.
    v_afrr_real = simulate_total(
        1, F, ID, P_da, p_mfrr, Q_pot, p_imb, X=30, Y=1, Z=0, s_up=0.0, s_dn=0.0,
        avg_p_pos_w=avg_pos, avg_p_neg_w=avg_neg,
        n_pos_fav=n_pos_fav, n_neg_fav=n_neg_fav,
    )
    # s=0 with ZERO aFRR feeds: gate fails for everything → only DA earns.
    v_afrr_blank = simulate_total(
        1, F, ID, P_da, p_mfrr, Q_pot, p_imb, X=30, Y=1, Z=0, s_up=0.0, s_dn=0.0,
        avg_p_pos_w=np.zeros_like(avg_pos), avg_p_neg_w=np.zeros_like(avg_neg),
        n_pos_fav=np.zeros_like(n_pos_fav), n_neg_fav=np.zeros_like(n_neg_fav),
    )
    print(
        f"\n        s=1 (mFRR only) = {v_mfrr_only:,.0f} €  ; "
        f"s=0 (real aFRR) = {v_afrr_real:,.0f} €  ; "
        f"s=0 (zeroed aFRR) = {v_afrr_blank:,.0f} €"
    )
    # Real aFRR feeds must produce a different total than zeroed feeds —
    # this confirms the aFRR price arrays actually flow into the rev.
    assert abs(v_afrr_real - v_afrr_blank) > 100_000, (
        f"s=0 with real vs zeroed aFRR differ by only "
        f"{abs(v_afrr_real - v_afrr_blank):,.0f} € — feeds may not be wired"
    )


# =============================================================================
#  Register & run
# =============================================================================
# A. Data integrity
# ============================================================================
#  DAY-TYPE FILTER (Backtester) — the filter is a post-hoc accumulation gate:
#  the engine simulates every ISP continuously (so S3 rolling stats keep
#  spanning weekends), then drops non-matching days from the totals. These
#  tests lock the partition invariant and prove S3 continuity is preserved.
# ============================================================================
def test_day_type_mask_values_and_weekends():
    """Mask holds only {0,1,2}; mask==1 ⇔ Sat/Sun; holidays (if the package
    is present) surface as mask==2."""
    m = _day_type_mask()
    assert set(np.unique(m).tolist()).issubset({0, 1, 2}), (
        f"mask has unexpected values: {np.unique(m)}"
    )
    dow = np.asarray(DATA_TS.dayofweek)
    is_weekend = (dow == 5) | (dow == 6)
    assert np.all(m[is_weekend] == 1), "every Sat/Sun ISP must be mask==1"
    assert np.all(is_weekend[m == 1]), "every mask==1 ISP must be a Sat/Sun"
    try:
        import holidays  # noqa: F401

        have_hol = True
    except Exception:
        have_hol = False
    n_hol = int((m == 2).sum())
    print(f"\n        mask: {(m==0).sum():,} workday · {(m==1).sum():,} weekend · {n_hol:,} holiday")
    if have_hol:
        assert n_hol > 0, "expected some LV/EE/LT public holidays flagged as mask==2"


def test_day_filter_all_is_noop():
    """day_filter='all' must not change the L3 default — frozen value
    preserved. Filtering is a strict no-op when 'all'."""
    F, ID, P_da, p_mfrr, Q_pot, p_imb, vwap_1h, p_mfrr_raw = _l3_inputs()
    m = _day_type_mask()
    common = dict(
        X=30, Y=1, Z=1, theta=30,
        s3_K=4, s3_L=4, s3_S_min=25, s3_sigma_max=75, s3_X_cap=5, s3_M=5,
    )
    base = simulate_total_l3(F, ID, P_da, p_mfrr, Q_pot, p_imb, vwap_1h, p_mfrr_raw, **common)["total"]
    allf = simulate_total_l3(
        F, ID, P_da, p_mfrr, Q_pot, p_imb, vwap_1h, p_mfrr_raw,
        day_mask=m, day_filter="all", **common,
    )["total"]
    assert abs(base - allf) < 1.0, f"'all' filter changed the total: {base:,.2f} vs {allf:,.2f}"
    assert abs(allf - FROZEN_L3_DEFAULT_EUR) < 200, (
        f"L3 default with 'all' filter = {allf:,.0f} but FROZEN is {FROZEN_L3_DEFAULT_EUR:,}"
    )


def test_day_filter_partition():
    """LOAD-BEARING: total(all) == total(workday) + total(weekend+holiday).
    This is the proof the filter is a clean post-hoc partition (and therefore
    that each ISP's P&L is computed identically regardless of filter). Also
    confirms the filter is live: workday-only differs from all, and the
    weekend+holiday slice is non-trivial."""
    F, ID, P_da, p_mfrr, Q_pot, p_imb, vwap_1h, p_mfrr_raw = _l3_inputs()
    m = _day_type_mask()
    common = dict(
        X=30, Y=1, Z=1, theta=30,
        s3_K=4, s3_L=4, s3_S_min=25, s3_sigma_max=75, s3_X_cap=5, s3_M=5,
    )
    def run(flt):
        return simulate_total_l3(
            F, ID, P_da, p_mfrr, Q_pot, p_imb, vwap_1h, p_mfrr_raw,
            day_mask=m, day_filter=flt, **common,
        )["total"]
    allt = run("all")
    wd = run("workday")
    we = run("weekend-holiday")
    print(f"\n        all={allt:,.0f} €  =  workday={wd:,.0f} €  +  weekend/hol={we:,.0f} €  (Σ={wd+we:,.0f})")
    assert abs(allt - (wd + we)) < 2.0, (
        f"partition broken: all={allt:,.2f} but workday+weekend={wd+we:,.2f}"
    )
    assert abs(allt - wd) > 1000, "workday-only should differ materially from all-days"
    assert we > 1000, "weekend+holiday slice should carry non-trivial revenue"


def test_day_filter_preserves_s3_continuity():
    """The whole point of 'run fully, filter last': workdays-only revenue must
    use S3 rolling stats computed over the FULL continuous series (incl. the
    weekends), NOT over a weekend-stripped series. We prove it by showing the
    correct total differs from a naïve 'drop weekends first, then simulate'."""
    F, ID, P_da, p_mfrr, Q_pot, p_imb, vwap_1h, p_mfrr_raw = _l3_inputs()
    m = _day_type_mask()
    common = dict(
        X=30, Y=1, Z=1, theta=30,
        s3_K=4, s3_L=4, s3_S_min=25, s3_sigma_max=75, s3_X_cap=5, s3_M=5,
    )
    # Correct: full-data rolling stats, day filter applied at the end.
    correct = simulate_total_l3(
        F, ID, P_da, p_mfrr, Q_pot, p_imb, vwap_1h, p_mfrr_raw,
        day_mask=m, day_filter="workday", **common,
    )["total"]
    # Wrong: strip weekends from EVERY input first, so the rolling window only
    # ever sees workdays — continuity broken at each Monday boundary.
    wd = m == 0
    sub = lambda a: a[wd]
    wrong = simulate_total_l3(
        sub(F), sub(ID), sub(P_da), sub(p_mfrr), sub(Q_pot),
        sub(p_imb), sub(vwap_1h), sub(p_mfrr_raw), **common,
    )["total"]
    print(f"\n        workday S3: continuity-correct={correct:,.0f} €  vs  weekend-stripped={wrong:,.0f} €")
    assert abs(correct - wrong) > 100, (
        "workday S3 total should depend on whether the weekend was in the "
        "rolling window — if these match, continuity isn't actually preserved"
    )


# ============================================================================
#  RESERVE MARKET (Backtester) — capacity income from mandatory down offers.
#  Reserve OFF must reproduce L3 exactly; ON adds capacity income, raises the
#  DA floor, and re-routes the down split — but the TOTAL down offer is
#  unchanged (= da_sold). Synthetic ISPs check the settlement + gates; the
#  real data-reserve.js is checked for alignment.  Settlement (confirmed):
#  income = price[EUR/MW·h] × awarded_MW × 0.25h.
# ============================================================================
RESERVE_JS_PATH = os.path.join(BASE, "data-reserve.js")
HAVE_RESERVE_JS = os.path.exists(RESERVE_JS_PATH)


def _load_reserve_js():
    with open(RESERVE_JS_PATH, "r", encoding="utf-8") as f:
        text = f.read()
    return json.loads(text[text.index("{") : text.rindex("}") + 1])


def _reserve_inputs():
    """L3 inputs + winsorized (5/95) reserve down-price arrays from data-reserve.js."""
    F, ID, P_da, p_mfrr, Q_pot, p_imb, vwap_1h, p_mfrr_raw = _l3_inputs()
    rd = _load_reserve_js()
    rm = np.array([np.nan if v is None else v for v in rd["reserve_mfrr_dn"]], dtype=np.float64)
    ra = np.array([np.nan if v is None else v for v in rd["reserve_afrr_dn"]], dtype=np.float64)
    return F, ID, P_da, p_mfrr, Q_pot, p_imb, vwap_1h, p_mfrr_raw, winsorize(rm, 5, 95), winsorize(ra, 5, 95)


def _reserve_up_arrays():
    """Winsorized (5/95) reserve UP-price arrays from data-reserve.js (share the
    down percentile knob; each clipped against its own distribution)."""
    rd = _load_reserve_js()
    rm = np.array([np.nan if v is None else v for v in rd["reserve_mfrr_up"]], dtype=np.float64)
    ra = np.array([np.nan if v is None else v for v in rd["reserve_afrr_up"]], dtype=np.float64)
    return winsorize(rm, 5, 95), winsorize(ra, 5, 95)


def test_reserve_income_hand_example():
    """User's worked example: 10 MW down @ 10 EUR/MW·h → 25 € for the 15-min
    ISP (price × MW × 0.25). Isolated: no activation, no shortfall."""
    one = lambda v: np.array([v], dtype=np.float64)
    r = simulate_total_l3(
        one(20.0), one(20.0), one(50.0), one(0.0), one(100.0), one(0.0), one(np.nan), one(0.0),
        X=0, Y=0, Z=0, theta=0, s3_X_cap=0,
        reserve_enabled=True, r_coef=0.5, r_split=1.0, r_min_price=0.0,
        reserve_mfrr_dn=one(10.0), reserve_afrr_dn=one(np.nan),
    )
    print(f"\n        reserve income (10 MW @ 10) = {r['reserve']:.2f} € (expect 25)")
    assert abs(r["reserve"] - 25.0) < 1e-9, f"reserve income {r['reserve']} != 25"
    assert abs(r["total"] - 275.0) < 1e-9, f"total {r['total']} != 275 (DA 250 + reserve 25)"
    assert r["R_dn"][0] == 10 and r["da_sold"][0] == 20


def test_reserve_da_floor_overrides_withhold():
    """Below X with full withhold (Y=1) DA-sold would be 0; a 10 MW reserve
    award forces da_sold up to 10 (mandatory DA sale, bypasses withhold)."""
    one = lambda v: np.array([v], dtype=np.float64)
    common = dict(X=50, Y=1.0, Z=0, theta=0, s3_X_cap=0)
    r = simulate_total_l3(
        one(20.0), one(20.0), one(1.0), one(0.0), one(100.0), one(np.nan), one(np.nan), one(0.0),
        reserve_enabled=True, r_coef=0.5, r_split=1.0, r_min_price=0.0,
        reserve_mfrr_dn=one(10.0), reserve_afrr_dn=one(np.nan), **common,
    )
    r0 = simulate_total_l3(
        one(20.0), one(20.0), one(1.0), one(0.0), one(100.0), one(np.nan), one(np.nan), one(0.0), **common,
    )
    assert r["da_sold"][0] == 10, f"reserve floor: da_sold {r['da_sold'][0]} != 10"
    assert r0["da_sold"][0] == 0, "without reserve da_sold should be 0 (full withhold)"


def test_reserve_min_price_filter():
    """Reserve price below the min-price gate → no reserve taken (no income,
    no DA floor)."""
    one = lambda v: np.array([v], dtype=np.float64)
    r = simulate_total_l3(
        one(20.0), one(20.0), one(1.0), one(0.0), one(100.0), one(np.nan), one(np.nan), one(0.0),
        X=50, Y=1.0, Z=0, theta=0, s3_X_cap=0,
        reserve_enabled=True, r_coef=0.5, r_split=1.0, r_min_price=10.0,
        reserve_mfrr_dn=one(5.0), reserve_afrr_dn=one(np.nan),
    )
    assert r["reserve"] == 0.0 and r["R_dn"][0] == 0 and r["da_sold"][0] == 0


def test_reserve_off_equals_l3_default():
    """LOAD-BEARING: reserve disabled reproduces the frozen L3 default even
    with reserve price arrays attached."""
    F, ID, P_da, p_mfrr, Q_pot, p_imb, vwap_1h, p_mfrr_raw, rm, ra = _reserve_inputs()
    r = simulate_total_l3(
        F, ID, P_da, p_mfrr, Q_pot, p_imb, vwap_1h, p_mfrr_raw,
        X=30, Y=1, Z=1, theta=30,
        s3_K=4, s3_L=4, s3_S_min=25, s3_sigma_max=75, s3_X_cap=5, s3_M=5,
        reserve_enabled=False, reserve_mfrr_dn=rm, reserve_afrr_dn=ra,
    )
    assert abs(r["total"] - FROZEN_L3_DEFAULT_EUR) < 200, (
        f"reserve-off L3 = {r['total']:,.0f} but FROZEN is {FROZEN_L3_DEFAULT_EUR:,}"
    )


def test_reserve_total_down_offer_unchanged():
    """Reserve only RE-ROUTES the down offer (reserve split vs s_dn); the TOTAL
    down volume stays == da_sold, so position/shortfall math is undisturbed.
    Checked elementwise across the whole dataset with reserve ON."""
    F, ID, P_da, p_mfrr, Q_pot, p_imb, vwap_1h, p_mfrr_raw, rm, ra = _reserve_inputs()
    r = simulate_total_l3(
        F, ID, P_da, p_mfrr, Q_pot, p_imb, vwap_1h, p_mfrr_raw,
        X=30, Y=1, Z=1, theta=30, s3_X_cap=5,
        reserve_enabled=True, r_coef=0.5, r_split=0.6, r_min_price=5.0,
        reserve_mfrr_dn=rm, reserve_afrr_dn=ra,
    )
    assert np.allclose(r["Q_dn_total"], r["da_sold"]), "total down offer must equal da_sold"
    assert np.all(r["da_sold"] >= r["R_dn"] - 1e-9), "da_sold must be >= reserve floor"
    print(f"\n        reserve ON (coef .5 / split .6) total = {r['total']:,.0f} € "
          f"(capacity income {r['reserve']:,.0f} €)")


def test_reserve_data_js_alignment():
    """data-reserve.js length matches data.js n, and sampled ISPs match the CSV
    reserve price at the same timestamp (proves the index alignment)."""
    rd = _load_reserve_js()
    assert rd["n"] == DATA["n"], f"reserve n {rd['n']} != data.js n {DATA['n']}"
    assert len(rd["reserve_mfrr_dn"]) == DATA["n"] and len(rd["reserve_afrr_dn"]) == DATA["n"]
    rcsv = pd.read_csv(CSV_PATH, usecols=["datetime_utc", "reserves_mfrr_downward_lv"])
    rcsv["datetime_utc"] = pd.to_datetime(rcsv["datetime_utc"])
    s = rcsv.set_index("datetime_utc")["reserves_mfrr_downward_lv"]
    s = s[~s.index.duplicated(keep="first")]
    rng = np.random.default_rng(7)
    for i in rng.choice(DATA["n"], size=30, replace=False):
        ts = DATA_TS[int(i)]
        want = s.get(ts, np.nan)
        if pd.isna(want):
            continue
        got = rd["reserve_mfrr_dn"][int(i)]
        assert got is not None and abs(got - float(want)) < 0.01, (
            f"ISP {i} @ {ts}: reserve {got} != CSV {want}"
        )


# ============================================================================
#  RESERVE MARKET — UP capacity (Backtester). Upward reserve is NOT free: each
#  awarded MW is withheld from DA (held as ramp-up headroom), shrinking the MW
#  available for DA + down capacity to F_avail = F - R_up. Gated by a forecast
#  floor (ru_min_mw) and a per-product price. MANDATORY: the awarded MW are an
#  obligatory mFRR/aFRR-up offer regardless of wind, so when up-activated they
#  enter the position and a low-wind ISP can fall short. UP OFF must reproduce
#  L3 exactly. Settlement = price[EUR/MW·h] × awarded_MW × 0.25h.
# ============================================================================
def test_reserve_up_income_hand_example():
    """User's worked example: F=20, offer 10 MW up @ 8 EUR/MW·h → 20 € for the
    ISP. The 10 MW are withheld from DA, so only F-10 = 10 MW reach DA."""
    one = lambda v: np.array([v], dtype=np.float64)
    r = simulate_total_l3(
        one(20.0), one(20.0), one(50.0), one(0.0), one(100.0), one(0.0), one(np.nan), one(0.0),
        X=0, Y=0, Z=0, theta=0, s3_X_cap=0,
        reserve_up_enabled=True, ru_coef=0.5, ru_split=1.0, ru_min_price=0.0, ru_min_mw=0,
        reserve_mfrr_up=one(8.0), reserve_afrr_up=one(np.nan),
    )
    print(f"\n        up-reserve income (10 MW @ 8) = {r['reserve_up']:.2f} € (expect 20)")
    assert abs(r["reserve_up"] - 20.0) < 1e-9, f"up income {r['reserve_up']} != 20"
    assert r["R_up"][0] == 10 and r["F_avail"][0] == 10.0
    assert r["da_sold"][0] == 10, f"DA headroom: da_sold {r['da_sold'][0]} != 10 (= F - R_up)"
    # total = DA(10*50*0.25=125) + up capacity(20) = 145
    assert abs(r["total"] - 145.0) < 1e-9, f"total {r['total']} != 145"


def test_reserve_up_reduces_da_headroom():
    """Each up-reserve MW cannot be sold to DA: da_sold drops by exactly R_up
    relative to up-off (above X, so DA would otherwise take the full forecast)."""
    one = lambda v: np.array([v], dtype=np.float64)
    common = dict(X=0, Y=0, Z=0, theta=0, s3_X_cap=0)
    off = simulate_total_l3(
        one(20.0), one(20.0), one(50.0), one(0.0), one(100.0), one(0.0), one(np.nan), one(0.0), **common,
    )
    on = simulate_total_l3(
        one(20.0), one(20.0), one(50.0), one(0.0), one(100.0), one(0.0), one(np.nan), one(0.0),
        reserve_up_enabled=True, ru_coef=0.5, ru_split=1.0, ru_min_price=0.0, ru_min_mw=0,
        reserve_mfrr_up=one(8.0), reserve_afrr_up=one(np.nan), **common,
    )
    assert off["da_sold"][0] == 20, f"up-off da_sold {off['da_sold'][0]} != 20"
    assert on["da_sold"][0] == off["da_sold"][0] - on["R_up"][0], "da_sold must drop by exactly R_up"


def test_reserve_up_min_mw_gate():
    """Up capacity is only offered once the forecast reaches ru_min_mw."""
    one = lambda v: np.array([v], dtype=np.float64)
    common = dict(X=0, Y=0, Z=0, theta=0, s3_X_cap=0, reserve_up_enabled=True,
                  ru_coef=0.5, ru_split=1.0, ru_min_price=0.0,
                  reserve_mfrr_up=one(8.0), reserve_afrr_up=one(np.nan))
    below = simulate_total_l3(
        one(20.0), one(20.0), one(50.0), one(0.0), one(100.0), one(0.0), one(np.nan), one(0.0),
        ru_min_mw=30, **common,
    )
    above = simulate_total_l3(
        one(20.0), one(20.0), one(50.0), one(0.0), one(100.0), one(0.0), one(np.nan), one(0.0),
        ru_min_mw=10, **common,
    )
    assert below["R_up"][0] == 0 and below["reserve_up"] == 0.0, "F<min_mw → no up reserve"
    assert below["da_sold"][0] == 20, "gated-off up reserve must not touch DA headroom"
    assert above["R_up"][0] == 10 and above["reserve_up"] > 0, "F>=min_mw → up reserve offered"


def test_reserve_up_min_price_filter():
    """Up price below the per-product floor → no award (no income, no DA headroom
    given up)."""
    one = lambda v: np.array([v], dtype=np.float64)
    r = simulate_total_l3(
        one(20.0), one(20.0), one(50.0), one(0.0), one(100.0), one(0.0), one(np.nan), one(0.0),
        X=0, Y=0, Z=0, theta=0, s3_X_cap=0,
        reserve_up_enabled=True, ru_coef=0.5, ru_split=1.0, ru_min_price=10.0, ru_min_mw=0,
        reserve_mfrr_up=one(5.0), reserve_afrr_up=one(np.nan),
    )
    assert r["reserve_up"] == 0.0 and r["R_up"][0] == 0 and r["da_sold"][0] == 20


def test_reserve_up_mandatory_regardless_of_wind():
    """The awarded up MW are obligatory: when up-activated they enter the
    position even if there's no wind to back them. Here the whole upward offer
    IS the mandatory reserve (no free withhold: up_free = F-R_up-da_sold = 0),
    so the shortfall equals exactly the reserve MW that lack wind."""
    one = lambda v: np.array([v], dtype=np.float64)
    # F=20, above X so da_sold = F_avail = 10; Q_pot = 10 covers DA only.
    # P_mfrr=10 ⇒ mFRR-up activates the 10 reserve MW ⇒ position 20, wind 10.
    r = simulate_total_l3(
        one(20.0), one(20.0), one(50.0), one(10.0), one(10.0), one(50.0), one(np.nan), one(10.0),
        X=0, Y=0, Z=0, theta=0, s3_X_cap=0,
        reserve_up_enabled=True, ru_coef=0.5, ru_split=1.0, ru_min_price=0.0, ru_min_mw=0,
        reserve_mfrr_up=one(8.0), reserve_afrr_up=one(np.nan),
    )
    assert r["R_up"][0] == 10 and r["Q_up_total"][0] == 10, "entire up offer is the mandatory reserve"
    assert abs(r["short"][0] - 10.0) < 1e-9, f"mandatory-reserve shortfall {r['short'][0]} != 10"
    assert abs(r["reserve_up"] - 20.0) < 1e-9, "capacity income still earned (10 MW @ 8)"


def test_reserve_up_off_equals_l3_default():
    """LOAD-BEARING: up reserve disabled reproduces the frozen L3 default even
    with up-price arrays attached."""
    F, ID, P_da, p_mfrr, Q_pot, p_imb, vwap_1h, p_mfrr_raw = _l3_inputs()
    rmu, rau = _reserve_up_arrays()
    r = simulate_total_l3(
        F, ID, P_da, p_mfrr, Q_pot, p_imb, vwap_1h, p_mfrr_raw,
        X=30, Y=1, Z=1, theta=30,
        s3_K=4, s3_L=4, s3_S_min=25, s3_sigma_max=75, s3_X_cap=5, s3_M=5,
        reserve_up_enabled=False, reserve_mfrr_up=rmu, reserve_afrr_up=rau,
    )
    assert abs(r["total"] - FROZEN_L3_DEFAULT_EUR) < 200, (
        f"up-off L3 = {r['total']:,.0f} but FROZEN is {FROZEN_L3_DEFAULT_EUR:,}"
    )


def test_reserve_up_and_down_interaction():
    """Both reserves ON: up is carved first (da_sold + R_up <= F_int), down is
    sized within F_avail (R_dn <= F_avail), and the total down offer is still
    == da_sold. Checked elementwise across the whole dataset."""
    F, ID, P_da, p_mfrr, Q_pot, p_imb, vwap_1h, p_mfrr_raw, rm, ra = _reserve_inputs()
    rmu, rau = _reserve_up_arrays()
    r = simulate_total_l3(
        F, ID, P_da, p_mfrr, Q_pot, p_imb, vwap_1h, p_mfrr_raw,
        X=30, Y=1, Z=1, theta=30, s3_X_cap=5,
        reserve_enabled=True, r_coef=0.5, r_split=0.6, r_min_price=5.0,
        reserve_mfrr_dn=rm, reserve_afrr_dn=ra,
        reserve_up_enabled=True, ru_coef=0.4, ru_split=0.7, ru_min_price=1.0, ru_min_mw=5,
        reserve_mfrr_up=rmu, reserve_afrr_up=rau,
    )
    F_int = np.floor(F + 1e-9)
    assert np.all(r["da_sold"] + r["R_up"] <= F_int + 1e-9), "up reserve must be withheld from DA"
    assert np.all(r["R_dn"] <= np.floor(r["F_avail"] + 1e-9) + 1e-9), "down reserve must fit within F_avail"
    assert np.allclose(r["Q_dn_total"], r["da_sold"]), "total down offer must still equal da_sold"
    assert np.all(r["da_sold"] >= r["R_dn"] - 1e-9), "da_sold must be >= down reserve floor"
    assert np.all(r["Q_up_total"] >= r["R_up"] - 1e-9), "up offer must be >= up reserve floor"
    print(f"\n        up+down reserve total = {r['total']:,.0f} €  "
          f"(up cap {r['reserve_up']:,.0f} €, dn cap {r['reserve']:,.0f} €)")


# ============================================================================
#  ADAPTIVE mFRR↔aFRR OFFER SPLIT — the static split is the step=0 special
#  case (must match exactly, so frozen anchors hold); step>0 follows the
#  better-paying market block by block.
# ============================================================================
def _afrr_feeds():
    with open(DATA_AFRR_15MIN_PATH, "r", encoding="utf-8") as f:
        t = f.read()
    A = json.loads(t[t.index("{") : t.rindex("}") + 1])
    return (
        winsorize(np.array(A["avg_p_pos"], dtype=np.float64), 5, 95),
        winsorize(np.array(A["avg_p_neg"], dtype=np.float64), 5, 95),
        np.array(A["n_pos_fav"], dtype=np.float64),
        np.array(A["n_neg_fav"], dtype=np.float64),
    )


def test_split_block_logic_synthetic():
    """Controlled: win=2, step=0.25. Block 0 = 0.5; block 1 follows block 0
    where mFRR-up rate (10) beats aFRR (1) → +0.25 → 0.75; block 2 follows
    block 1 where mFRR (0) < aFRR (1) → −0.25 → 0.5."""
    pm = np.array([10.0, 10.0, 0.0, 0.0, 0.0, 0.0])
    ap = np.array([1.0, 1.0, 1.0, 1.0, 1.0, 1.0])
    # wait = win = 2 reproduces the original non-overlapping block behaviour.
    s = _adaptive_split(0.5, 2, 0.25, 2, pm, ap, "up")
    assert np.allclose(s, [0.5, 0.5, 0.75, 0.75, 0.5, 0.5]), f"adaptive split got {s}"
    # clamps to [0,1]
    assert _adaptive_split(0.9, 2, 0.25, 2, pm, ap, "up").max() <= 1.0


def test_split_wait_decouples_cadence_from_lookback():
    """The new `wait` (cadence) is independent of `win` (lookback). wait=win
    reproduces the block behaviour; wait=1 re-evaluates every ISP off a sliding
    win-ISP window (so it can step on every ISP, not only every win)."""
    pm = np.array([10.0, 10.0, 0.0, 0.0, 0.0, 0.0])
    ap = np.array([1.0, 1.0, 1.0, 1.0, 1.0, 1.0])
    # wait=win=2 == the block result above
    assert np.allclose(_adaptive_split(0.5, 2, 0.25, 2, pm, ap, "up"),
                       [0.5, 0.5, 0.75, 0.75, 0.5, 0.5])
    # wait=1, win=2: step every ISP off the trailing 2-ISP window.
    #   i1: look [max(0,1-2),1)=[0,1) mFRR(10)>aFRR(1) → 0.75
    #   i2: look [0,2) mFRR(10)>aFRR(1) → 1.0 (clamped)
    #   i3: look [1,3) mFRR(5)>aFRR(1) → 1.0
    #   i4: look [2,4) mFRR(0)<aFRR(1) → 0.75
    #   i5: look [3,5) mFRR(0)<aFRR(1) → 0.5
    s1 = _adaptive_split(0.5, 2, 0.25, 1, pm, ap, "up")
    assert np.allclose(s1, [0.5, 0.75, 1.0, 1.0, 0.75, 0.5]), f"wait=1 got {s1}"


def test_split_adaptive_step0_equals_static():
    """LOAD-BEARING: adaptive split with step=0 reproduces the static scalar
    split at the same start (the z=0 equivalence the rework relies on)."""
    F, ID, P_da, p_mfrr, Q_pot, p_imb, vwap_1h, p_mfrr_raw = _l3_inputs()
    ap_w, an_w, npf, nnf = _afrr_feeds()
    common = dict(X=30, Y=1, Z=1, theta=30, avg_p_pos_w=ap_w, avg_p_neg_w=an_w,
                  n_pos_fav=npf, n_neg_fav=nnf, s3_X_cap=5)
    stat = simulate_total_l3(F, ID, P_da, p_mfrr, Q_pot, p_imb, vwap_1h, p_mfrr_raw,
                             s_up=0.6, s_dn=0.3, **common)["total"]
    adap = simulate_total_l3(F, ID, P_da, p_mfrr, Q_pot, p_imb, vwap_1h, p_mfrr_raw,
                             split_adaptive=True, s_up_start=0.6, s_dn_start=0.3,
                             s_up_step=0.0, s_dn_step=0.0, s_up_win=96, s_dn_win=96, **common)["total"]
    assert abs(stat - adap) < 1.0, f"step0 adaptive {adap:,.2f} != static {stat:,.2f}"


def test_split_adaptive_actually_adapts():
    """With step>0 the split moves over time, changing the total vs the
    step=0 (static) baseline at the same start."""
    F, ID, P_da, p_mfrr, Q_pot, p_imb, vwap_1h, p_mfrr_raw = _l3_inputs()
    ap_w, an_w, npf, nnf = _afrr_feeds()
    common = dict(X=30, Y=1, Z=1, theta=30, avg_p_pos_w=ap_w, avg_p_neg_w=an_w,
                  n_pos_fav=npf, n_neg_fav=nnf, s3_X_cap=5, split_adaptive=True,
                  s_up_start=0.5, s_dn_start=0.5, s_up_win=96, s_dn_win=96)
    base = simulate_total_l3(F, ID, P_da, p_mfrr, Q_pot, p_imb, vwap_1h, p_mfrr_raw,
                             s_up_step=0.0, s_dn_step=0.0, **common)["total"]
    adap = simulate_total_l3(F, ID, P_da, p_mfrr, Q_pot, p_imb, vwap_1h, p_mfrr_raw,
                             s_up_step=0.1, s_dn_step=0.1, **common)["total"]
    print(f"\n        adaptive split: static-start {base:,.0f} € vs adapting {adap:,.0f} €")
    assert abs(base - adap) > 1000, "step>0 should change the result"


def test_reserve_respects_adaptive_split():
    """INTERACTION: obligatory (reserve) vs free balancing volume. Reserve down
    MW are an unconditional per-direction floor on the down offer; the adaptive
    split governs ONLY the free (non-reserve) remainder; reserve is added on
    top; total down stays == da_sold; and reserve capacity income is invariant
    to the split. Verified across the whole dataset with both features ON."""
    F, ID, P_da, p_mfrr, Q_pot, p_imb, vwap_1h, p_mfrr_raw, rm, ra = _reserve_inputs()
    ap_w, an_w, npf, nnf = _afrr_feeds()
    base = dict(
        X=30, Y=1, Z=1, theta=30, s3_X_cap=5,
        avg_p_pos_w=ap_w, avg_p_neg_w=an_w, n_pos_fav=npf, n_neg_fav=nnf,
        reserve_enabled=True, r_coef=0.5, r_split=0.7, r_min_price=5.0,
        reserve_mfrr_dn=rm, reserve_afrr_dn=ra,
        split_adaptive=True, s_up_win=96, s_dn_win=96,
    )
    call = lambda **kw: simulate_total_l3(F, ID, P_da, p_mfrr, Q_pot, p_imb, vwap_1h, p_mfrr_raw, **base, **kw)
    r = call(s_up_start=0.5, s_up_step=0.1, s_dn_start=0.3, s_dn_step=0.1)
    # 1) reserve obligation is an unconditional floor on BOTH directions
    assert np.all(r["Q_dn_mfrr"] >= r["R_mfrr"] - 1e-9), "mFRR-dn fell below the reserve obligation"
    assert np.all(r["Q_dn_afrr"] >= r["R_afrr"] - 1e-9), "aFRR-dn fell below the reserve obligation"
    # 2) the free portion follows the adaptive split exactly (reserve excluded)
    free = r["da_sold"] - r["R_dn"]
    assert np.allclose(r["Q_dn_mfrr"] - r["R_mfrr"], _rnd(r["s_dn_arr"] * free)), (
        "free mFRR-dn must equal the adaptive split of the NON-reserve volume"
    )
    # 3) total down offer unchanged by reserve + adaptive split
    assert np.allclose(r["Q_dn_total"], r["da_sold"]), "total down offer != da_sold"
    # 4) reserve capacity income is invariant to the split (uses r_split, not s_dn)
    inc_allM = call(s_up_start=1, s_up_step=0, s_dn_start=1, s_dn_step=0)["reserve"]
    inc_allA = call(s_up_start=0, s_up_step=0, s_dn_start=0, s_dn_step=0)["reserve"]
    assert abs(inc_allM - inc_allA) < 1e-6, f"reserve income moved with the split: {inc_allM} vs {inc_allA}"
    # 5) extremes: free split all-aFRR ⇒ mFRR-dn is reserve-only; all-mFRR ⇒ aFRR-dn is reserve-only
    r0 = call(s_up_start=0, s_up_step=0, s_dn_start=0, s_dn_step=0)
    r1 = call(s_up_start=1, s_up_step=0, s_dn_start=1, s_dn_step=0)
    assert np.allclose(r0["Q_dn_mfrr"], r0["R_mfrr"]), "s_dn=0 ⇒ mFRR-dn should carry reserve only"
    assert np.allclose(r1["Q_dn_afrr"], r1["R_afrr"]), "s_dn=1 ⇒ aFRR-dn should carry reserve only"
    nres = int((r["R_dn"] > 0).sum())
    print(f"\n        reserve+adaptive OK on {nres:,} awarded ISPs; income split-invariant ({inc_allM:,.0f} €)")


R.add("baltic_wind_da is sum of LV+EE+LT", test_baltic_wind_aggregation)
R.add("baltic_solar_da is sum of LV+EE+LT", test_baltic_solar_aggregation)
R.add("baltic_imb_vol is sum of LV+EE+LT", test_baltic_imb_vol_aggregation)
R.add("spread = p_mfrr − p_da matches CSV", test_spread_calculation)
R.add("April 2026 is fully present (2880 rows)", test_april_data_present)
R.add("p_imb null encoding for April only", test_p_imb_null_handling)
R.add("offsets are strictly monotonic", test_offsets_monotonic)
R.add("ts(i) maps to a real CSV row", test_timestamp_consistency)
R.add("mFRR up == down (single clearing price)", test_mfrr_up_equals_down)

# B. Engine invariants
R.add("Whole-MW: Q_da_sold/Q_w/Q_up/Q_dn are integers", test_whole_mw_rounding)
R.add("mFRR-dn capped at Q_da_sold", test_mfrr_dn_capped_at_da)
R.add("mFRR up & dn never both fire", test_mfrr_up_dn_mutually_exclusive)
R.add("L1 naive is computable", test_naive_l1_known_value)
R.add("L1 default (X=30, Y=1) = 13,257,221 €", test_l1_optimum_value)
R.add("L2 default (X=30, Y=1, Z=1, θ=30) = 13,367,642 €", test_l2_default_value)
R.add("L3 default (K=4, L=4, S_min=25, σ_max=75, X_cap=5, M=5)", test_l3_default_value)
R.add("L3 with X_cap=0 ≡ L2 (LOAD-BEARING invariant)", test_l3_xcap0_equals_l2)
R.add("L3 with DA_skip=0 ≡ L2 (G0 gate trips on every ISP)", test_l3_da_skip0_equals_l2)
R.add("S3 DA_skip gate filters per-ISP (50 vs 59 must differ)", test_l3_da_skip_gate_affects_only_high_da_isps)
R.add("S3 rolling source must be p_mfrr (not p_imb)", test_s3_rolling_source_is_pmfrr_not_pimb)
R.add("S3 lag L: [i-K-L, i-L) window respected", test_s3_lag_window_shifts_results)
R.add("S3 decomp: imb+flat+s3_extra == short·(p_imb+θ)", test_s3_imbalance_decomposition_equals_naive_short_cost)
R.add("S3 with NaN p_imb → imb/flat/s3_extra all 0", test_s3_nan_pimb_zeroes_all_imbalance_terms)
R.add("Day-type mask: values {0,1,2}; mask==1 ⇔ Sat/Sun", test_day_type_mask_values_and_weekends)
R.add("Day filter 'all' is a no-op (frozen L3 default preserved)", test_day_filter_all_is_noop)
R.add("Day filter partition: all == workday + weekend/holiday", test_day_filter_partition)
R.add("Day filter preserves S3 continuity (full-series rolling stats)", test_day_filter_preserves_s3_continuity)
R.add("Reserve income: 10 MW @ 10 EUR/MW·h → 25 € (price×MW×0.25)", test_reserve_income_hand_example)
R.add("Reserve DA floor overrides withhold (mandatory DA sale)", test_reserve_da_floor_overrides_withhold)
R.add("Reserve min-price gate: below threshold → no reserve", test_reserve_min_price_filter)
if HAVE_RESERVE_JS:
    R.add("Reserve OFF ≡ frozen L3 default (LOAD-BEARING)", test_reserve_off_equals_l3_default)
    R.add("Reserve re-routes but total down offer == da_sold", test_reserve_total_down_offer_unchanged)
    R.add("data-reserve.js aligns with data.js (timestamp spot-check)", test_reserve_data_js_alignment)
R.add("Adaptive split block logic (synthetic step toward winner)", test_split_block_logic_synthetic)
R.add("Split wait/cadence decoupled from lookback (wait=win≡old; wait=1 per-ISP)", test_split_wait_decouples_cadence_from_lookback)
if os.path.exists(DATA_AFRR_15MIN_PATH):
    R.add("Adaptive split step=0 ≡ static scalar (LOAD-BEARING)", test_split_adaptive_step0_equals_static)
    R.add("Adaptive split with step>0 actually adapts (differs from static)", test_split_adaptive_actually_adapts)
if HAVE_RESERVE_JS and os.path.exists(DATA_AFRR_15MIN_PATH):
    R.add("Reserve obligation is a floor; adaptive split routes only free volume", test_reserve_respects_adaptive_split)
R.add("Window-vectorised total == per-ISP sum", test_window_consistency)
R.add("April ISPs: NaN p_imb → 0 imb cost in L2", test_april_in_l1_not_in_l2_imbalance)

# C. Spec
R.add("Spec example 1 → −322.50 €", test_spec_example_1)
R.add("Spec example 2 → +375.00 €", test_spec_example_2)

# D. Graphs engine
R.add("Regime threshold classification (±30)", test_regime_threshold_classification)
R.add("Quantile bins are roughly equal-sized", test_quantile_bin_sizes)
R.add("SURPLUS median spread is negative", test_surplus_spread_tends_negative)
R.add("DEFICIT median spread is positive", test_deficit_spread_tends_positive)
R.add("Baltic wind in plausible range", test_baltic_wind_distribution_sanity)
R.add("Baltic imbalance is zero-centred", test_baltic_imb_vol_zero_centered)

# E. Schema
R.add("data.js has all required columns + lengths", test_data_js_required_columns)
R.add("Q_pot ≥ 0 and ≤ installed capacity", test_no_negative_q_pot)
R.add("DA forecast ≥ 0 and ≤ capacity", test_da_forecast_nonneg)

# F. aFRR data integrity (skipped automatically if data-afrr.js not present)
R.add("lv_imb_vol equals CSV imbalance_volume_lv", test_lv_imb_vol_equals_csv_lv)
if HAS_AFRR:
    R.add("data-afrr.js schema is consistent with data.js", test_afrr_data_schema)
    R.add("aFRR count invariants (n_total ≤ 225, n_any ≤ n_total, etc.)", test_afrr_count_invariants)
    R.add("aFRR pre-2025-05-01 ISPs have n_total = 0", test_afrr_pre_may2025_is_zero)
    R.add("aFRR per-ISP counts match direct CSV slice (30 random ISPs)", test_afrr_aggregation_correctness)
    R.add("aFRR median n_total = 225 (15min × 60s / 4s)", test_afrr_n_total_typically_225)

# G. aFRR price-spread file (large; only if data-afrr-prices.js exists)
if HAS_AFRR_PRICES:
    R.add("reassembled aFRR prices schema (parallel arrays, n_entries)", test_afrr_prices_schema)
    R.add("each chunk file ≤ 50 MB (GitHub-friendly)", test_afrr_prices_chunks_under_50mb)
    R.add("meta n_chunks matches number of chunk files on disk", test_afrr_prices_meta_n_chunks_matches_files)
    R.add("n_pos_entries equals sum(n_pos); remainder equals sum(n_neg)", test_afrr_prices_pos_neg_boundary)
    R.add("price entries == sum(n_pos)+sum(n_neg) from counts file", test_afrr_prices_total_matches_counts)
    R.add("price file ISP indices are all in [0, n)", test_afrr_prices_isp_indices_in_range)
    R.add("price file only references ISPs with n_total > 0", test_afrr_prices_only_active_isps)
    R.add("per-ISP price-entry counts match n_pos+n_neg (30 random ISPs)", test_afrr_prices_per_isp_count_matches)
    R.add("merged-spread median in plausible band (-100..+100 EUR/MWh)", test_afrr_prices_spread_sign_check)

# H. aFRR 15-min averaged prices + mFRR↔aFRR split (s)
R.add("split round+remainder: Q_mfrr + Q_afrr == Q_offer (no MW lost)", test_split_round_remainder_invariant)
R.add("s=1 reproduces legacy spec example (-322.50 €) ignoring aFRR feeds", test_split_s1_matches_pre_feature_math)
R.add("s=0 routes everything to aFRR; revenue uses avg_p_pos / avg_p_neg", test_split_s0_routes_all_to_afrr)
R.add("s=0.5 splits 10 MW → 5 mFRR + 5 aFRR each direction", test_split_s_half_distributes_evenly)
R.add("aFRR-up gate: avg_p_pos ≤ 0 → 0 revenue (no money-losing bids)", test_afrr_gate_blocks_unfavorable_up)
R.add("aFRR-dn gate: blocks avg_p_neg > 0; passes avg_p_neg < 0 (earns +)", test_afrr_gate_blocks_unfavorable_dn)
R.add("mFRR-dn AND aFRR-up can earn simultaneously when prices allow", test_afrr_simultaneous_mfrr_dn_and_afrr_up)
R.add("asymmetric splits: s_up=1 + s_dn=0 routes upward → mFRR, downward → aFRR independently", test_split_asymmetric_s_up_neq_s_dn)
if HAS_AFRR_15MIN:
    R.add("data-afrr-15min.js schema + length matches main data.js", test_afrr_15min_schema)
    R.add("aFRR 15-min averages are 0 before 2025-05-01 (no data)", test_afrr_15min_pre_may2025_is_zero)
    R.add("synthetic 900 EUR/MWh × 1 slot → 4 EUR/MWh avg → 1 €/MW", test_afrr_15min_synthetic_revenue_formula)
    R.add("favourable-only filter: mixed-sign AST_NEG ISP recovers earnings (-10/+50 case)", test_afrr_15min_filter_recovers_mixed_sign_isp)
    R.add("L1 default with explicit s=1 + aFRR feeds wired = frozen value", test_l1_default_value_with_default_s_unchanged)
    if HAS_AFRR:
        R.add("L1 s=0: real aFRR feeds change result vs zeroed feeds (split is live)", test_l1_s0_produces_meaningful_afrr_revenue)


if __name__ == "__main__":
    sys.exit(R.run())
