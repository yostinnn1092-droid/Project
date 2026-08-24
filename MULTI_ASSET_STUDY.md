# An independent replication — eleven hypotheses, zero survivors

This is a separate research pass, done in an isolated scratch environment
without reference to the rest of this repository, and only reconciled with
it afterward. It reaches the same conclusion as `README.md` and `SETUP.md`
by a different route: different markets, different strategies, different
code. It is recorded here as a companion note, not merged into the existing
narrative — everything above this file stands as it was.

**Bottom line, matching the rest of this repo exactly: no edge was found.**

## Scope

- **Instruments**: 11 asset-class ETFs (US/international/EM equities,
  treasuries, gold, commodities, property, high-yield credit), 40
  individual large/mid-cap US stocks, and FRED macro series (yield curve,
  credit spreads, VIX).
- **Window**: full available daily history per instrument, 2007–2026 for
  the ETF book (spans the 2008 and 2020 crises), 2010–2026 for stocks.
- **Method**: every signal is shifted so a decision at bar *t* can only use
  information known by the close of bar *t*, verified with a standalone
  test (a signal deliberately fed tomorrow's return returns an ~86,000,000×
  multiple; the same signal routed through the real shift returns 0.51×).
  Costs are charged on turnover, not per trade. Every strategy is tuned
  in-sample and judged out-of-sample exactly once, on a date split fixed
  before any parameter search.
- **The check that mattered most**: a plain "beats a rotation-shuffled
  null" test is not enough — a decorrelated but *uninformative* overlay can
  clear that bar for free, by smoothing a blended exposure path rather than
  by containing information. Every hypothesis below was additionally tested
  against hundreds of synthetic signals matched to its own exposure and
  persistence but built from randomness instead of real data. One
  hypothesis (#1) looked real (p=0.003) until this check was applied, then
  collapsed to p=0.36. Every hypothesis after that was checked this way
  from the start.

## The one non-original result

Trend-following (a 100-day Donchian breakout, risk-parity weighted across
the 11-ETF book) reduces max drawdown from −24.9% (buy & hold) to −8.1%,
independently significant in both halves of the window (p=0.0005 each).
This is the standard time-series-momentum / managed-futures result — it is
**not original**, and is recorded here only as a baseline every other
hypothesis was tested against. Its Sharpe advantage, notably, does *not*
clear the same rotation-null bar (p=0.086) — the honest claim is a
drawdown effect, not a return edge, and leverage sized to match it in one
half overshot its own target drawdown when applied blind to the next.

## Eleven original hypotheses

| # | Construction | Data | Result |
|---|---|---|---|
| 1 | Cumulative intraday return as a distribution-detection filter | ETF price/volume | p=0.003 → **p=0.36** once checked against matched-shape fakes. Zero information. |
| 2 | Cross-market trend-agreement as a regime gate | ETF price | Underperformed buy & hold on every metric. |
| 3 | Volatility-of-volatility as a whipsaw predictor | ETF price | Actively harmful: Sharpe 0.84→0.63, MaxDD −8%→−14%. |
| 4 | Signal-age decay (fresh vs. stale trend signals) | ETF price | No edge; p=0.60–0.65 vs. fakes. |
| 5 | Cross-sectional return dispersion as an opportunity gate | ETF price | Underperformed, lost to fakes on both metrics. |
| 6 | Cross-market lead-lag (one market predicting another) | ETF price | All 11 selected "leaders" lost money out-of-sample; leader identity ranked at chance (1/11). |
| 7 | Volume-gated same-day reversal/continuation | ETF price/volume | Sharpe −1.81 OOS, worse than either un-gated baseline. |
| 8 | Slope×R² relative-strength tilt, long/short | ETF price | OOS Sharpe ≈ 0 vs. 0.87 for buy & hold. |
| 9 | Overnight-gap + volume confirmation, 5-day hold | 40 individual stocks | Net loss; the volume gate underperformed its own un-gated baseline. |
| 10 | Turn-of-month calendar effect, tested for decay | ETF price (calendar) | p=0.71 vs. fakes; sign flips between the two halves of the window. |
| 11 | Yield-curve steepening-after-inversion as a trend regime | FRED (T10Y2Y) | Condition fired on 0.8% of days — too rare to move any metric; p=0.56. |

Each carried a stated economic mechanism before testing, not a pattern
found first and rationalized after. None survived.

## What this adds to the existing conclusion

Nothing changes the bottom line — it independently confirms it, from a
different angle (asset-class trend and cross-sectional structure, vs. this
repo's focus on single-instrument scalping, forex, and XAUUSD systems).
Two unrelated searches, same honest answer: **the easy edges are not
there**, and a result that looks significant on a first pass has to clear
a much higher bar — checked against genuine synthetic noise, not just a
naive shuffle — before it means anything.

No code from this pass is included here; it ran in a temporary environment
that does not persist. This file is the record of what was tried and what
happened.
