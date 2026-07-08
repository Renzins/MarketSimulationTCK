# Wind Park Trading Strategy — Backtest Review v2

*Targale wind park (58.8 MW, Latvia). Backtest period: Feb 2025 – Apr 2026 (15 months).
This round adds the reserve (capacity) markets, priced conservatively: capacity prices
capped at their 80th percentile (19–52 €/MW·h depending on product), because we do not
expect the 2025 spike levels to persist. All figures are backtested, not realised — read
the caveats.*

## Bottom line

- The three energy strategies are worth **+€5.8M (+54%)** over plain day-ahead selling
  for the 15 months (€16.5M vs €10.7M). That is +€0.5M more than the last report,
  from an upgrade to the mFRR↔aFRR routing logic — not from new market assumptions.
- **Reserve markets add nothing at conservative prices.** Over the full period the
  optimiser's best move is zero participation: every €1 of capacity income destroys
  more than €1 of energy-market revenue it displaces. The reserve value seen in 2025
  was a price regime that has since normalised.
- **"Set once and leave it" still holds for the energy strategies** — one fixed
  configuration captures 94–100% of every season's own optimum. The one genuinely
  seasonal decision is reserves: in specific 2025 regimes (and arguably each winter)
  participation would have paid.
- The uplift is dependable but spike-carried: **no losing month**, worst losing day
  −€27k — but **the best 5% of quarter-hours deliver 63% of the annual uplift**.

## What each strategy is worth

Two views. *Added in order*: each strategy switched on after the previous ones, re-optimised.
*If dropped*: that strategy removed from the full set, the rest re-optimised — what we would
actually lose by not doing it.

| Strategy | Added in order | If dropped | What it does |
| --- | --- | --- | --- |
| *(sell all day-ahead)* | €10.69M base | — | Baseline |
| Day-ahead withholding | +€1.27M | −€2.13M | Hold power back when day-ahead is cheap; sell into balancing instead. |
| mFRR ↔ aFRR routing | +€1.81M | −€2.51M | Route balancing volume to the better-paying product, re-checked every 15 min. |
| Intra-day forecast trust | +€2.73M | −€2.73M | Offer the extra MW the late forecast promises into balancing. |
| Reserve down-capacity | +€0.00M | €0.00M | Sell curtailment readiness in the capacity auction. |
| Reserve up-capacity | +€0.00M | €0.00M | Hold back MW as paid upward headroom. |

No single strategy dominates: dropping any one of the three costs €2.1–2.7M, and their
sum (€7.4M) exceeds the joint uplift (€5.8M) — they compete for the same MWh, so they
partly back each other up.

## Which settings actually matter

The optimiser now reports how much revenue is lost if one setting is moved off its optimum
(everything else optimal). Out of 11 energy-strategy settings, **six carry ~all the weight**:

- **Trust the intra-day forecast fully** (Z = 1) — heaviest lever, −17% if turned off.
- **Withhold threshold ~40 €/MWh and withhold fully below it** — −13% each if badly set;
  any threshold in 30–65 € performs within 1%.
- **Upward routing must adapt fast** — speed, lookback and step together: re-check every
  15 min on a 1-hour lookback (−13% / −9% / −8% if slowed).
- The remaining five settings (the downward-routing dials and both starting splits) are
  worth ≤2.4% each — decoration, not decisions.

## Reserve markets — the new result

Capacity prices are spike-carried: the top 20% of hours hold **94% of the aFRR** and
**58–75% of the mFRR** capacity-price mass. What you believe about those spikes decides
everything:

| Pricing assumption | Reserve value on top of energy strategies |
| --- | --- |
| Spikes persist (old 5/95 winsor, aFRR up to 430 €/MW·h) | **+€4.3M** — offer everything, all-aFRR |
| Spikes don't persist (prices capped ~19–26 €/MW·h) | **€0.0M** — optimal participation is zero |

Mechanics of the zero: awarded down-capacity MW must be sold day-ahead, which defeats the
withholding strategy exactly when it earns most; up-capacity moves MW out of guaranteed
day-ahead sales into a capacity fee plus conditional activation revenue — together worth
less than just selling the power. At full participation the capacity leg collects €1.9M
but the total drops €1.0M.

**The nuance worth keeping an eye on — reserves were not always worthless:**

- **Feb–Apr 2025 (post-desynchronisation):** mFRR-down capacity paid ≥15 €/MW·h in 71% of
  hours (median 19.5). Even priced at that median, participation would have added ~**+€0.3M
  in one quarter**. This is a price *floor* effect, not spikes.
- **Aug–Oct 2025:** aFRR-up capacity paid ≥20 €/MW·h in 43% of hours; even capped at 20 €,
  up-capacity would have added ~+€0.13M.
- **Winters:** month-by-month, down-capacity beats energy trading Nov–Mar (+€0.37M over
  winter 25/26 at conservative caps) and loses May–Oct (−€1.4M over summer 2025), because
  summer balancing spikes make withheld energy far more valuable than the capacity fee.
