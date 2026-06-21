"""
patch_reserves.py — fill the Oct–Dec 2025 reserve-price gap in
main_data_with_imbalance.csv using the official procured-reserves export.

Faithful surgical fill:
  * main CSV is read with every cell as a STRING (keep_default_na=False),
    so non-reserve columns are written back byte-for-byte unchanged.
  * Only EMPTY reserve cells are filled (never overwrite existing values).
  * Source file (ragged rows) is relabeled per product:
      FCR  rows: field4 = Symetric
      aFRR/mFRR: field4 = Upward, field5 = Downward
    (confirmed by the raw bytes + the TSO UI screenshot + the Sep overlap).
"""
import sys
import pandas as pd
import numpy as np

NEW = r"D:\Downloads\price-procured-reserves.2025-08-01-0000.2026-01-03-0000.utc.at2026-06-21-081844.csv"
MAIN = "main_data_with_imbalance.csv"
BAK = "main_data_with_imbalance.csv.bak"

# ---- parse the new export (ragged, left-packed; relabel by product) ----
nf = pd.read_csv(NEW, sep=";", dtype=str)
nf.columns = [c.strip() for c in nf.columns]
nf["dt"] = pd.to_datetime(nf["datetime_from"].str.strip('"'))
def num(s):
    return pd.to_numeric(s.str.replace(",", ".", regex=False).str.strip().replace("", np.nan), errors="coerce")
f4, f5 = num(nf["Symetric"]), num(nf["Upward"])  # after header shift: field4, field5
isF = nf["group1"].str.contains("FCR")
nf["UP"] = np.where(isF, np.nan, f4)
nf["DN"] = np.where(isF, np.nan, f5)
nf["SYM"] = np.where(isF, f4, np.nan)
nf["cc"] = nf["area"].map({"Estonia": "ee", "Latvia": "lv", "Lithuania": "lt"})

def series(grp, col, cc):
    s = nf[(nf.cc == cc) & (nf.group1 == grp)].set_index("dt")[col]
    return s[~s.index.duplicated(keep="first")]

# target main-CSV column  ->  (group, new-col, cc)
TARGETS = {}
for cc in ("ee", "lv", "lt"):
    TARGETS[f"reserves_mfrr_upward_{cc}"]   = ("mFRR reserves", "UP", cc)
    TARGETS[f"reserves_mfrr_downward_{cc}"] = ("mFRR reserves", "DN", cc)
    TARGETS[f"reserves_afrr_upward_{cc}"]   = ("aFRR reserves", "UP", cc)
    TARGETS[f"reserves_afrr_downward_{cc}"] = ("aFRR reserves", "DN", cc)
    TARGETS[f"reserves_fcr_symmetric_{cc}"] = ("FCR reserves", "SYM", cc)

def fmt(v):
    if pd.isna(v):
        return ""
    s = f"{round(float(v), 3):.3f}".rstrip("0").rstrip(".")
    return s if s not in ("", "-0") else "0"

# ---- load main CSV as raw strings (faithful) ----
df = pd.read_csv(MAIN, dtype=str, keep_default_na=False, na_filter=False)
bak = pd.read_csv(BAK, dtype=str, keep_default_na=False, na_filter=False)
main_dt = pd.to_datetime(df["datetime_utc"])
print(f"main rows={len(df)}  cols={df.shape[1]}")

filled_total = 0
for col, (grp, ncol, cc) in TARGETS.items():
    if col not in df.columns:
        print(f"  !! {col} not in main CSV — skipped")
        continue
    new_s = series(grp, ncol, cc).reindex(main_dt)          # value per main row (NaN where absent)
    new_str = pd.Series([fmt(v) for v in new_s.to_numpy()], index=df.index)
    empty = df[col].str.strip() == ""
    mask = empty & (new_str != "")
    df.loc[mask.to_numpy(), col] = new_str[mask.to_numpy()].to_numpy()
    filled_total += int(mask.sum())
    print(f"  {col:30s} filled {int(mask.sum()):5d}  (was empty {int(empty.sum())})")

# ---- safety verification ----
reserve_cols = set(TARGETS)
changed_nonreserve = [c for c in df.columns if c not in reserve_cols and not df[c].equals(bak[c])]
assert not changed_nonreserve, f"NON-RESERVE COLUMNS CHANGED: {changed_nonreserve}"
# no existing (non-empty) reserve value overwritten:
for col in reserve_cols:
    if col in df.columns:
        was = bak[col].str.strip() != ""
        assert (df.loc[was.to_numpy(), col].to_numpy() == bak.loc[was.to_numpy(), col].to_numpy()).all(), f"overwrote existing in {col}"
print(f"\nVERIFY: non-reserve columns byte-identical [OK] ; no existing reserve value overwritten [OK]")
print(f"total cells filled: {filled_total}")

# sample at the ISP in question
i = main_dt[main_dt == pd.Timestamp("2025-10-12 07:00:00")].index
if len(i):
    r = df.loc[i[0]]
    print(f"\n2025-10-12 07:00 after fill:  mfrr_dn_lv={r['reserves_mfrr_downward_lv']}  afrr_dn_lv={r['reserves_afrr_downward_lv']}  mfrr_up_lv={r['reserves_mfrr_upward_lv']}")

if "--write" in sys.argv:
    df.to_csv(MAIN, index=False)
    print(f"\nWROTE {MAIN}")
else:
    print("\n(dry run — pass --write to save)")
