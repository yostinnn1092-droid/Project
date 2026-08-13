# Trading bot — a teaching skeleton

A small, complete, honest trading bot you can read in one sitting and run
in one command. Built to teach the *architecture* and the *failure modes*,
not to make money.

```bash
uv venv .venv && uv pip install -r requirements.txt --python .venv/bin/python
.venv/bin/python run_backtest.py    # backtests + the three big lessons
.venv/bin/python live_paper.py      # paper-trading loop
```

---

## Read this before anything else

Most retail trading bots lose money. Not because the code is hard — the
code is the easy part, and it is all in this repo — but because a backtest
is a machine for generating false confidence. Everything below is arranged
around that problem.

Two claims worth internalising:

- **A profitable backtest is the default outcome, not a signal.** Try
  enough parameter combinations on any price series and some will look
  excellent purely by chance. That is a property of searching, not of the
  market.
- **You are trading against people with better data, faster execution, and
  full-time quant teams.** Your edge has to come from somewhere they are
  not looking — a niche market, a longer horizon, a constraint they have
  and you don't. "I coded an SMA crossover" is not a source of edge.

Treat the first live version as tuition you are paying to find out what
your backtest was hiding.

### The bug that rewrote this README

`run()` used to default to `RiskManager()`, which halts at a 5% daily loss
and **stays halted for the rest of the run**. Sensible for live trading,
ruinous for measurement: it silently converts every backtest into "trade
until the first bad day, then sit in cash forever" — including the
buy-and-hold benchmark.

It surfaced when buy-and-hold on BTC reported **−22.5% over a period the
asset rose 138x**. A September 2014 drawdown tripped the halt on day three
and equity froze for the next twelve years.

Fixing it (risk limits are now opt-in; pass the *same* manager to both sides
of any comparison) changed several results in this file, and reversed two
conclusions I had already written down:

| | before | after |
|---|---|---|
| SmaCrossover, 5min | −3.72% *("a loser after fees")* | **+61.41%** |
| MeanReversion, 5min | +14.98% *("profitable")* | **−26.70%** |
| Best timeframe | 1h, +23.87% | **4h, +143.98%** |

Strategies holding large directional positions got frozen; strategies with
tight per-trade stops never tripped the halt at all, which is why the
scalper, Fib BOS, ICT, opening-range and H1-stocks results came through
completely unchanged.

The lesson generalises past this repo: **a benchmark that quietly stops
trading makes every comparison against it worthless.** When a strategy looks
good, check that the thing you compared it to was actually running.

---

## Architecture

Five parts, each replaceable in isolation. Everything flows one way.

```
   DATA          STRATEGY         RISK          EXECUTION        METRICS
   bars    ->    target     ->   clamp     ->   close the   ->   equity,
   OHLCV         weight          limits,        gap to           drawdown,
                 -1..1           halt           target           Sharpe
 data.py       strategy.py     risk.py      backtest.py       backtest.py
                                            broker.py
```

The load-bearing design decision: **a strategy returns a target weight, not
an order.** It says "I want to be 100% long", never "buy 12 units". So it
holds no position state, cannot desynchronise from reality, and the exact
same object drives the backtester and the live broker. If those two ever
diverge, your backtest is measuring a different system than the one holding
your money.

| File | Responsibility |
|---|---|
| `tradingbot/data.py` | Load and **validate** bars. Rejects NaNs, duplicate timestamps, impossible high/low. |
| `tradingbot/strategy.py` | `Strategy.on_bar(history) -> float`. Pure function of the past. |
| `tradingbot/risk.py` | Position caps, drawdown kill switch, stop-based sizing. Can only *reduce* exposure. |
| `tradingbot/backtest.py` | Event-driven loop, realistic costs, metrics. |
| `tradingbot/broker.py` | `PaperBroker` (simulated) and `CcxtBroker` (documented stub). |

---

## The three lessons `run_backtest.py` demonstrates

All numbers below are real output from the included data: 20,000 five-minute
bars of a liquid HK equity, June 2024 – Sept 2025 (1.23 years).

### 1. Costs decide which strategies are even possible

| | BuyAndHold | SmaCrossover | MeanReversion |
|---|---|---|---|
| return, **with** costs | 128.76% | 61.41% | **-26.70%** |
| return, **zero** costs | 128.90% | 101.21% | **+23.24%** |
| trades | 2 | 539 | 6,464 |
| fees as % of start | 0.04% | 16.95% | **35.33%** |

MeanReversion is a 23% winner for free and a **−27% loser** at 4bp+2bp.
Nothing about the signal changed; it trades 6,464 times and pays 35% of the
starting account in fees. Turnover is a cost multiplier, so a strategy's
viability depends on frictions you must model *before* you get attached to
it.

Note that neither strategy beats simply owning the thing (128.76%). That
comparison is the one that matters, and it is the one this repo keeps
coming back to.

### 2. Lookahead bias — and what it really looks like

`LookaheadPeeker` computes next-bar return over the whole dataframe with
`.shift(-1)`, then reads it one bar at a time. Every individual call looks
innocent; the poison went in before the loop started.

