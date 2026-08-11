"""
Risk layer.

This is the part that decides whether you are still solvent in a year, and
it matters more than the strategy. A mediocre edge with disciplined risk
compounds; a brilliant edge with no risk control eventually meets the one
trade that ends the account.

The risk manager sits between strategy and execution. The strategy says
what it *wants*; the risk manager decides what it is *allowed* to have.
It can only ever reduce exposure, never increase it — so a bug in a
strategy cannot talk the bot into a bigger position than you sanctioned.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class RiskLimits:
    """Hard ceilings applied to every target weight.

    max_position:   cap on |weight|. 1.0 = never use leverage.
    max_drawdown:   kill switch. Once equity falls this far below its
                    high-water mark the bot flattens and refuses to trade.
                    A bot that cannot stop is not a bot, it is a leak.
    daily_loss_limit: same idea on a per-day basis; trading resumes the
                    next session. Catches "today is going badly" before it
                    becomes "this year is going badly".
    """

    max_position: float = 1.0
    max_drawdown: float = 0.20
    daily_loss_limit: float | None = 0.05


class RiskManager:
    def __init__(self, limits: RiskLimits | None = None):
        self.limits = limits or RiskLimits()
        self.peak_equity: float | None = None
        self.halted = False
        self.halt_reason: str | None = None
        self._day = None
        self._day_start_equity: float | None = None

    def update(self, equity: float, timestamp) -> None:
        """Feed current equity in. Call once per bar, before `adjust`."""
        if self.peak_equity is None:
            self.peak_equity = equity
        self.peak_equity = max(self.peak_equity, equity)

        day = getattr(timestamp, "date", lambda: None)()
        if day != self._day:
            self._day = day
            self._day_start_equity = equity

        if self.halted:
            return

        dd = (self.peak_equity - equity) / self.peak_equity if self.peak_equity else 0.0
        if dd >= self.limits.max_drawdown:
            self.halted = True
            self.halt_reason = f"max drawdown {dd:.1%} >= {self.limits.max_drawdown:.1%}"
            return

        if self.limits.daily_loss_limit is not None and self._day_start_equity:
            day_loss = (self._day_start_equity - equity) / self._day_start_equity
            if day_loss >= self.limits.daily_loss_limit:
                self.halted = True
                self.halt_reason = (
                    f"daily loss {day_loss:.1%} >= {self.limits.daily_loss_limit:.1%}"
                )

    def adjust(self, target_weight: float) -> float:
        """Clamp a strategy's requested weight to what policy allows."""
        if self.halted:
            return 0.0  # flatten and stay flat
        cap = self.limits.max_position
        return max(-cap, min(cap, target_weight))


def position_size_from_stop(
    equity: float,
    entry_price: float,
    stop_price: float,
    risk_per_trade: float = 0.01,
) -> float:
    """Units to buy so that being stopped out costs `risk_per_trade` of equity.

    This is the sizing rule most retail bots are missing. You do not decide
    size from conviction, you decide it from the distance to your stop:

        units = (equity * risk_fraction) / |entry - stop|

    A wide stop therefore forces a small position and a tight stop permits
    a larger one, so every trade risks the same fraction of the account
    regardless of how volatile the instrument happens to be that week.
    """
    per_unit_risk = abs(entry_price - stop_price)
    if per_unit_risk <= 0:
        raise ValueError("stop must differ from entry")
    return (equity * risk_per_trade) / per_unit_risk
