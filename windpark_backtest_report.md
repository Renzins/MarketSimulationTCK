# Wind Park Trading Strategy — Backtest Review

*Targale wind park (58.8 MW, Latvia). Backtest period: Feb 2025 – Apr 2026 (15 months).
Markets: day-ahead, mFRR, aFRR, intraday. Reserve/capacity markets excluded this round.
All figures are backtested, not realised — read the caveats.*

## Bottom line

- Trading the balancing markets on top of plain day-ahead selling is worth a
  **meaningful uplift**: about **+€5.3M (+50%)** over the 15 months from the three
  dependable ("operational") strategies, and a further **~€1.9M** from a
  speculative strategy we treat as a capped, best-case ceiling — **not** a forecast.
- **One fixed configuration works year-round** — there is no payoff to re-tuning
  the settings by season or for weekdays vs weekends.
- The **headline percentage swings wildly by period (≈ +20% to +270%)**, driven
  mostly by how cheap day-ahead power was that month. We could **not** cleanly show
  a "2025-volatile → 2026-mature" trend (it is confounded with seasonality and a
  data gap). Plan on the recent, calmer range of **~+25–40%**, not the 2025 peaks.

## What each strategy contributes

Strategies were switched on one at a time, each optimised, over the full 15 months
(all days). Each adds value *given the ones before it*, so the order reflects how
they build on each other.

| Added strategy | Total revenue | This strategy adds | What it does (plain terms) |
| --- | --- | --- | --- |
| *(do-nothing: sell all to day-ahead)* | €10.69M | — | Baseline |
| **Day-ahead withholding** | €11.95M | **+€1.3M** | When day-ahead clears cheap, hold the power back and sell it into balancing instead. |
| **mFRR ↔ aFRR split** | €13.46M | **+€1.5M** | Route balancing volume to the better-paying of the two balancing products. |
| **Intra-day-forecast trust** | €15.98M | **+€2.5M** | When the intra-day forecast says we'll generate more than day-ahead assumed, offer that extra into balancing. |
| **Speculative intra-day oversell** | €17.88M | **+€1.9M** | Opportunistically sell a small extra block on intra-day when it looks cheap vs balancing, with a stop-loss hedge. |

**Operational subtotal (first three): +€5.3M / +50%.** These three are the
dependable core. **With the speculative fourth: +€7.2M / +67%** — but see its
concern below before banking the extra €1.9M.

### Strategy-by-strategy: gain and concern

- **Day-ahead withholding** — *+€1.3M.* Simple and robust. The optimiser always
  wants to withhold *fully* below the price threshold, and the threshold itself
  isn't sensitive (a wide range of values gives the same result). *Concern:* assumes
  the withheld energy clears in balancing at the observed price without our own
  volume softening it.

- **mFRR ↔ aFRR split** — *+€1.5M.* The model consistently prefers to route
  **upward** energy toward **aFRR** and keep **downward** (curtailment) in **mFRR** —
  a genuine, repeatable asymmetry in how the two products pay. *Concern:* it's a
  data-driven preference that could shift if the two products' economics converge.

- **Intra-day-forecast trust** — *+€2.5M, the single largest contributor.* It turns
  a better late forecast into extra balancing offers. *Concern:* it leans on the
  intra-day forecast being right — if it over-predicts generation, we over-commit
  and pay imbalance. The model also always wants to trust it *fully*, which is
  optimistic; a more cautious setting would trade some of this gain for safety.

- **Speculative intra-day oversell (S3)** — *+€1.9M in the backtest, and the number
  we trust least.* It is **deliberately capped at 5 MW per period and that cap is
  not optimised** — because in the real, thin intra-day market, selling more than a
  small block would **move the price against us and erase the edge**. The evidence
  that this matters: when we let the optimiser tune S3 freely, it switched **off
  every other safety filter** and simply sold the **maximum allowed, every
  opportunity** — i.e. the only thing limiting it is the cap. So we treat this €1.9M
  as a **best-case ceiling that assumes liquidity we don't actually have**, not a
  bankable number. Its per-quarter contribution is small and similar in calm 2026
  conditions (≈ €0.3M in Feb–Apr 2026).

- **Reserve / capacity markets** — *excluded this round* by decision. (In separate
  checks they also behave as "sell as much as allowed," so they need the same kind
  of liquidity/contract framing before they can be relied on.)

## How robust are the settings (set-and-forget)

A single configuration, optimised once on the whole period, captures **96–100%** of
what perfectly re-optimising each individual season could earn, and **93–100%**
across workday/weekend splits. The per-season "best parameters" look different only
because many settings perform almost identically near the top — not because any
period genuinely needs its own. **Operationally: set it once, leave it; revisit only
if market structure changes, not on a seasonal calendar.**

## Value over time, and weekends

- **We are not claiming a "market maturing" trend.** The period uplift % mostly
  tracks the day-ahead price level (cheap summer power makes balancing look
  relatively far better), not a clean year-on-year story. The one same-season,
  year-apart comparison (Feb–Apr 2025 vs 2026) is unusable because the **aFRR price
  feed only began May 2025**. Honest read: recent quarters (Nov 2025 – Apr 2026)
  show **+26% to +37%**; the large mid-2025 figures are not something to bank on.
- **Weekends/holidays show a bigger percentage uplift than workdays** every season
  (e.g. +71% vs +27% in spring 2026), because weekend day-ahead prices are lower —
  but weekend volume is only ~a quarter of the total, and the same single setting
  already handles both, so no separate weekend rules are needed.

## Caveats (please read)

- **Scale / liquidity not modelled.** The backtest assumes our volume clears at
  observed prices without pushing them down. At full 58.8 MW scale this won't fully
  hold, so **every uplift here is an upper bound** — most so for the speculative
  oversell and the intra-day-trust extras, which lean hardest on cheap liquidity.
- **Reserve/capacity markets excluded** by design in this round.
- **No aFRR data before May 2025**, so the first window (Feb–Apr 2025) is
  day-ahead/mFRR only.
- **Forecast risk** sits inside the intra-day-trust gain: it assumes the late
  forecast is reliable.

## Appendix — the numbers

**Optimised (operational strategies) vs do-nothing, all days:**

| Period | Optimised | Day-ahead only | Uplift |
| --- | --- | --- | --- |
| Feb–Apr 2025 \* | €2.3M | €1.9M | +22% |
| May–Jul 2025 | €3.6M | €1.1M | +223% |
| Aug–Oct 2025 | €3.6M | €1.8M | +100% |
| Nov 2025–Jan 2026 | €4.4M | €3.4M | +26% |
| Feb–Apr 2026 | €3.3M | €2.4M | +37% |
| **Full 15 months** | **€16.0M** | **€10.7M** | **+50%** |

\* mFRR/day-ahead only — aFRR feed started May 2025.

**Single-setting robustness** (share of each period's own best it captures):
seasons (all days) **96–100%**; workday/weekend splits **93–100%**.

*Method: each window optimised with a fixed, reproducible search. "Do-nothing" =
sell all generation to day-ahead. Operational figures exclude the speculative
intra-day oversell and the reserve markets; the contribution table additionally
shows the speculative leg.*