| | BuyAndHold | LOOKAHEAD BUG |
|---|---|---|
| total return | 128.76% | **71,572,067,681%** |
| Sharpe | 1.62 | **35.78** |

**A Sharpe above ~3 on retail data is a bug report, not a discovery.** This
is the most valuable pattern in the repo: learn to distrust your own good
results. The bug is nearly always a feature computed across the full series
before splitting — a `.shift(-1)`, a scaler fitted on all the data, a
label built from the future.

There is a subtler version too (`execution="same_close"`: filling at the
close you decided on). Worth fixing for correctness — but note it did *not*
flatter returns on this data; the close→next-open gap is mostly noise and
biases whichever way the sample falls. Only the feature-level leak in 2a
manufactures returns.

### 3. Out-of-sample is the only number that means anything

Grid-searching SMA parameters on the first 70%:

- best on **train**: `fast=20, slow=240`, Sharpe **1.79**
- same params on **test**: Sharpe **1.39**

The in-sample number is one you *chose* by searching; the out-of-sample one
is one the market gave you. Split chronologically — never randomly. Random
k-fold on time series trains on the future.

A caveat this repo is too small to fix: even that 1.39 is optimistic,
because the test set was used to decide the approach was worth writing up.
Real practice keeps a final holdout untouched until the very end, and
accepts that every look at it burns some of its value.

---

## The progression — do not skip a step

1. **Backtest.** Fast, free, catches logic errors. Cannot catch anything
   about the real world.
2. **Paper trade** (`live_paper.py`). Live feed, simulated fills, real
   time. This is where you find stale data, duplicate bars, restarts that
   forget the position, and API errors. **Run for weeks.** Most blown-up
   bots skipped this — a backtest cannot fail to receive a websocket
   message.
3. **Live, tiny.** Real money, sized so the loss is affordable tuition.
   Compare fills against what paper predicted; the difference is your real
   slippage.
4. **Live.** Only after (3) has matched (2) for a meaningful period.

Note the included paper run ends **down 12.58%** and trips the 15%
drawdown halt. That is not a broken demo — that is the honest output of a
mediocre strategy meeting real costs, and it is what you should expect to
see most of the time.

---

## Before real money touches this

`CcxtBroker` is a deliberate stub. Its docstring lists what must exist
first — each item is a real way people have lost real money:

- **Idempotency.** A network timeout is not a rejection. Attach a client
  order id and check whether it landed before retrying, or one intended buy
  becomes three.
- **Reconciliation.** Read the true position from the exchange on every
  start. Never trust local state across a restart.
- **Partial fills**, **tick/lot precision**, **min notional**, **rate
  limits and 429 backoff.**
- **A kill switch that works when the bot doesn't** — you will need it
  precisely when things are unhealthy.
- **Key hygiene.** Trade-only permissions, withdrawals disabled, keys in
  env vars or a secrets manager, never committed. Start on testnet
  (`exchange.set_sandbox_mode(True)`).

---

## Scalping

`tradingbot/scalping.py` + `run_scalper.py`. A mean-reversion scalper with an
explicit exit state machine (target / stop / timeout), plus the cost
arithmetic that decides whether any scalper can work at all.

```bash
python run_scalper.py
```

**Read the cost wall before writing a signal.** A scalp is a round trip, so
you pay costs twice. At retail rates (4bp fee + 2bp slippage per side) that
is **12bp per trade**, and the required win rate follows directly:

| target | required win rate (retail) | required win rate (pro, 2bp) |
|---|---|---|
| 5 bp | **170%** — impossible | 70% |
| 10 bp | **110%** — impossible | 60% |
| 20 bp | 80% — implausible | 55% |
| 50 bp | 62% — hard | 52% |
| 100 bp | 56% — plausible | 51% |

Targets below ~12bp are not "hard", they are **arithmetically closed**: costs
exceed the entire profit target, so no win rate can save them.

### What the run actually shows

The scalper found a **real edge — and still lost**, which is the most useful
outcome this repo produces. Over 2,031 round trips:

| | retail | professional | zero (fantasy) |
|---|---|---|---|
| win rate | 45.9% | 45.9% | 45.9% |
| gross expectancy | **+3.14 bp** | +3.14 bp | +3.14 bp |
| round-trip cost | −12.0 bp | −2.0 bp | 0 bp |
| **net expectancy** | **−8.86 bp** | **+1.14 bp** | +3.14 bp |
| return | **−18.87%** | −1.16% | +8.72% |

The signal is **identical** in all three columns — only the toll booth
changed. It genuinely predicts something (positive gross expectancy, stable
at 2.4–4.7bp across every target tested). It is simply worth less than the
cost of acting on it. The retail run hit the 25% drawdown kill switch.

Widening the target does not escape: gross expectancy rises only from 2.4bp
to 4.7bp while the 12bp cost stays fixed. The lines never cross.

**The lesson generalises past scalping.** Once net expectancy per trade is
negative, nothing downstream fixes it — not position sizing, not scheduling,
not an AI layer, not more capital. More activity just loses faster. The only
real levers are *lower costs* or *a much bigger edge*.

