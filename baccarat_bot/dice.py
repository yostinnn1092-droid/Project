"""Stake Dice model and the condition engine behind Stake's autobet panel.

Dice is a different game from baccarat: you pick a *win chance* and the
payout multiplier follows from it, so a strategy can move both the stake
and the odds between rolls. Stake's autobet screen expresses that as a
list of conditions, which is what this module reproduces.

Payout follows Stake's 1% house edge: multiplier = 99 / win_chance.
Expected value is therefore -1% of every amount staked, at any win
chance -- the odds dial changes variance, never the edge.
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field
from typing import List, Optional

#: Stake's dice limits.
MIN_WIN_CHANCE = 0.01
MAX_WIN_CHANCE = 98.0
#: 99 / chance implies a 1% house edge.
EDGE_NUMERATOR = 99.0


def multiplier_for(win_chance: float) -> float:
    """Payout multiplier for a given win chance, in percent."""
    if not MIN_WIN_CHANCE <= win_chance <= MAX_WIN_CHANCE:
        raise ValueError(f"win chance {win_chance} outside Stake's limits")
    return EDGE_NUMERATOR / win_chance


@dataclass
class ParoliConfig:
    """The strategy from the autobet screen.

    Defaults mirror the five conditions in the screenshots:

    1. streak of MORE than 3 losses  -> raise bet by 50%
    2. FIRST streak of 1 loss        -> set win chance to 20%
    3. EVERY streak of 2 losses      -> raise win chance by 1%
    4. every 1 win                   -> reset bet to base
    5. every 1 win                   -> reset win chance to base
    """

    #: Win chance the panel starts on. Not visible in the screenshots --
    #: 49.5 is Stake's default (a 2x payout).
    base_win_chance: float = 49.5
    #: Base bet as a fraction of the starting bankroll.
    base_bet_pct: float = 0.001

    loss_streak_for_raise: int = 3       # condition 1: "more than 3"
    bet_raise_pct: float = 0.50          # condition 1: +50%
    first_loss_win_chance: float = 20.0  # condition 2
    chance_step_every: int = 2           # condition 3: every 2 losses
    chance_step_pct: float = 1.0         # condition 3: +1%

    def __post_init__(self) -> None:
        if not MIN_WIN_CHANCE <= self.base_win_chance <= MAX_WIN_CHANCE:
            raise ValueError("base_win_chance outside Stake's limits")
        if not 0 < self.base_bet_pct <= 1:
            raise ValueError("base_bet_pct must be in (0, 1]")
        if self.chance_step_every < 1:
            raise ValueError("chance_step_every must be >= 1")


class ParoliStrategy:
    """Tracks bet size and win chance across a losing run."""

    def __init__(self, config: ParoliConfig, base_bet: float) -> None:
        self.config = config
        self.base_bet = base_bet
        self.bet = base_bet
        self.win_chance = config.base_win_chance
        self.loss_streak = 0

    def register(self, won: bool) -> None:
        """Apply the conditions after a settled roll."""
        cfg = self.config

        if won:
            self.loss_streak = 0
            self.bet = self.base_bet                 # condition 4
            self.win_chance = cfg.base_win_chance    # condition 5
            return

        self.loss_streak += 1

        # Condition 2 -- fires when the run first reaches one loss.
        if self.loss_streak == 1:
            self.win_chance = cfg.first_loss_win_chance

        # Condition 3 -- every second loss in the run.
        if self.loss_streak % cfg.chance_step_every == 0:
            self.win_chance = min(
                MAX_WIN_CHANCE, self.win_chance + cfg.chance_step_pct
            )

        # Condition 1 -- once the run is longer than three losses.
        if self.loss_streak > cfg.loss_streak_for_raise:
            self.bet *= 1 + cfg.bet_raise_pct


@dataclass
class DiceReport:
    """Result of one simulated autobet session."""

    starting_balance: float
    ending_balance: float
    rolls: int
    turnover: float
    peak_bet: float
    max_loss_streak: float
    busted: bool
    stopped: str
    curve: List[float] = field(default_factory=list)

    @property
    def profit(self) -> float:
        return self.ending_balance - self.starting_balance

    @property
    def roi(self) -> float:
        return self.profit / self.starting_balance if self.starting_balance else 0.0


def run_session(
    config: ParoliConfig,
    balance: float = 1000.0,
    max_rolls: int = 1000,
    min_bet: float = 0.0,
    stop_loss_pct: float = 1.0,
    rng: Optional[random.Random] = None,
    keep_curve: bool = False,
) -> DiceReport:
    """Play one autobet session to completion."""
    rng = rng or random.Random()
    start = balance
    base_bet = balance * config.base_bet_pct
    strategy = ParoliStrategy(config, base_bet)

    turnover = 0.0
    peak_bet = 0.0
    max_streak = 0
    rolls = 0
    stopped = "roll limit"
    curve: List[float] = [balance] if keep_curve else []
    floor = start * (1 - stop_loss_pct)

    while rolls < max_rolls:
        bet = strategy.bet
        if bet > balance or (min_bet and bet < min_bet):
            stopped = "bankrupt" if bet > balance else "below table minimum"
            break

        chance = strategy.win_chance
        # Stake rolls 0.00-99.99 and pays when the roll lands under the
        # chosen win chance.
        won = rng.random() * 100.0 < chance

        balance -= bet
        turnover += bet
        if won:
            balance += bet * multiplier_for(chance)

        peak_bet = max(peak_bet, bet)
        strategy.register(won)
        max_streak = max(max_streak, strategy.loss_streak)
        rolls += 1
        if keep_curve:
            curve.append(balance)

        if balance <= floor:
            stopped = "stop-loss"
            break

    return DiceReport(
        starting_balance=start,
        ending_balance=balance,
        rolls=rolls,
        turnover=turnover,
        peak_bet=peak_bet,
        max_loss_streak=max_streak,
        busted=balance <= floor or stopped in ("bankrupt", "below table minimum"),
        stopped=stopped,
        curve=curve,
    )
