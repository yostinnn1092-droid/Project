"""
Backtest engine.

Event-driven, one bar at a time. Slower than vectorised pandas, and worth
it: the loop makes the timing explicit, and explicit timing is what keeps
lookahead bias out.

THE EXECUTION MODEL — the most important 4 lines in this repo:

    bar i closes            -> strategy sees history[:i+1] and picks a weight
    risk manager clamps it
    order is placed
    bar i+1 OPENS           -> the order fills there, plus slippage

You decide on information that exists at the close of bar i, and you pay
the open of bar i+1. You can never fill at a price from the same bar you
made the decision on, because in live trading that price has already gone.

Filling at the close of bar i instead is the classic beginner bug. It
looks like a one-bar detail and it silently hands your strategy a free
peek at the future; on 5-minute bars it can turn a losing system into a
spectacular fake winner.

Costs are charged on every trade, because a strategy that is profitable
before costs and unprofitable after is simply unprofitable.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .risk import RiskManager
from .strategy import Strategy


@dataclass
class Costs:
    """Trading frictions. Guessing these too low is self-deception.

    commission: per-side, as a fraction of notional. 0.0004 = 4 bps, in the
                region of a retail crypto taker fee. Stock/forex differ.
    slippage:   fraction of price you lose crossing the spread and moving
                the book. 0.0002 = 2 bps. For illiquid instruments or size,
                this is optimistic by an order of magnitude.
    """

    commission: float = 0.0004
    slippage: float = 0.0002


@dataclass
class BacktestResult:
    equity: pd.Series
    positions: pd.Series
    trades: pd.DataFrame
    stats: dict = field(default_factory=dict)
    halt_reason: str | None = None

    def __str__(self) -> str:  # pragma: no cover - cosmetic
        rows = "\n".join(f"  {k:<22} {v}" for k, v in self.stats.items())
        tail = f"\n  HALTED: {self.halt_reason}" if self.halt_reason else ""
        return rows + tail


def _bars_per_year(index: pd.DatetimeIndex) -> float:
    """Infer annualisation factor from the timestamps themselves.

    A hardcoded table ("5min -> 105120 bars/year") assumes the market never
    closes. That is true for crypto and false for equities, futures and FX,
    which trade a few hours a day, five days a week. Using the 24/7 number
    on a stock inflates the annualisation by ~6x and hands you a CAGR of
    400% on a 37% gain.

    Measuring the real elapsed calendar time instead makes the factor
    correct for any instrument and any session schedule, with no config.
    """
    if len(index) < 2:
        return 252.0
    span_days = (index[-1] - index[0]).total_seconds() / 86_400.0
    if span_days <= 0:
        return 252.0
    return len(index) / (span_days / 365.25)


def run(
    bars: pd.DataFrame,
    strategy: Strategy,
    costs: Costs | None = None,
    risk: RiskManager | None = None,
    initial_equity: float = 10_000.0,
    bar_freq: str = "5min",
    execution: str = "next_open",
) -> BacktestResult:
    """Run `strategy` over `bars` and return equity curve, trades and stats.

    execution:
      "next_open"  — CORRECT. Decide at close of bar i, fill at open of i+1.
      "same_close" — DELIBERATELY WRONG. Fills at the close of the very bar
                     the decision was made on, i.e. at a price the strategy
                     already saw. Provided only so `run_backtest.py` can
                     show you what lookahead bias does to the numbers.
                     Never use it to evaluate anything.
    """
    if execution not in ("next_open", "same_close"):
        raise ValueError(f"unknown execution model: {execution}")
    costs = costs or Costs()
    risk = risk or RiskManager()

    n = len(bars)
    warmup = max(strategy.warmup, 1)
    if n <= warmup + 2:
        raise ValueError(f"need more than {warmup + 2} bars, got {n}")

    ts = bars["timestamp"].to_numpy()
    open_ = bars["open"].to_numpy(dtype=float)
    close = bars["close"].to_numpy(dtype=float)

    cash = initial_equity
    units = 0.0

    equity_curve = np.full(n, np.nan)
    weight_curve = np.zeros(n)
    trades: list[dict] = []

    # Stop at n-1: the last bar has no "next open" to fill against, so a
    # decision made there could never be executed. Pretending otherwise
    # would be one more free look at the future.
    for i in range(warmup, n - 1):
        equity = cash + units * close[i]
        equity_curve[i] = equity
        risk.update(equity, pd.Timestamp(ts[i]))

        # --- decide on information available at the close of bar i ---
        target = strategy.on_bar(bars.iloc[: i + 1])
        target = risk.adjust(float(target))
        weight_curve[i] = target

        desired_units = (target * equity) / close[i]
        delta = desired_units - units

        # Skip dust trades: rebalancing for a rounding error just donates
        # commission to the broker.
        if abs(delta * close[i]) < equity * 1e-4:
            continue

        # --- execute at the OPEN of bar i+1, never bar i ---
        # (the "same_close" branch is the bug, kept visible on purpose)
        ref = open_[i + 1] if execution == "next_open" else close[i]
        direction = np.sign(delta)
        fill = ref * (1 + costs.slippage * direction)  # always fills against you
        notional = abs(delta * fill)
        fee = notional * costs.commission

        cash -= delta * fill + fee
        units = desired_units

        trades.append(
            {
                "timestamp": pd.Timestamp(ts[i + 1]),
                "side": "buy" if direction > 0 else "sell",
                "units": abs(delta),
                "price": fill,
                "notional": notional,
                "fee": fee,
                "target_weight": target,
            }
        )

    # Mark the final bar to market so the curve ends on a real number.
    equity_curve[n - 1] = cash + units * close[n - 1]
    equity_curve[: warmup] = initial_equity

    eq = pd.Series(equity_curve, index=bars["timestamp"], name="equity").ffill()
    pos = pd.Series(weight_curve, index=bars["timestamp"], name="weight")
    tr = pd.DataFrame(trades)

    return BacktestResult(
        equity=eq,
        positions=pos,
        trades=tr,
        stats=compute_stats(eq, tr, bar_freq, initial_equity),
        halt_reason=risk.halt_reason,
    )


def compute_stats(
    equity: pd.Series,
    trades: pd.DataFrame,
    bar_freq: str,
    initial_equity: float,
) -> dict:
    """Summarise a run. Read max drawdown before you read return."""
    rets = equity.pct_change().dropna()
    total_return = equity.iloc[-1] / initial_equity - 1

    ann = _bars_per_year(pd.DatetimeIndex(equity.index))
    # Sharpe here is excess-of-zero (no risk-free rate); fine for comparing
    # strategies on the same data, not comparable to published figures.
    if len(rets) > 1 and rets.std() > 0:
        sharpe = (rets.mean() / rets.std()) * np.sqrt(ann)
    else:
        sharpe = 0.0

    running_max = equity.cummax()
    drawdown = (equity - running_max) / running_max
    max_dd = drawdown.min()

    n_bars = len(equity)
    years = n_bars / ann if ann else 0
    cagr = (equity.iloc[-1] / initial_equity) ** (1 / years) - 1 if years > 0.05 else np.nan

    fees = float(trades["fee"].sum()) if not trades.empty else 0.0

    return {
        "span_years": f"{years:>10.2f}",
        "total_return": f"{total_return:>10.2%}",
        "CAGR": f"{cagr:>10.2%}" if not np.isnan(cagr) else "         n/a",
        "sharpe": f"{sharpe:>10.2f}",
        "max_drawdown": f"{max_dd:>10.2%}",
        "volatility_ann": f"{rets.std() * np.sqrt(ann):>10.2%}",
        "n_trades": f"{len(trades):>10d}",
        "fees_paid": f"{fees:>10.2f}",
        "fees_pct_of_start": f"{fees / initial_equity:>10.2%}",
        "final_equity": f"{equity.iloc[-1]:>10.2f}",
    }