And note this result is **optimistic**: bar data assumes stops fill at exactly
the stop price. Real stops gap through, and gaps go against you. On ticks it
would look worse.

---

## XAUUSD production system — built, tested, did not pass

The `xauusd/` package: a full H4-regime / H1-pullback system with
broker-spec sizing, MT5 and paper adapters, and a decision journal. See
[`xauusd/__init__.py`](xauusd/__init__.py) for the module map.

```bash
python fetch_stocks.py --gold
python run_xauusd_backtest.py     # single backtest + no-trade diagnosis
python run_xauusd_gates.py        # the two gates before paper trading
```

### The journal earned its place on the first run

Version one took **1 trade in 10,640 bars**. Unusable — and the no-trade log
said exactly why. Two structural faults, invisible without it:

- the rejection required the dip *and* the recovery close on **one candle**
  (a rare shape) → now a 3-bar window
- the stop searched **120 bars** for structure, so most stops breached the
  ATR cap (329–619 `no valid stop placement` rejections) → now a dedicated
  30-bar stop window

Calibrated for **trade frequency, not returns**. That distinction is the
difference between fixing a bug and fitting the data.

### Gate 1 — walk-forward, 19 windows

```
profitable            : 8/19
beat buy-and-hold     : 4/19
mean return           : +0.07%
mean excess over B&H  : -2.33%
distinct param sets   : 7/19        (reasonably stable)
95% CI (excess)       : [-4.75%, +0.29%]
P(excess > 0)         : 3.8%
```

### Gate 2 — search noise

```
strategy              : -1.87%  (25 trades)
random mean/best      : +1.25% / +7.91%
beat random on        : 6/20 seeds
beat the BEST random  : NO
```

**Both gates FAIL. The strategy does not proceed to paper trading.**

### What the numbers actually say

Mean window return is **+0.07%** — the system is not losing money, it is
barely doing anything. 25 trades in two years, flat most of the time. Gold
rose 67% across the period, so "loses to buy-and-hold" here mostly means
"sat in cash during a bull market", which is the expected behaviour of a
filter this selective and not a malfunction.

One pattern is worth recording *and* discounting: in the 5 windows where
buy-and-hold lost money, the strategy beat it in 4. That is the classic
trend-following shape — flat or positive when the market falls. It is also a
5-window post-hoc subgroup, which is precisely the kind of slice that
manufactures false findings. Noted, not believed.

**No edge was demonstrated and none is claimed.** The engineering is sound —
risk budget respected, every decision logged, no lookahead, demo-gated. The
hypothesis it encodes did not pay on gold over this period, and finding that
out cost an afternoon rather than an account.

---

## The strategy search — and the answer to "what's most profitable?"

`run_search.py`. 20 strategies across four structurally different families
(SMA crossover, Donchian breakout, z-score mean reversion, adaptive regime
switching, ICT) over 31 instruments — 10 forex pairs and 21 stocks, hourly.
Scored **out-of-sample only** (last 40% of each series) on **excess over
buy-and-hold**.

```bash
python run_search.py
```

### The full ranking

| rank | strategy | forex | stocks | combined |
|---|---|---|---|---|
| 1 | SMA 40/100 | −0.78% | −14.71% | **−7.75%** |
| 2 | MeanRev 100/2.0 | −3.60% | −13.82% | −8.71% |
| 3 | SMA 10/50 | −2.32% | −16.13% | −9.23% |
| 4 | SMA 20/100 | −2.18% | −17.14% | −9.66% |
| 5 | SMA 50/200 | −4.24% | −16.09% | −10.17% |
| … | … | | | |
| 20 | Adaptive ER>0.45 | −6.09% | −29.50% | −17.79% |

```
strategies with positive excess : 0/20
median strategy excess          : -13.66%
```

**Every single strategy lost to buy-and-hold.** The "winner" is the least
bad one, not a good one. So the honest answer to *"find the most profitable
strategy"* is: **buy and hold.** Nothing tested beat it, on either asset
class, out-of-sample.

### The reality check, and a bug it exposed

The point of the second pass is that a search always produces a winner —
test 20 worthless strategies and one still finishes first. So 20
`RandomEntry` strategies ran through the identical pipeline:

```
random  mean / best : -14.04% / -12.90%
real    mean / best : -13.77% /  -7.75%
real strategies above the best random: 7/20
```

The real strategies **do** contain signal — seven of them beat the best of an
equally large no-edge search, and the SMA family clusters at the top rather
than scattering randomly. That is a genuine, if small, finding: trend
following is not noise.

It is also **not enough to matter**, and the first version of this script
missed that. It checked only "did the winner beat random search?", saw yes,
and printed *"Worth a proper out-of-sample and walk-forward follow-up"* —
recommending further work on a strategy that loses 7.75% to a benchmark
anyone can buy for free.

