"""
preprocess.py — build data.js from main_data_with_imbalance.csv.

WHAT THIS DOES
==============
1. Reads only the CSV columns the Backtester + Graphs engines need.
2. Drops rows with NaN in critical columns (forecasts, prices, q_pot,
   Baltic aggregates). Does NOT require final_imbalance_price_latvia
   (that source ends in March 2026; April rows are kept and p_imb is
   exported as JSON null where missing).
3. Computes Baltic aggregates (LV + EE + LT) for wind day-ahead, solar
   day-ahead, and imbalance volume.
4. Emits data.js with a global WIND_DATA object.
5. Re-runs the spec's two Level-2 worked examples (−322.5 € / +375.0 €)
   as a sanity check on every regenerate.

DATA REFRESH WORKFLOW
=====================
After replacing main_data_with_imbalance.csv:

    python preprocess.py

The Backtester and Graphs pages auto-adapt to:
  * new date range / ISP count
  * new April imbalance prices (if present, p_imb just stops being null)
  * new bin boundaries (recomputed from data on every chart render)

Manual updates needed for:
  * tests.py frozen regression values (L1 = 13,257,221 €, L2 = 13,367,642 €)
  * cache-busting ?v=N on <script> tags in index.html / graphs.html

If the source CSV's column names change, NEEDED below must be updated
or the script fails with KeyError (intentional — better than silently
producing garbage).

OUTPUT FORMAT
=============
data.js contains a single global:

    const WIND_DATA = {
      start_iso, n, step_min, offsets,
      da_forecast, id_forecast,             // Vanessa-specific
      p_da, p_mfrr,                         // Single clearing prices
      q_pot,                                // Vanessa potential gen, MW
      p_imb,                                // [..., null, null, ...] where missing
      baltic_wind_da, baltic_solar_da,      // LV+EE+LT sums (MW)
      baltic_imb_vol,                       // LV+EE+LT sum, signed (MW)
    };

null entries in p_imb are turned into NaN by engine.js's _toFloat32WithNaN()
helper; simulate / simulateTotal / monthlyAggregation each guard NaN p_imb
and treat its imbalance + flat-penalty contributions as 0.
"""

import json
import os
import sys
from datetime import datetime

import numpy as np
import pandas as pd

CSV_PATH = "main_data_with_imbalance.csv"
OUT_PATH = "data.js"

NEEDED = [
    "datetime_utc",
    "scipher_da_p50_mw",
    "scipher_id_p50_mw",
    "lt_dayahead_price_eur_mwh",
    "mfrr_sa_upward_lv",
    "mfrr_sa_downward_lv",
    "wind_park_possible",
    "final_imbalance_price_latvia",
    # Intraday VWAP at 1h before delivery (LV bidding zone). Used by Level 3
    # speculation strategy as the intraday-sale-price estimate (`P_ID_est`)
    # and as the basis for the defensive mFRR-dn bid price (P_ID + M).
    "averagePriceLast1H",
    # Baltic-level columns (used by the Graphs page)
    "lv_wind_onshore_dayahead_mw",
    "ee_wind_onshore_dayahead_mw",
    "lt_wind_onshore_dayahead_mw",
    "lv_solar_dayahead_mw",
    "ee_solar_dayahead_mw",
    "lt_solar_dayahead_mw",
    "imbalance_volume_lv",
    "imbalance_volume_ee",
    "imbalance_volume_lt",
]