- **Feb–Apr 2026 (most recent):** capacity price 80th percentiles are back at 9–24 €/MW·h;
  participation adds nothing.

Operational read: **do not build reserve income into the base case.** Treat it as a
conditional product — attractive when the capacity price floor is high (post-desync 2025,
possibly winters) and balancing spreads are calm. A simple monthly check of the running
capacity-price level against ~15–20 €/MW·h is enough to spot the regime.

## One setting fits all — re-verified

The single full-period configuration captures **94.3–99.9%** of each season's own optimum
(five 3-month windows, energy strategies): 98.0 / 94.3 / 98.4 / 99.4 / 99.9%. The previous
report's 96–100% claim stands. Per-season "best" settings look very different (withhold
threshold 14–240 €/MWh), but the revenue surface is flat around the top, so the differences
are noise, not seasonality. **Exception:** if reserves are included, Feb–Apr 2025 capture
falls to ~80% — the participate-or-not reserve decision is the one genuinely
regime-dependent choice (and that window overstates reserves: its aFRR energy data is
missing, so the competing energy value is undercounted).

## How risky is the uplift

Measured on the fixed configuration vs do-nothing, per quarter-hour:

- **No losing month** (worst: Mar 2025, +€28k). 37 of 451 days lose, worst day −€27k;
  the running uplift never dips more than €47k below its high-water mark.
- The strategy barely adds imbalance exposure: penalty costs €2.0M vs €1.9M for
  do-nothing (+7%), because withheld power also reduces the promised position.
- **Concentration is the real operational risk:** 1% of quarter-hours deliver 24% of the
  uplift; 5% deliver 63%. Missing spike windows — downtime, rejected bids, or our own
  volume moving thin prices — erodes the number disproportionately. This is also why
  the +54% must be read as an upper bound.

## Speculative intra-day oversell (S3) — unchanged verdict

On top of the improved baseline, S3 at its safety settings adds **+€1.3M**; letting the
optimiser tune it re-opens every safety gate and sells the 5 MW cap at every opportunity
(+€1.9M) — the cap is the only thing limiting it, because the model assumes the intra-day
market absorbs our volume without moving. Same conclusion as v1: a ceiling that assumes
liquidity we do not have, not a bankable number.

## Caveats

- **No price impact / no auction competition.** All volumes clear at observed prices; in the
  reserve auctions we win every offered MW. Every number is an upper bound — most of all the
  5/95 reserve counterfactual and S3.
- **April 2026 imbalance prices are missing upstream**; that month's imbalance costs are
  zeroed for all configurations (small optimistic bias, both sides). Not disclosed in v1.
- **aFRR data starts May 2025**, so Feb–Apr 2025 understates energy value and overstates
  relative reserve value. aFRR capacity prices also have gaps (43% missing in that window).
- **Optimiser noise:** joint searches over 16+ settings can under-find by up to ~3%; the v2
  headline numbers were re-verified with seeded refinement, and reserve conclusions were
  cross-checked with targeted sweeps. Treat differences under ±0.5% as noise.
- Season rows use winsorisation computed within their own window (same convention as v1),
  so seasonal figures do not sum exactly to the full-period figure.

## Appendix — the numbers

**Fixed configuration (energy strategies) vs do-nothing, per season, all days:**

| Period | Fixed config | Do-nothing | Uplift | Own-optimum capture |
| --- | --- | --- | --- | --- |
| Feb–Apr 2025 \* | €2.25M | €1.89M | +19% | 98.0% |
| May–Jul 2025 | €3.76M | €1.16M | +224% | 94.3% |
| Aug–Oct 2025 | €3.74M | €1.82M | +105% | 98.4% |
| Nov 2025–Jan 2026 | €4.43M | €3.46M | +28% | 99.4% |
| Feb–Apr 2026 | €3.50M | €2.46M | +43% | 99.9% |
| **Full 15 months** | **€16.49M** | **€10.69M** | **+54%** | — |

\* day-ahead/mFRR only — aFRR feed starts May 2025.

**Fixed configuration:** withhold below 40 €/MWh, withhold fully (Y=1), trust intra-day
forecast fully (Z=1), both routing splits adaptive (1-hour lookback, re-check every 15 min,
step 0.5), reserves off, S3 off.

**Reserve capacity price caps used (80th percentile, full period):** mFRR-down 19.4,
aFRR-down 26.2, mFRR-up 29.0, aFRR-up 51.6 €/MW·h. The 2025 regime peaks these caps cut
away: aFRR capacity reached 430 €/MW·h at the old 5/95 winsor and 4,000 €/MW·h raw.

*Method: unified engine, one optimiser run per configuration (seeded random search +
coordinate refinement + sensitivity analysis), reserve conclusions verified with seeded
refinement and joint parameter sweeps. "Do-nothing" = sell the day-ahead forecast at the
day-ahead price. v1 anchors reproduced exactly (baseline €10.69M, withholding-only €11.95M).*