`run_search.py` now requires **both** conditions: positive excess *and*
outside search noise. Beating noise while losing to the benchmark means the
strategy has signal that does not cover its costs and the return forgone by
not simply holding. That is a distinct outcome and it now says so.

---

## ICT on forex — the first result that didn't collapse

`tradingbot/ict.py` + `run_ict.py`. A mechanical reading of the canonical ICT
setup — liquidity sweep → market structure shift → Fair Value Gap entry, stop
beyond the sweep, fixed 2R target, killzone filter — over 10 pairs and
~123,000 hourly bars.

```bash
python fetch_stocks.py --forex && python run_ict.py
```

### vs the control (identical risk management, random entries)

| pair | ICT | random | ICT win% | rand win% | edge |
|---|---|---|---|---|---|
| NZDUSD | +7.30% | −0.37% | 58.3% | 37.8% | **+7.67%** |
| GBPUSD | +4.41% | −1.74% | 54.2% | 36.3% | **+6.15%** |
| EURUSD | +3.12% | −2.73% | 53.1% | 31.9% | **+5.85%** |
| AUDUSD | +0.12% | −2.24% | 51.1% | 33.3% | +2.36% |
| USDCAD | +0.30% | −0.18% | 66.7% | 35.6% | +0.48% |
| USDCHF | −0.34% | −0.64% | 33.3% | 34.7% | +0.30% |
| EURJPY | −0.85% | −1.06% | 45.5% | 36.5% | +0.21% |
| EURGBP | −0.58% | −0.19% | 45.0% | 39.9% | −0.39% |
| GBPJPY | −2.14% | −0.85% | 33.3% | 35.1% | −1.29% |
| USDJPY | −4.75% | −1.85% | 32.3% | 35.0% | −2.90% |

```
ICT beat random on    : 7/10
mean edge over random : +1.84%
95% CI                : [-0.14%, +3.99%]   <- barely includes zero
P(edge > 0)           : 96.4%
```

**Borderline, not proven.** A one-sided read clears the 95% bar; the
two-sided interval misses it by 0.14pp. This is the only result in this repo
that got that close. The win-rate gap is the striking part — ICT averages
~47% against random's ~35% under *identical* stop and target logic.

### Both ICT filters earn their keep

| variant | trades | win% | expectancy | mean return |
|---|---|---|---|---|
| **full setup** | 348 | **47.3%** | **+0.91 bp** | **+0.66%** |
| no FVG requirement | 2,993 | 45.4% | +0.25 bp | −2.68% |
| no killzone filter | 1,132 | 39.4% | **−3.61 bp** | −4.07% |
| neither filter | 4,569 | 44.4% | −0.68 bp | −7.52% |
| 1R target | 357 | 53.6% | +0.27 bp | +0.49% |
| 3R target | 346 | 45.6% | +0.91 bp | +0.45% |

Removing either filter hurts, and not merely by trading more: **per-trade
expectancy** falls too (+0.91bp → −3.61bp without killzones). The session
filter is selecting better trades, not just fewer. That is a concrete,
checkable claim of ICT's that survived testing.

### Why it is still not a green light

**Split by time, the edge is unstable:**

```
half 1 (2024-08 -> 2025-08) : mean -0.07%   positive 3/10
half 2 (2025-08 -> 2026-08) : mean +0.70%   positive 6/10
pairs positive in BOTH halves: 3/10
```

The whole result lives in the second year. Only EURUSD, GBPUSD and NZDUSD
worked in both halves — and those are exactly the three carrying the headline.

**The 10 pairs are not 10 independent tests.** USD appears in 7 of them, EUR
in 4, JPY in 3. Bootstrapping across them treats correlated samples as
independent and therefore *overstates* the confidence above. The effective
sample is meaningfully smaller than 10, which alone could explain the
borderline p-value.

**And the edge is small:** +0.91bp per trade over 348 trades in two years.

So: genuinely the most interesting thing tested here, and nowhere near
fundable. The honest next step is more history, more non-USD crosses, and a
significance test that accounts for cross-pair correlation.

### What this test cannot settle

This is ONE mechanical reading. Real ICT adds higher-timeframe bias and
discretion about which liquidity pool matters. A fair reading is "the
mechanical core shows a weak signal", not "ICT is proven" — nor would a
negative have meant "every practitioner is wrong". But the converse deserves
equal weight: an edge that lives entirely in unstated discretion cannot be
verified by anyone, including the person trading it.

---

## H1 across 21 stocks — the definitive answer

`fetch_stocks.py` + `run_h1_stocks.py`. The original H1 finding came from ONE
stock over 15 months. This runs it over **21 instruments and ~73,000 hourly
bars**, judged on **excess over buy-and-hold** — because in a rising market
any long-biased strategy looks good, and the only real question is whether it
beat simply owning the asset.

```bash
python fetch_stocks.py && python run_h1_stocks.py
```

### Pooled walk-forward: 231 windows, 21 stocks

```
mean window return   :  +1.72%
mean excess over B&H :  -1.87%
windows beating B&H  :  83/231  (36%)
stocks with +excess  :  3/21
95% CI (mean excess) :  [-2.86%, -0.90%]     <- entirely BELOW zero
P(mean excess > 0)   :   0.0%

VERDICT: SIGNIFICANTLY NEGATIVE — reliably worse than buy-and-hold
```