def main():
    print("Reading CSV...", flush=True)
    df = pd.read_csv(CSV_PATH, usecols=NEEDED)
    print(f"  rows: {len(df)}")

    # Verify mFRR up/down are usually identical (single clearing price assumption)
    same = (df["mfrr_sa_upward_lv"] == df["mfrr_sa_downward_lv"]).sum()
    pct = same / len(df) * 100
    print(f"  mFRR up==down in {pct:.2f}% of rows ({same}/{len(df)})")
    diff_mask = (df["mfrr_sa_upward_lv"] != df["mfrr_sa_downward_lv"]) & (
        df["mfrr_sa_upward_lv"].notna() & df["mfrr_sa_downward_lv"].notna()
    )
    n_diff = diff_mask.sum()
    print(f"  rows where they differ (both non-NaN): {n_diff}")
    # Use upward as the single clearing price (assumed equal in spec)
    df["p_mfrr"] = df["mfrr_sa_upward_lv"]

    # Convert kW -> MW for actual production
    df["q_pot"] = df["wind_park_possible"] / 1000.0

    # Baltic-level aggregates (sum of EE + LV + LT)
    df["baltic_wind_da"] = (
        df["lv_wind_onshore_dayahead_mw"]
        + df["ee_wind_onshore_dayahead_mw"]
        + df["lt_wind_onshore_dayahead_mw"]
    )
    df["baltic_solar_da"] = (
        df["lv_solar_dayahead_mw"]
        + df["ee_solar_dayahead_mw"]
        + df["lt_solar_dayahead_mw"]
    )
    df["baltic_imb_vol"] = (
        df["imbalance_volume_lv"]
        + df["imbalance_volume_ee"]
        + df["imbalance_volume_lt"]
    )
    # LV-only imbalance volume — kept separately so the Graphs page can
    # split aFRR activations by either Latvia-only or full Baltic regime.
    df["lv_imb_vol"] = df["imbalance_volume_lv"]

    # Intraday VWAP: rename column so the JS side reads `vwap_1h`.
    df["vwap_1h"] = df["averagePriceLast1H"]

    # Drop rows with NaN in any column required by EITHER consumer (Backtester
    # or Graphs). p_imb is intentionally NOT in this list — its source file
    # ends in March 2026, so requiring it would cut April off. The Backtester
    # engine treats NaN p_imb as 0 cost (April rows still contribute DA + mFRR
    # revenue but no imbalance penalty).
    # vwap_1h is intentionally OPTIONAL (not in dropna list) — only the L3
    # speculation strategy uses it, and the engine should treat NaN as
    # "skip S3 for this ISP" rather than dropping the whole row. This keeps
    # L1/L2 frozen regressions intact when the source file has gaps.
    needed_cols = [
        "scipher_da_p50_mw",
        "scipher_id_p50_mw",
        "lt_dayahead_price_eur_mwh",
        "p_mfrr",
        "q_pot",
        "baltic_wind_da",
        "baltic_solar_da",
        "baltic_imb_vol",
        "lv_imb_vol",
    ]
    before = len(df)
    df = df.dropna(subset=needed_cols).reset_index(drop=True)
    after = len(df)
    print(
        f"  dropped {before - after} NaN rows ({(before - after) / before * 100:.2f}%); "
        f"remaining: {after}"
    )
    n_pimb_missing = df["final_imbalance_price_latvia"].isna().sum()
    print(
        f"  p_imb (Latvia imbalance price) missing in {n_pimb_missing} rows "
        f"({n_pimb_missing / after * 100:.2f}%) — encoded as null in JSON"
    )

    # Parse timestamps to derive offset from a fixed start
    df["ts"] = pd.to_datetime(df["datetime_utc"], utc=False)
    start = df["ts"].iloc[0]
    df["idx"] = ((df["ts"] - start).dt.total_seconds() / 60 / 15).astype(int)
    print(f"  start: {start}, end: {df['ts'].iloc[-1]}")
    print(f"  max offset (15-min units): {int(df['idx'].iloc[-1])}")

    # Round to keep file size sane
    da = df["scipher_da_p50_mw"].round(3).tolist()
    iduvw = df["scipher_id_p50_mw"].round(3).tolist()
    pda = df["lt_dayahead_price_eur_mwh"].round(2).tolist()
    pmfrr = df["p_mfrr"].round(2).tolist()
    qpot = df["q_pot"].round(3).tolist()
    # Encode NaN p_imb as null (JSON doesn't allow NaN literal). JS receives
    # null → engine converts to NaN in its Float32Array.
    pimb = [
        None if pd.isna(v) else round(float(v), 2)
        for v in df["final_imbalance_price_latvia"]
    ]
    bw = df["baltic_wind_da"].round(2).tolist()
    bs = df["baltic_solar_da"].round(2).tolist()
    bi = df["baltic_imb_vol"].round(3).tolist()
    li = df["lv_imb_vol"].round(3).tolist()
    # vwap_1h: encode NaN as JSON null (engine.js converts to NaN). L3's S3
    # logic skips ISPs where vwap_1h is NaN.
    vw = [None if pd.isna(v) else round(float(v), 2) for v in df["vwap_1h"]]
    offsets = df["idx"].tolist()

    out = {
        "start_iso": start.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "n": len(df),
        "step_min": 15,
        "offsets": offsets,
        "da_forecast": da,
        "id_forecast": iduvw,
        "p_da": pda,
        "p_mfrr": pmfrr,
        "q_pot": qpot,
        "p_imb": pimb,
        "baltic_wind_da": bw,
        "baltic_solar_da": bs,
        "baltic_imb_vol": bi,
        "lv_imb_vol": li,
        "vwap_1h": vw,
    }

    js = "// Auto-generated by preprocess.py — do not edit by hand.\n"
    js += "const WIND_DATA = " + json.dumps(out, separators=(",", ":")) + ";\n"
    js += "if (typeof module !== 'undefined') module.exports = WIND_DATA;\n"

    with open(OUT_PATH, "w", encoding="utf-8") as f:
        f.write(js)

    sz = os.path.getsize(OUT_PATH) / (1024 * 1024)
    print(f"  wrote {OUT_PATH}: {sz:.2f} MB")

    # Print summary statistics for each column (for reference / debugging)
    print()
    print("Summary stats (for sanity):")
    for name, arr in [
        ("da_forecast (MW)", da),
        ("id_forecast (MW)", iduvw),
        ("p_da (EUR/MWh)", pda),
        ("p_mfrr (EUR/MWh)", pmfrr),
        ("q_pot (MW)", qpot),
        ("p_imb (EUR/MWh)", [v for v in pimb if v is not None]),
        ("baltic_wind_da (MW)", bw),
        ("baltic_solar_da (MW)", bs),
        ("baltic_imb_vol (MW)", bi),
        ("lv_imb_vol (MW)", li),
        ("vwap_1h (EUR/MWh)", [v for v in vw if v is not None]),
    ]:
        a = np.asarray(arr, dtype=float)
        if len(a) == 0:
            continue
        print(
            f"  {name:25s} min={a.min():10.2f} p10={np.percentile(a, 10):10.2f} "
            f"p50={np.percentile(a, 50):10.2f} p90={np.percentile(a, 90):10.2f} "
            f"max={a.max():10.2f}"
        )

    # ===========================================================================
    # SIGN CONVENTION CHECK — replay the two given Level 2 examples
    # ===========================================================================
    print()
    print("Sign-convention manual checks (Level 2 examples from spec):")

    def isp_revenue_l2(F, ID, P_da, P_mfrr, Q_pot, P_imb, X, Y, Z, theta=30.0):
        # Mirrors engine.js after the audit fixes (whole-MW + dn cap + Q_pos).
        import math
        above_X = P_da >= X
        Q_da_sold = math.floor((F if above_X else F * (1 - Y)) + 1e-9)
        Q_with = math.floor((0.0 if above_X else F - Q_da_sold) + 1e-9)
        revision = ID - F
        trusted_raw = Z * revision
        trusted_extra = math.floor(trusted_raw + 1e-9) if trusted_raw > 0 else 0
        Q_up_offer = Q_with + trusted_extra
        Q_dn_offer = Q_da_sold  # curtailment capped at DA
        is_up = P_mfrr >= 1.0
        is_dn = P_mfrr <= -1.0
        Q_up = Q_up_offer if is_up else 0.0
        Q_dn = Q_dn_offer if is_dn else 0.0
        DA_rev = Q_da_sold * P_da
        mFRR_up_rev = Q_up * P_mfrr
        mFRR_dn_rev = -Q_dn * P_mfrr
        Q_pos = Q_da_sold + Q_up - Q_dn  # mFRR-dn reduces position
        Q_short = max(0.0, Q_pos - Q_pot)
        imb_cost = Q_short * P_imb
        flat_cost = Q_short * theta
        total = (DA_rev + mFRR_up_rev + mFRR_dn_rev - imb_cost - flat_cost) * 0.25
        return total, dict(
            Q_da_sold=Q_da_sold,
            Q_with=Q_with,
            trusted=trusted_raw,
            Q_up=Q_up,
            Q_dn=Q_dn,
            DA_rev=DA_rev,
            mFRR_up_rev=mFRR_up_rev,
            mFRR_dn_rev=mFRR_dn_rev,
            Q_short=Q_short,
            imb_cost=imb_cost,
            flat_cost=flat_cost,
        )

    # Example 1: should yield -322.5
    rev1, parts1 = isp_revenue_l2(
        F=20, ID=18, P_da=5, P_mfrr=50, Q_pot=12, P_imb=200, X=10, Y=0.5, Z=0.5
    )
    print(f"  Example 1 expected -322.5 EUR  got {rev1:+.2f} EUR  ", end="")
    print("OK" if abs(rev1 + 322.5) < 1e-6 else "FAIL")
    print(f"    parts: {parts1}")

    # Example 2: should yield 375
    rev2, parts2 = isp_revenue_l2(
        F=20, ID=20, P_da=100, P_mfrr=0, Q_pot=10, P_imb=20, X=10, Y=0.5, Z=0.0
    )
    print(f"  Example 2 expected 375.0 EUR  got {rev2:+.2f} EUR   ", end="")
    print("OK" if abs(rev2 - 375.0) < 1e-6 else "FAIL")
    print(f"    parts: {parts2}")


if __name__ == "__main__":
    main()
