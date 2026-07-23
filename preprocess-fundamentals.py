"""
preprocess-fundamentals.py — build data-fund.js from main_data_with_imbalance.csv.

WHY A SEPARATE FILE
===================
The "Drivers & timing" Graphs sub-tab needs the market FUNDAMENTALS the
original export left behind: renewables/load ACTUALS (so forecast ERRORS can
be computed — balancing prices are driven by surprises, not levels), the
knowable DA→intraday wind-forecast revision, the EE/LT mFRR clearing prices
(cross-zone divergence) and the LV accepted SA-mFRR UP bid band
(merit-order scarcity). Rather than regenerate data.js (which would risk
drifting the frozen regression arrays), we ship these as a separate optional
file — exactly the pattern used by data-reserve.js.

Four shipped columns are currently UNREAD by any chart (solar_act, vwap_3h,
mfrr_maxbid_dn, mfrr_minbid_dn — ~1 MB of the payload); they are kept
deliberately so future charts can use them without a data regeneration.

ALIGNMENT
=========
Aligned to data.js's ISP indices BY TIMESTAMP (identical to
preprocess-reserve.py): ts(i) = start_iso + offsets[i] * step_min minutes,
then look up the CSV row at that exact timestamp. Rows data.js dropped as
NaN simply don't get asked for; CSV rows with no match (or null values)
become JSON null → NaN in the browser → "no data that ISP".

DERIVED IN THE BROWSER (not here, to keep this file raw):
  wind error  = wind_act  − WIND_DATA.baltic_wind_da
  solar error = solar_act − WIND_DATA.baltic_solar_da
  load error  = load_act  − load_fc
  wind DA→ID revision (knowable pre-gate) = wind_id_lvlt − wind_da_lvlt
    (LV+LT only: Estonia publishes no intraday wind forecast, so the
     revision is defined on the LV+LT footprint and labelled as such.)

CONVENTIONS
===========
p_mfrr_ee / p_mfrr_lt use the UPWARD SA price as the single clearing price —
the same convention preprocess.py uses for Latvia (up == down in ~all rows;
the script prints the check for EE/LT).

Run:  python preprocess-fundamentals.py
Then bump ?v=N on data-fund.js in graphs.html.
"""

import json
import os

import numpy as np
import pandas as pd

CSV_PATH = "main_data_with_imbalance.csv"
DATA_JS_PATH = "data.js"
OUT_PATH = "data-fund.js"

# output key -> CSV column(s); tuples are summed (NaN-propagating: a partial
# Baltic sum would be misleading, so any missing member nulls the whole sum)
FUND_COLS = {
    "wind_act": ("ee_wind_onshore_actual_mw", "lv_wind_onshore_actual_mw", "lt_wind_onshore_actual_mw"),
    "solar_act": ("ee_solar_actual_mw", "lv_solar_actual_mw", "lt_solar_actual_mw"),
    "load_act": ("ee_actual_load_mw", "lv_actual_load_mw", "lt_actual_load_mw"),
    "load_fc": ("ee_dayahead_load_forecast_mw", "lv_dayahead_load_forecast_mw", "lt_dayahead_load_forecast_mw"),
    "wind_da_lvlt": ("lv_wind_onshore_dayahead_mw", "lt_wind_onshore_dayahead_mw"),
    "wind_id_lvlt": ("lv_wind_onshore_intraday_mw", "lt_wind_onshore_intraday_mw"),
    "vwap_3h": ("averagePriceLast3H",),
    "p_mfrr_ee": ("mfrr_sa_upward_ee",),
    "p_mfrr_lt": ("mfrr_sa_upward_lt",),
    "mfrr_maxbid_up": ("sa_mfrr_maxbid_upward_lv",),
    "mfrr_minbid_up": ("sa_mfrr_minbid_upward_lv",),
    "mfrr_maxbid_dn": ("sa_mfrr_maxbid_downward_lv",),
    "mfrr_minbid_dn": ("sa_mfrr_minbid_downward_lv",),
}


def load_data_js_meta():
    with open(DATA_JS_PATH, "r", encoding="utf-8") as f:
        text = f.read()
    return json.loads(text[text.index("{") : text.rindex("}") + 1])


def main():
    print("Reading data.js meta…", flush=True)
    meta = load_data_js_meta()
    n = meta["n"]
    step = meta["step_min"]
    offsets = meta["offsets"]
    start = pd.to_datetime(meta["start_iso"]).tz_localize(None)
    print(f"  data.js: n={n}, start={start}, step={step} min")

    csv_cols = sorted({c for cols in FUND_COLS.values() for c in cols})
    extra_check = ["mfrr_sa_downward_ee", "mfrr_sa_downward_lt"]
    print("Reading CSV fundamental columns…", flush=True)
    df = pd.read_csv(CSV_PATH, usecols=["datetime_utc", *csv_cols, *extra_check])
    df["datetime_utc"] = pd.to_datetime(df["datetime_utc"])
    df = df.set_index("datetime_utc")
    df = df[~df.index.duplicated(keep="first")]

    # single-clearing-price sanity (same check preprocess.py prints for LV)
    for cc in ("ee", "lt"):
        up, dn = df[f"mfrr_sa_upward_{cc}"], df[f"mfrr_sa_downward_{cc}"]
        both = up.notna() & dn.notna()
        same = (up[both] == dn[both]).mean() * 100 if both.any() else float("nan")
        print(f"  mFRR {cc.upper()} up==down in {same:.2f}% of non-NaN rows")

    target_ts = pd.DatetimeIndex(
        [start + pd.Timedelta(minutes=int(off) * step) for off in offsets]
    )

    def to_json_list(series):
        return [None if pd.isna(v) else round(float(v), 2) for v in series.to_numpy()]

    out = {"n": n}
    for key, cols in FUND_COLS.items():
        s = df[cols[0]].copy()
        for c in cols[1:]:
            s = s + df[c]  # NaN-propagating sum
        out[key] = to_json_list(s.reindex(target_ts))
        assert len(out[key]) == n, f"length mismatch for {key} vs data.js n"

    js = "// Auto-generated by preprocess-fundamentals.py — do not edit by hand.\n"
    js += "const FUND_DATA = " + json.dumps(out, separators=(",", ":")) + ";\n"
    js += "if (typeof module !== 'undefined') module.exports = FUND_DATA;\n"
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        f.write(js)

    sz = os.path.getsize(OUT_PATH) / (1024 * 1024)
    print(f"  wrote {OUT_PATH}: {sz:.2f} MB")
    for key in FUND_COLS:
        arr = [v for v in out[key] if v is not None]
        nn = len(arr)
        a = np.asarray(arr, dtype=float) if nn else np.array([0.0])
        print(
            f"  {key:<15} non-null {nn}/{n} ({100*nn/n:5.1f}%)  "
            f"min={a.min():10.2f} p50={np.percentile(a,50):10.2f} max={a.max():10.2f}"
        )

    # sanity: error series vs the forecasts already shipped in data.js
    bw = np.asarray([np.nan if v is None else v for v in meta["baltic_wind_da"]], dtype=float)
    wa = np.asarray([np.nan if v is None else v for v in out["wind_act"]], dtype=float)
    err = wa - bw
    ok = np.isfinite(err)
    print(
        f"  wind error (act - DA fc): n={ok.sum()}  mean={np.nanmean(err):.1f} MW  "
        f"std={np.nanstd(err):.1f} MW  p05={np.nanpercentile(err,5):.0f}  p95={np.nanpercentile(err,95):.0f}"
    )


if __name__ == "__main__":
    main()