**This is a confident negative, not an inconclusive one.** The confidence
interval does not straddle zero, it sits wholly beneath it. H1 SMA trend
following does not merely fail to beat buy-and-hold on stocks — it reliably
*loses* to it, by about 1.9 percentage points per window. Only 3 of 21 stocks
showed any positive excess.

The fixed-parameter run (20/50, no tuning at all) is genuinely inconclusive by
comparison — 6/21 beat buy-and-hold, mean excess −2.62%, CI [−11.79%, +7.14%]
— but it points the same way with less power.

So the single-stock H1 result was **that one stock's story, not an effect.**
More data did not sharpen it; it reversed it. (That original figure was
+23.87% when this was written; the risk-manager fix later restated it as
+79.03%. The restatement makes the single-stock number *better* and changes
this conclusion not at all — which is the point of testing across 21 stocks
and 231 windows instead of admiring one.)

### A reporting bug worth keeping

The first version of this script printed *"NOT SIGNIFICANT — CI includes
zero"* for the pooled result. The CI was `[-2.86%, -0.90%]`, which does not
include zero at all.

Collapsing "significantly negative" into "inconclusive" throws away the
strongest finding a test can produce, and would have let a reliably losing
strategy be recorded as merely unproven. `verdict()` now returns three
outcomes rather than two, so the case cannot vanish silently again.

### Survivorship bias, stated plainly

All 21 tickers are companies listed **today**. Firms that went bankrupt or
were delisted are absent, because you cannot download data for something that
stopped trading. The basket is therefore pre-filtered for survival, which
flatters buy-and-hold — the very benchmark the strategy lost to. Names with
long bad stretches (INTC, PFE, BA, NKE, VZ) are included to blunt this; it
cannot be removed without a point-in-time constituent list.

---

## Maker orders — the rescue that wasn't

`tradingbot/maker.py` + `run_maker.py`. The scalper had a real +3.14bp gross
edge killed by a 12bp taker cost, so this attacks the cost: rest limit orders
and earn a rebate instead of paying a fee. Mean-reversion scalping *is* market
making in disguise — you buy when others panic-sell — so the fit is genuine.

```bash
python run_maker.py
```

The headline looks like a triumph: **−18.87% → +37.69%, Sharpe 1.24.**

It is not. Splitting the profit settles it:

| | |
|---|---|
| total profit | **+$3,769** |
| rebate income | **+$4,020** |
| **trading P&L** | **−$250** |
| notional traded | **$40,196,005** |
| turnover vs capital | **4,020×** |

**The strategy still loses money trading.** Every dollar of profit is rebate,
and collecting it needed 4,020× turnover on a $10,000 account. That is not
better execution rescuing a strategy; it is rebate farming wearing the
strategy as a costume.

Three independent reasons to reject it:

1. **At a 0bp maker fee it loses** (−2.36%). The signal never became
   profitable — only the fee schedule changed.
2. **Returns by limit offset are non-monotonic**: −75%, −51%, **+38%**, −45%,
   −17% at 0/2/5/10/20bp. A real effect does not spike at one setting and
   collapse on both sides. That shape is an artifact.
3. **An 83% fill rate on passive limits is not realistic.** The model fills
   whenever price trades through the level, with no queue ahead of you and no
   competition — the two things that actually decide maker fills.

The module still measures adverse selection explicitly (`fwd_move`: average
move in your favour over 3 bars after each fill) because a maker backtest that
fills on touch and ignores adverse selection is a machine for imaginary
profits. `Strategy.sync_position()` was added for the same honesty reason: a
stateful strategy must be told what it *actually* holds, since limit orders
often do not fill, and otherwise it manages a phantom position.

**So the scalper is not salvageable this way.** Its edge is smaller than any
realistic cost of collecting it. That is the final answer on scalping in this
repo, and it took a suspicious-looking win to get there.

---

## Timeframes — where the cost wall actually breaks

`run_timeframes.py`. Same data, same strategies, resampled to five bar sizes.
Cost per trade never changes; the number of trades and the size of the move
you are chasing both do.

```bash
python run_timeframes.py
```

**Trend following (SMA 20/60), retail costs:**

| timeframe | bars | trades | return | sharpe | max dd | fees |
|---|---|---|---|---|---|---|
| 5min | 20,000 | 539 | +61.41% | 1.33 | −27.27% | **16.95%** |
| 15min | 7,274 | 188 | +65.52% | 1.41 | −29.35% | 6.48% |
| 1h | 2,426 | 59 | +79.03% | 1.55 | −24.72% | 2.13% |
| **4h** | 912 | 29 | **+143.98%** | **2.02** | **−22.19%** | 1.16% |
| 1D | 305 | 10 | +55.74% | 1.07 | −29.76% | 0.21% |

