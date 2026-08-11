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
| return, **with** costs | 37.02% | **-3.72%** | 14.98% |
| return, **zero** costs | 37.18% | **35.71%** | 31.47% |
| trades | 3 | 274 | ~1,600 |
| fees as % of start | 0.09% | **7.36%** | **9.70%** |

SmaCrossover is a 35% winner for free and a **loser** at 4bp+2bp. Nothing
about the signal changed. Turnover is a cost multiplier, so a strategy's
viability depends on frictions you must model *before* you get attached to
it.

### 2. Lookahead bias — and what it really looks like

`LookaheadPeeker` computes next-bar return over the whole dataframe with
`.shift(-1)`, then reads it one bar at a time. Every individual call looks
innocent; the poison went in before the loop started.

| | BuyAndHold | LOOKAHEAD BUG |
|---|---|---|
| total return | 37.02% | **71,572,067,681%** |
| Sharpe | 1.27 | **35.78** |

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
