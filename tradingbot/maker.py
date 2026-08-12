"""
Maker-order execution.

The scalping study found a real edge — +3.14bp gross per round trip — that
lost to a 12bp taker cost. This module attacks the cost rather than the
signal, because the cost is the part that was actually broken.

TAKER vs MAKER
--------------
A **market order** crosses the spread and pays a taker fee. You are certain
to trade and certain to pay.

A **limit order** rests on the book and waits. If someone trades against it,
you fill at your price and pay a maker fee — which on many venues is zero or
*negative* (a rebate for supplying liquidity). Round-trip cost can go from
+12bp to roughly 0 or below.

This is not a trick, and it fits this strategy in particular: a mean-reversion
scalper wants to buy when price is falling and sell when it is rising, which
is exactly what a resting limit order does. The strategy is market making
with extra steps.

THE CATCH, WHICH DECIDES EVERYTHING
-----------------------------------
Limit orders do not always fill, and *when* they fill is not random:

1. **Adverse selection.** Your buy fills because someone insisted on selling
   to you — often because price is about to keep falling. You are handed the
   trades you least want and denied the ones you want most.
2. **Missed winners.** When price jumps your way immediately, your order sits
   unfilled. You keep the losers and miss the winners; that asymmetry is the
   real price of the rebate.
3. **Queue position.** Price touching your limit does not mean you traded —
   you are behind everyone who was there first.

`require_through=True` (the default) handles (3) pessimistically: it demands
price trade strictly *through* the limit, not merely touch it. This module
measures (1) and (2) explicitly instead of assuming them away, because a
maker backtest that fills on touch and ignores adverse selection is a machine
for producing imaginary profits.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .strategy import Strategy


@dataclass
class MakerCosts:
    """Fees per side, as fractions. Negative maker_fee = rebate.

    Defaults are roughly a mid-tier crypto venue: -1bp maker rebate, 4bp
    taker. Check your own venue and tier before believing any of this — the
    entire result turns on these two numbers.
    """

    maker_fee: float = -0.0001   # -1bp: paid TO you
    taker_fee: float = 0.0004    # +4bp
    offset_bps: float = 5.0      # how far from mid the limit rests
    require_through: bool = True  # price must trade through, not just touch
    chase_after: int | None = None  # bars unfilled before crossing (None = never)


@dataclass
class MakerResult:
    equity: pd.Series
    fills: pd.DataFrame
    stats: dict = field(default_factory=dict)
    diagnostics: dict = field(default_factory=dict)


def run_maker(
    bars: pd.DataFrame,
    strategy: Strategy,
    costs: MakerCosts | None = None,
    initial_equity: float = 10_000.0,
) -> MakerResult:
    """Backtest with resting limit orders instead of market orders.

    Each bar the strategy names a target weight. If that differs from what is
    actually held, a limit order is placed `offset_bps` away from the close on
    the passive side, and the NEXT bar decides whether it filled:

        buy  fills if next low  <  limit   (<= if require_through is False)
        sell fills if next high >  limit

    Unfilled orders are cancelled and re-decided next bar, so the strategy is
    always reacting to current information rather than sitting on a stale
    order. `sync_position` is called every bar so a stateful strategy cannot
    drift away from what it really holds.
    """
    costs = costs or MakerCosts()
    n = len(bars)
    warmup = max(strategy.warmup, 1)
    if n <= warmup + 2:
        raise ValueError(f"need more than {warmup + 2} bars, got {n}")

    ts = bars["timestamp"].to_numpy()
    high = bars["high"].to_numpy(dtype=float)
    low = bars["low"].to_numpy(dtype=float)
    close = bars["close"].to_numpy(dtype=float)

    cash = initial_equity
    units = 0.0
    equity_curve = np.full(n, np.nan)
    fills: list[dict] = []
    attempted = 0
    filled = 0
    pending_bars = 0

    off = costs.offset_bps / 10_000.0

    for i in range(warmup, n - 1):
        equity = cash + units * close[i]
        equity_curve[i] = equity

        current_weight = (units * close[i]) / equity if equity > 0 else 0.0
        strategy.sync_position(current_weight)

        target = float(strategy.on_bar(bars.iloc[: i + 1]))
        desired_units = (target * equity) / close[i]
        delta = desired_units - units

        if abs(delta * close[i]) < equity * 1e-4:
            pending_bars = 0
            continue

        attempted += 1
        buying = delta > 0

        # Rest passively: bid below for a buy, offer above for a sell.
        limit = close[i] * (1 - off) if buying else close[i] * (1 + off)

        if buying:
            hit = low[i + 1] < limit if costs.require_through else low[i + 1] <= limit
        else:
            hit = high[i + 1] > limit if costs.require_through else high[i + 1] >= limit

        chase = (
            costs.chase_after is not None
            and pending_bars >= costs.chase_after
        )

        if hit:
            fill_px, fee_rate, kind = limit, costs.maker_fee, "maker"
        elif chase:
            # Give up and cross the spread; pay taker and take the worse price.
            fill_px = close[i + 1] * (1 + off if buying else 1 - off)
            fee_rate, kind = costs.taker_fee, "taker"
        else:
            pending_bars += 1
            continue

        pending_bars = 0
        filled += 1
        notional = abs(delta * fill_px)
        fee = notional * fee_rate  # negative fee = rebate credited

        cash -= delta * fill_px + fee
        units = desired_units

        # Adverse selection probe: where did price go right after we filled?
        # For a buy, a falling price means we were picked off.
        fwd = 3
        j = min(i + 1 + fwd, n - 1)
        move = (close[j] / fill_px - 1.0) * (1.0 if buying else -1.0)

        fills.append({
            "timestamp": pd.Timestamp(ts[i + 1]),
            "side": "buy" if buying else "sell",
            "kind": kind,
            "units": abs(delta),
            "price": fill_px,
            "notional": notional,
            "fee": fee,
            "fwd_move": move,
        })

    equity_curve[n - 1] = cash + units * close[n - 1]
    equity_curve[:warmup] = initial_equity
    eq = pd.Series(equity_curve, index=bars["timestamp"], name="equity").ffill()
    fdf = pd.DataFrame(fills)

    rets = eq.pct_change().dropna()
    span_days = (eq.index[-1] - eq.index[0]).total_seconds() / 86_400.0
    ann = len(eq) / (span_days / 365.25) if span_days > 0 else 252.0
    sharpe = (rets.mean() / rets.std() * np.sqrt(ann)) if rets.std() > 0 else 0.0
    dd = ((eq - eq.cummax()) / eq.cummax()).min()

    fees_total = float(fdf["fee"].sum()) if not fdf.empty else 0.0
    maker_share = float((fdf["kind"] == "maker").mean()) if not fdf.empty else 0.0
    adverse = float(fdf["fwd_move"].mean()) if not fdf.empty else 0.0

    return MakerResult(
        equity=eq,
        fills=fdf,
        stats={
            "total_return": f"{eq.iloc[-1] / initial_equity - 1:>10.2%}",
            "sharpe": f"{sharpe:>10.2f}",
            "max_drawdown": f"{dd:>10.2%}",
            "n_fills": f"{len(fdf):>10d}",
            "fees_paid": f"{fees_total:>10.2f}",
            "final_equity": f"{eq.iloc[-1]:>10.2f}",
        },
        diagnostics={
            "orders_attempted": attempted,
            "orders_filled": filled,
            "fill_rate": filled / attempted if attempted else 0.0,
            "maker_share": maker_share,
            "fees_total": fees_total,
            "mean_fwd_move_after_fill": adverse,
        },
    )