**Return rises as fees fall.** Identical logic; fees drop 15x from 5min to
4h (16.95% → 1.16%) and the return more than doubles, with the smallest
drawdown of the five. This is the constructive half of the scalping lesson:
you do not beat the cost wall by predicting better, you beat it by trading
less often for bigger moves.

Read the 4h row against buy-and-hold's +128.76%, though, before getting
excited. It clears it by 15 points on one stock over 1.23 years — which is
well inside the range you get from picking the best of five timeframes after
the fact. `run_search.py` and `run_h1_stocks.py` exist because this kind of
single-instrument result does not survive being tested properly.

**Mean reversion loses at every timeframe** — −26.70% at 5min, worsening to
−57.24% at 4h. Fees explain the 5min number (35% of the account) but not the
4h one (1.35%), so on this instrument the signal itself is simply backwards:
it is trending, and fading a trend loses money whatever the bar size.

**H1 out-of-sample** (tune on first 70%, judge on last 30%): best train
config `fast=10 slow=50` at Sharpe 2.49 → **1.45 out-of-sample, +14.02%** —
against buy-and-hold's **+28.64%** over the same stretch. The tuned strategy
survived out-of-sample and *still* lost to doing nothing. The in-sample-to-OOS
drop (2.49 → 1.45) is the usual and expected direction; losing to the
benchmark anyway is the point.

### One result that looked good and was not

The 4h scalper row showed **+10.96% return alongside −1.14bp net expectancy**
— a contradiction, so it got checked rather than reported. The cause:

```
mean |close -> next open| gap at 4h : 0.51%
scalper take_profit                : 0.30%
```

The price jump between deciding and filling is **larger than the entire
profit target**. The target and stop barely bind, and the outcome is decided
by gap luck rather than by the strategy. That +10.96% is noise over 108
trades, not a working scalper, and holding 3 bars at 4h is 12 hours — not
scalping in any case. `Scalper.trade_report()` now documents the limit.

---

## Walk-forward — the strongest test in this repo

`tradingbot/walkforward.py` + `run_walkforward.py`. Re-tune on the past, trade
the next stretch blind, roll forward, repeat. Nine windows on H1 data.

```bash
python run_walkforward.py
```

| # | test period | params | return | buy & hold | excess |
|---|---|---|---|---|---|
| 0 | Sep–Oct 2024 | 20/200 | +5.49% | +4.28% | +1.21% |
| 1 | Oct–Dec 2024 | 10/50 | −3.23% | **−14.10%** | **+10.87%** |
| 2 | Dec–Jan 2025 | 10/50 | +0.80% | −2.88% | +3.68% |
| 3 | Jan–Feb 2025 | 10/50 | **+65.19%** | **+66.67%** | −1.48% |
| 4 | Feb–Apr 2025 | 40/200 | −2.19% | −1.08% | −1.11% |
| 5 | Apr–May 2025 | 20/50 | **+18.32%** | **−2.64%** | **+20.96%** |
| 6 | May–Jun 2025 | 20/50 | −8.21% | −8.24% | +0.03% |
| 7 | Jun–Jul 2025 | 20/50 | +7.76% | +3.49% | +4.27% |
| 8 | Jul–Aug 2025 | 40/200 | −5.92% | +1.25% | −7.17% |

**Encouraging:**
- Beat buy-and-hold in **6 of 9** windows
- Parameters reasonably stable — 4 distinct sets, and `10/50` + `20/50`
  account for 6 of 9, i.e. one family rather than a random walk
- The excess **survives removing the biggest window**. Drop window 3 and the
  strategy still returns **+10.82% while buy-and-hold loses −19.44%** — a
  30-point excess with the outlier gone. The headline is not one lucky month.
- The value comes from **downside protection**, the classic trend-following
  profile: window 1 (−3.23% vs −14.10%) and window 5 (+18.32% vs −2.64%).
  In the huge rally of window 3 it merely kept pace.

**Not proven:**

```
mean window return : +8.67%
95% CI (bootstrap) : [-2.25%, +24.68%]   <- includes zero
P(mean > 0)        : 89.7%               <- below the 95% bar
verdict            : NOT SIGNIFICANT
```

Nine windows, one instrument, 15 months. The test cannot distinguish this
from luck. That is *not* evidence it fails — it is evidence this experiment is
too small to rule. Honest verdict: **worth paper trading, not worth funding.**

### A bug this section caught

The first walk-forward run reported buy-and-hold making **exactly 0.00%** in
three separate windows, which is impossible. Cause: `walk_forward` built a
default `RiskManager()`, whose 5% daily-loss limit halted the *benchmark*,
flattened it to cash, and left it there — its equity froze at a constant
through a 14% decline.

So the benchmark was not buy-and-hold, it was "buy, panic once, sit in cash",
and every excess figure was inflated against a crippled comparison. Fixed by
adding `risk_factory`, defaulting to limits that never fire, applied
**identically to strategy and benchmark**. Evaluate the strategy first; add
risk limits deliberately, and always to both sides.

---

## Forex — the result did not replicate

