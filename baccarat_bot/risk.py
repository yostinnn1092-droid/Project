"""Bankroll guards.

A single martingale step doubles exposure, so every stake is checked
against hard limits before it reaches a driver. The engine stops the
session the moment a limit trips.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Tuple


@dataclass
class RiskConfig:
    """Hard limits on a session."""

    #: Stop once cumulative loss reaches this fraction of the starting balance.
    stop_loss_pct: float = 0.20
    #: Stop once cumulative profit reaches this fraction. 0 disables.
    take_profit_pct: float = 0.0
    #: Stop after this many coups. 0 disables.
    max_rounds: int = 0
    #: Stop after this many placed bets. 0 disables.
    max_bets: int = 0
    #: Never stake more than this fraction of the current balance.
    max_stake_pct: float = 0.10
    #: Table minimum; stakes below it are rejected rather than rounded up.
    min_stake: float = 0.0
    #: Decimal places a stake is rounded down to.
    stake_precision: int = 8

    def __post_init__(self) -> None:
        for name in ("stop_loss_pct", "take_profit_pct", "max_stake_pct"):
            value = getattr(self, name)
            if not 0 <= value <= 1:
                raise ValueError(f"{name} must be between 0 and 1")
        if self.stake_precision < 0:
            raise ValueError("stake_precision must be >= 0")


class RiskManager:
    """Enforces :class:`RiskConfig` across a session."""

    def __init__(self, config: RiskConfig, starting_balance: float) -> None:
        self.config = config
        self.starting_balance = starting_balance
        self.rounds = 0
        self.bets = 0
        self.stop_reason: Optional[str] = None

    @property
    def stopped(self) -> bool:
        return self.stop_reason is not None

    def round_played(self, placed: bool) -> None:
        self.rounds += 1
        if placed:
            self.bets += 1

    def check_session(self, balance: float) -> Optional[str]:
        """Return a stop reason if the session must end, else ``None``."""
        cfg = self.config
        pnl = balance - self.starting_balance

        if cfg.stop_loss_pct and pnl <= -cfg.stop_loss_pct * self.starting_balance:
            self.stop_reason = (
                f"stop-loss hit ({pnl:+.8f}, "
                f"{cfg.stop_loss_pct:.1%} of starting balance)"
            )
        elif cfg.take_profit_pct and pnl >= cfg.take_profit_pct * self.starting_balance:
            self.stop_reason = (
                f"take-profit hit ({pnl:+.8f}, "
                f"{cfg.take_profit_pct:.1%} of starting balance)"
            )
        elif cfg.max_rounds and self.rounds >= cfg.max_rounds:
            self.stop_reason = f"round limit reached ({cfg.max_rounds})"
        elif cfg.max_bets and self.bets >= cfg.max_bets:
            self.stop_reason = f"bet limit reached ({cfg.max_bets})"
        return self.stop_reason

    def vet_stake(self, stake: float, balance: float) -> Tuple[float, Optional[str]]:
        """Clamp and validate a stake.

        Returns the usable stake and a rejection reason. A reason means
        the bet must not be placed.
        """
        cfg = self.config
        factor = 10 ** cfg.stake_precision
        stake = int(stake * factor) / factor  # round down, never up

        if stake <= 0:
            return 0.0, "stake rounds to zero"
        if cfg.min_stake and stake < cfg.min_stake:
            return stake, f"stake {stake:.8f} below table minimum {cfg.min_stake:.8f}"
        if stake > balance:
            return stake, f"stake {stake:.8f} exceeds balance {balance:.8f}"
        if cfg.max_stake_pct and stake > cfg.max_stake_pct * balance:
            return stake, (
                f"stake {stake:.8f} exceeds max {cfg.max_stake_pct:.1%} "
                f"of balance ({cfg.max_stake_pct * balance:.8f})"
            )
        return stake, None
