# Vanessa Wind Park — Market Strategy Backtester

A static, single-page web tool that backtests day-ahead vs mFRR
allocation strategies for the Vanessa / Targale wind park (14 × 4.2 MW
= 58.8 MW, Latvia).

All math runs **client-side** in the browser; the dataset is embedded in
`data.js`. No server, no build step, no install.

## What the tool does

Two analysis tabs:

- **Level 1 — Perfect foresight**. Assumes DA forecast equals actual
  production. Isolates the DA-vs-mFRR allocation question. Two
  parameters: `X` (DA price threshold) and `Y` (fraction to withhold
  from DA when `P_DA < X`).
- **Level 2 — Real forecast errors**. Uses actual potential power
  (`Q_pot`) and SciPHER intraday forecast. Adds `Z` (ID-revision trust
  coefficient) and `θ_flat` (flat shortfall penalty per MWh). Models
  imbalance cost via the Latvia final imbalance price.

For each level you get:

- Live revenue summary with decomposition (DA, mFRR-up, mFRR-dn,
  imbalance cost, flat penalty), counts, per-MWh figures.
- A time-series chart (DA-sold line, mFRR up/down volumes, Q_pot
  dashed line for L2) with **From / To date pickers**, prev/next
  range navigation (shifts by the current span), and quick-preset
  buttons (`1d`, `1w`, `1mo`, `3mo`, `all`). Bar mode with rich
  per-ISP hover for windows ≤ 6 days; filled-area scattergl mode for
  longer windows so the full 14-month dataset can be plotted at once
  in ~1.5 s. Mouse-wheel zoom and click-drag pan in both modes.
- A robustness panel (top-1/5/10 % revenue concentration, monthly
  decomposition bars, per-ISP revenue histogram).
- An optimisation surface (heatmap). Click a cell to set parameters.
- An **Optimise** button that runs the full sweep and snaps sliders
  to the revenue-maximising values.
- A **Reset to naïve** button (sell everything to DA always).
- Adjustable winsorization percentiles for mFRR and imbalance prices
  (defaults 10 / 90).

## File layout

```
wind-park-tool/
├── index.html         page structure
├── style.css          dark theme
├── data.js            pre-processed dataset (1.7 MB, generated)
├── engine.js          simulation engine (winsorize, simulate, sweep)
├── charts.js          Plotly chart builders
├── app.js             UI wiring, tabs, sliders, debounced recompute
├── preprocess.py      regenerate data.js from the source CSV
└── README.md          this file
```

## Running locally

The site is fully static. From this folder:

```
python -m http.server 8000
```

then open <http://localhost:8000>. Or just **double-click `index.html`**
— it works under the `file://` protocol too.

## Deploying to GitHub Pages

1. Create a new GitHub repository (e.g. `vanessa-wind-tool`).
2. Copy **all files in this folder** into the repo root and commit:
   ```
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin git@github.com:<username>/<repo-name>.git
   git push -u origin main
   ```
3. On GitHub: **Settings → Pages → Source:** "Deploy from a branch",
   **Branch:** `main`, **Folder:** `/ (root)`. Save.
4. Wait 1–2 minutes. The site will be live at
   `https://<username>.github.io/<repo-name>/`.

## Regenerating the data

`data.js` is generated from the source CSV by `preprocess.py`. The
script expects `main_data_with_imbalance.csv` to live one directory
above this folder. To regenerate (after updating the CSV):

```
cd wind-park-tool
python preprocess.py
```

It also runs the spec's two worked Level 2 examples through the
identical Python formulas as a sign-convention sanity check.

## Sign conventions

All revenue is in EUR per ISP (15-min period); positive = money to the
park.

```
DA revenue       =   Q_da_sold      * P_da           [always ≥ 0]
mFRR-up rev      =   Q_up           * P_mfrr         [+ when P_mfrr > 0]
mFRR-dn rev      = − Q_dn           * P_mfrr         [+ when P_mfrr < 0]
Imbalance cost   = − Q_short        * P_imb          [cost when short]
Flat penalty     = − Q_short        * θ_flat
ISP revenue      = (DA + up + dn − imb − flat) * 0.25
Q_position       =   Q_da_sold + Q_up − Q_dn
Q_short          =   max(0, Q_position − Q_pot)
```

mFRR activation triggers when `|P_mfrr| ≥ 1`:

- `P_mfrr ≥ 1`: mFRR-up activates the offered up-volume.
- `P_mfrr ≤ −1`: mFRR-dn activates the offered down-volume.
- otherwise: nothing activates; if Y > 0 below X, the withheld energy
  earns nothing this ISP (counted as "withheld w/o activation").

In **Level 2**, the ID gate also offers `Z · max(0, ID − DA)` as
**additional** mFRR-up, regardless of whether we are above or below X.
Negative ID revisions are not acted on (no buyback modelled), but the
shortfall risk still shows up in the imbalance line.

### Physical constraints applied (audit corrections)

- **Whole-MW market quantities.** The balancing market only operates
  in integer MW blocks, so `Q_da_sold`, `Q_w` (withheld), `trusted_rev`
  (ID-revised extra) and `Q_dn_offer` are all `floor()`-rounded.
  Fractional MW between `floor(F)` and the actual forecast are simply
  not traded.
- **mFRR-dn capped at the DA position.** mFRR-dn means *curtailing an
  existing commitment*. A wind park can drop from `Q_da_sold` to 0;
  it cannot go below 0. Therefore `Q_dn_offer = Q_da_sold` (independent
  of `Y`). When `Q_da_sold = 0`, no mFRR-dn revenue is possible.
- **Position decreases when mFRR-dn fires.** When mFRR-dn activates,
  the promised production becomes `Q_da_sold − Q_dn`, which is why
  `Q_position` includes the `− Q_dn` term. mFRR-up and mFRR-dn cannot
  both fire in the same ISP (`P_mfrr` is single-signed).

## Known data details

- Source: `main_data_with_imbalance.csv`, 43,392 rows, 15-min UTC.
- After dropping rows with NaN in any required column (mostly missing
  imbalance prices), **40,223 ISPs remain**, covering
  2025-02-05 → 2026-03-31. The truncation comes from the imbalance
  price series — ~7 % of rows have no value.
- mFRR upward and downward LV prices match in 99.85 % of rows (the
  spec's "single clearing price" assumption holds), so `engine.js`
  uses `mfrr_sa_upward_lv` as the canonical column.
- `wind_park_possible` is in **kW**, divided by 1000 in preprocess.

## Performance notes

- All numeric arrays are converted to `Float32Array` at load time to
  keep the inner loop fast.
- Winsorized arrays are cached and only recomputed when the percentile
  inputs change.
- The Level 1 sweep runs ~100 ms in the browser (861 (X, Y)
  evaluations × 40 k ISPs).
- The Level 2 sweep (4,961 (X, Y, Z) evaluations × 40 k ISPs at the
  default Optimise grid) runs in ~10 s and is chunked across animation
  frames so the UI stays responsive.
- Plotly is loaded from `cdn.plot.ly` (versioned URL). Plotly's own
  CDN does not publish SRI hashes, so the script tag has none.

## License

This is a self-contained backtester built for analysis. No license
file is included; treat it as use-at-your-own-risk demo code.