`fetch_forex.py` + `run_forex.py`. 19 years of real EUR/USD daily OHLC (Alpha
Vantage) plus four ECB pairs. Forex costs ~1bp round trip against equities'
12bp, so this is also the cheapest venue tested.

```bash
python fetch_forex.py && python run_forex.py
```

### The honest headline

| | stock (H1) | **EUR/USD (daily)** |
|---|---|---|
| windows | 9 | **17** |
| history | 15 months | **19 years** |
| profitable windows | 5/9 | 8/17 |
| mean window return | +8.67% | **+0.02%** |
| 95% CI | [−2.25%, +24.68%] | **[−2.91%, +2.90%]** |
| P(mean > 0) | 89.7% | **51.0%** |
| distinct params | 4/9 (stable) | **11/17 (unstable)** |

**More evidence moved the answer to a coin flip.** The stock's 89.7% became
51.0% on a market with twice the windows and fifteen times the history. That
is exactly what you observe when the original result was noise — a real edge
gets *clearer* with more data, not fainter.

The parameter instability is the mechanism. On the stock the tuner kept
picking one family (`10/50`, `20/50`). On forex it changes its mind in 11 of
17 windows, so "learning from the last window" is chasing randomness.

### Five pairs, one fixed setting, no tuning

If an edge is real it should appear without being fitted per market:

| pair | trades | return | buy & hold |
|---|---|---|---|
| EUR/USD | 14 | −9.22% | −5.19% |
| EUR/GBP | 82 | +2.33% | +15.57% |
| EUR/JPY | 37 | −18.28% | −13.40% |
| EUR/AUD | 47 | −9.11% | +1.15% |
| EUR/CHF | 37 | −18.75% | −17.82% |

**Four of five lost money**, and the one winner still lost badly to buy-and-hold.

### Does adapting help? (`tradingbot/adaptive.py`)

`AdaptiveRegime` measures Kaufman's Efficiency Ratio each bar and switches
between trend-following and mean-reversion, on the premise that each works in
the regime the other fails in, so detecting the regime beats guessing.

(An earlier draft justified this by saying the timeframe study showed the two
to be mirror images. After the risk-manager fix that is no longer true —
mean reversion loses at every timeframe on that instrument — so the premise
here rests on the general argument, not on that result.)

| strategy | return | sharpe |
|---|---|---|
| MeanReversion | −19.03% | −0.35 |
| SmaCrossover 20/50 | −9.22% | −0.21 |
| **AdaptiveRegime** | **−8.52%** | **−0.14** |
| BuyAndHold | −5.19% | −0.09 |

The detector genuinely works — 264 mode switches, 21% trend / 79% revert,
mean ER 0.226 (EUR/USD chops far more than it trends). And it does beat both
fixed strategies. It still **loses money, and still loses to doing nothing.**

Beating a bad strategy is not an achievement. Adaptivity also *adds*
parameters (`er_window`, `er_threshold`, `neutral_band`), and every parameter
makes overfitting easier — so a complex strategy needs to clear a *higher*
bar than a simple one, not a lower one.

### Two kinds of "learning", kept separate

1. **Online adaptation** (`adaptive.py`) — re-measures the regime every bar,
   stores nothing, fits nothing, cannot overfit.
2. **Periodic re-tuning** (`walkforward.py`) — re-fits parameters each
   window. This is the ML-shaped one, and it carries the matching risk:
   when the tuner is fitting noise, learning makes things *worse*. Parameter
   instability is how you detect it, and forex shows it plainly.

---

## Kronos as a signal source

`tradingbot/kronos_signal.py` wraps [Kronos](https://github.com/shiyu-coder/Kronos)
(AAAI 2026), a generative foundation model for candlesticks, as a `Strategy`.

```bash
git clone https://github.com/shiyu-coder/Kronos && pip install -r Kronos/requirements.txt
python run_kronos.py --kronos-repo /path/to/Kronos            # needs HF checkpoints
python run_kronos.py --kronos-repo /path/to/Kronos --smoke    # wiring only
```

Kronos is *generative*: it samples plausible futures rather than emitting one
number. The design exploits that — draw N paths, and use their **agreement on
direction** to size the position. Unanimous → full size; split → flat. Note
`KronosPredictor.predict()` averages over `sample_count` internally and
discards the spread, so paths are drawn one at a time to keep it.

Three things this integration gets right, and one it can't:

- **No lookahead.** Future bar timestamps are *synthesised* by extrapolating
  the bar interval, never read from future dataframe rows. Reading them would
  work in backtest and be impossible live — the exact shape of a lookahead bug.
- **Throttled inference.** One forecast is ~3s; 20,000 bars × every-bar
  inference is hours. `predict_every` re-forecasts every k bars and holds
  between, which is also how you'd really deploy it.
- **No silent fallback.** `load_kronos()` raises if checkpoints are missing
  rather than degrading to random weights. An untrained Kronos emits
  well-formed candles and a tidy, meaningless equity curve.
### Measured results (real pretrained weights)

`NeoQuasar/Kronos-small`, 24,741,376 params, snapshot `901c26c1…` — the same
revision pinned in Kronos's own regression test.

**Step 1 — can it forecast?** 40 random windows, 256-bar context, 12-bar
horizon, identical windows across every config:

| config | draws | mean abs error | vs naive | direction |
|---|---|---|---|---|
| **naive** (assume no change) | — | **0.4663%** | — | — |
| Kronos T=0.7 | 8 | 0.5004% | **+7.3% worse** | 47.5% |
| Kronos T=1.0 | 8 | 0.5205% | +11.6% worse | 42.5% |
| Kronos T=1.0 | 1 | 0.6156% | +32.0% worse | 60.0% |

Averaging draws helps materially (0.62% → 0.50%), so use `sample_count > 1`
for point forecasts. But at its best the model is still **worse than assuming
price does not move**, and every direction accuracy falls inside the
coin-flip band (34.5%–65.5% at n=40).

**Scaling up does not fix it — and nearly fooled me.** `Kronos-base`
(102,310,592 params, 4x larger) on the same 40 windows first scored 0.4579%
MAE, i.e. **1.8% better than naive** — the only time anything beat the
baseline. Re-running it with identical settings and identical windows gave
**0.4899%, 5.1% worse**. Kronos samples stochastically, so no two runs agree,
and the run-to-run spread (0.032pp) is about **4x the apparent edge**
(0.008pp). A paired bootstrap over per-window differences:

```
mean difference (naive - Kronos) : -0.024%          negative = Kronos worse
95% CI                           : [-0.094%, +0.043%]   spans zero
windows won by Kronos            : 18 / 40
P(Kronos better)                 : 25.6%
verdict                          : NOT SIGNIFICANT
```

Two lessons, both bigger than the Kronos question. **A single run of a
stochastic model is not a measurement** — `sample_count=8` was not enough to
stabilise the estimate, and one run of this benchmark is not reproducible.
And a small unverified edge is the exact thing this repo exists to catch: had
the first number been reported as-is, "the bigger model beats the baseline"
would have been a completely false finding produced by nothing but sampling
noise. Always re-run, always pair, always check whether the confidence
interval crosses zero.

**Step 2 — can it trade?** 1,500 bars, forecast every 24 bars, 8 paths:

| | Kronos | BuyAndHold |
|---|---|---|
| total return | **−0.83%** | +35.72% |
| Sharpe | −1.14 | 5.34 |
| trades | 185 | 2 |
| fees paid | 0.21% of start | 0.04% |

The most informative line is not the return, it is this: **mean path
dispersion (0.75%) exceeded the mean predicted move (0.60%)**, and direction
agreement averaged 53.9%. The model's uncertainty about its own forecast is
larger than the forecast itself. It was, correctly, flat 82.7% of the time.
Costs were not the problem here (0.21%); there was simply no edge to collect.

**Read the comparison fairly in both directions.** That test window is one
month in which the instrument rose 35%, so buy-and-hold wins almost any
contest inside it — this is not evidence Kronos is worse than buy-and-hold in
general. (The 3916% CAGR the harness prints for buy-and-hold is annualisation
of a 0.08-year window; ignore it.) Equally, one instrument, one horizon and
40 windows is not evidence Kronos is useless: short-horizon equity prices are
close to a random walk, which makes naive a genuinely strong baseline, and
Kronos-small is the second-smallest checkpoint. The honest conclusion is
narrow — **no edge was demonstrated here**, so there is nothing to trade yet.

**Verified limitation of the conviction metric:** with random weights the model
predicted −4.0% on *every* forecast with *100%* path agreement — maximally
confident, completely wrong. Agreement measures internal consistency, not
correctness. It is a useful veto, never evidence of skill.

And the caveat that outranks all of the above: **forecast accuracy is not
alpha.** Kronos's published benchmarks measure candle reconstruction, not
trading profit. A model can be right about the level and useless about
direction, or right about direction and still lose to the spread. Nothing in
its training objective rewards profitable trading.

---

## Known rough edges (deliberate — good first exercises)

- The dust threshold in `Broker.rebalance_to_weight` (0.01% of equity) is
  too small; you can see tiny churn trades in the paper output paying fees
  for nothing. Raise it and measure the effect.
- `MeanReversion` re-enters aggressively. Add a cooldown.
- Single instrument only. Multi-asset needs a portfolio-level risk layer,
  not one `RiskManager` per symbol.
- No walk-forward analysis. A single train/test split is the *minimum*
  honest evaluation, not a good one.
- Sharpe here is excess-of-zero (no risk-free rate), fine for comparing
  strategies on the same data, not comparable to published figures.

---

## Data

`data/sample_5min.csv` — 20,000 five-minute bars of a liquid HK equity,
extracted from the MIT-licensed
[Kronos](https://github.com/shiyu-coder/Kronos) repo's finetuning data.
Real market data, used here only as a fixture.

To use your own, produce a CSV with
`timestamp, open, high, low, close, volume` and point `load_csv` at it.
Aliases like `timestamps`/`date`/`datetime` are detected automatically.

**This repository is educational software, not financial advice.**
