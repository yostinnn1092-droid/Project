"""Betting systems, and a harness that measures what they actually return.

Every system here is a rule for choosing the *next stake* from the
history of wins and losses. None of them touch the odds of the next
roll, because nothing can: each roll is independent and pays 99/chance
against a chance/100 probability.

The harness deliberately runs with an unlimited bankroll. That removes
bankruptcy from the picture entirely, so what is left is the pure
expected value of the staking rule -- and it lands on -1% of turnover
for all of them. A system cannot be rescued by a bigger bankroll,
because the bankroll was never the reason it loses.
"""

from __future__ import annotations

import random
from dataclasses import dataclass
from typing import Callable, List, Optional

from .dice import multiplier_for


class BettingSystem:
    """Base class: decide the next stake, then react to the outcome."""

    name = "system"

    def __init__(self, unit: float = 1.0) -> None:
        self.unit = unit

    def next_bet(self) -> float:
        raise NotImplementedError

    def settle(self, won: bool) -> None:
        raise NotImplementedError


class Flat(BettingSystem):
    """Always stake one unit."""

    name = "Flat"

    def next_bet(self) -> float:
        return self.unit

    def settle(self, won: bool) -> None:
        return None


class Martingale(BettingSystem):
    """Double after every loss, reset on a win."""

    name = "Martingale"

    def __init__(self, unit: float = 1.0) -> None:
        super().__init__(unit)
        self.bet = unit

    def next_bet(self) -> float:
        return self.bet

    def settle(self, won: bool) -> None:
        self.bet = self.unit if won else self.bet * 2


class GrandMartingale(BettingSystem):
    """Double and add a unit after a loss."""

    name = "Grand Martingale"

    def __init__(self, unit: float = 1.0) -> None:
        super().__init__(unit)
        self.bet = unit

    def next_bet(self) -> float:
        return self.bet

    def settle(self, won: bool) -> None:
        self.bet = self.unit if won else self.bet * 2 + self.unit


class Paroli(BettingSystem):
    """Double after a win, reset after three wins or any loss."""

    name = "Paroli (anti-martingale)"

    def __init__(self, unit: float = 1.0) -> None:
        super().__init__(unit)
        self.bet = unit
        self.streak = 0

    def next_bet(self) -> float:
        return self.bet

    def settle(self, won: bool) -> None:
        if not won:
            self.bet, self.streak = self.unit, 0
            return
        self.streak += 1
        if self.streak >= 3:
            self.bet, self.streak = self.unit, 0
        else:
            self.bet *= 2


class DAlembert(BettingSystem):
    """Up one unit after a loss, down one after a win."""

    name = "D'Alembert"

    def __init__(self, unit: float = 1.0) -> None:
        super().__init__(unit)
        self.steps = 0

    def next_bet(self) -> float:
        return self.unit * (1 + self.steps)

    def settle(self, won: bool) -> None:
        self.steps = max(0, self.steps - 1) if won else self.steps + 1


class Fibonacci(BettingSystem):
    """Walk up the Fibonacci sequence on a loss, back two on a win."""

    name = "Fibonacci"

    def __init__(self, unit: float = 1.0) -> None:
        super().__init__(unit)
        self.seq = [1, 1]
        self.index = 0

    def next_bet(self) -> float:
        while self.index >= len(self.seq):
            self.seq.append(self.seq[-1] + self.seq[-2])
        return self.unit * self.seq[self.index]

    def settle(self, won: bool) -> None:
        self.index = max(0, self.index - 2) if won else self.index + 1


class Labouchere(BettingSystem):
    """Cancellation: stake the ends of a list, cross off on a win."""

    name = "Labouchere"

    def __init__(self, unit: float = 1.0) -> None:
        super().__init__(unit)
        self.base: List[int] = [1, 2, 3, 4]
        self.line = list(self.base)

    def next_bet(self) -> float:
        if not self.line:
            self.line = list(self.base)
        if len(self.line) == 1:
            return self.unit * self.line[0]
        return self.unit * (self.line[0] + self.line[-1])

    def settle(self, won: bool) -> None:
        if not self.line:
            self.line = list(self.base)
            return
        if won:
            if len(self.line) <= 2:
                self.line = list(self.base)
            else:
                self.line = self.line[1:-1]
        else:
            staked = (
                self.line[0] + self.line[-1] if len(self.line) > 1 else self.line[0]
            )
            self.line.append(staked)


class OscarsGrind(BettingSystem):
    """Raise a unit after a win while the cycle is still down."""

    name = "Oscar's Grind"

    def __init__(self, unit: float = 1.0) -> None:
        super().__init__(unit)
        self.bet = unit
        self.cycle = 0.0

    def next_bet(self) -> float:
        return self.bet

    def settle(self, won: bool) -> None:
        self.cycle += self.bet if won else -self.bet
        if self.cycle >= self.unit:
            self.bet, self.cycle = self.unit, 0.0
        elif won:
            self.bet += self.unit


@dataclass
class SystemResult:
    """What a system returned over a long run."""

    name: str
    bets: int
    turnover: float
    net: float
    peak_bet: float

    @property
    def per_dollar(self) -> float:
        return 1 + self.net / self.turnover if self.turnover else 0.0


def measure(
    factory: Callable[[], BettingSystem],
    rolls: int = 500_000,
    win_chance: float = 49.5,
    rng: Optional[random.Random] = None,
) -> SystemResult:
    """Run a system with an unlimited bankroll and report its return.

    No bankroll cap and no table maximum: the system is given every
    advantage a real one never gets, so the only thing being measured is
    the staking rule itself.
    """
    rng = rng or random.Random()
    system = factory()
    payout = multiplier_for(win_chance)
    turnover = net = peak = 0.0

    for _ in range(rolls):
        bet = system.next_bet()
        won = rng.random() * 100.0 < win_chance
        turnover += bet
        net += bet * (payout - 1) if won else -bet
        peak = max(peak, bet)
        system.settle(won)

    return SystemResult(system.name, rolls, turnover, net, peak)


#: Every system in this module, for the CLI and the tests.
ALL_SYSTEMS: List[Callable[[], BettingSystem]] = [
    Flat,
    Martingale,
    GrandMartingale,
    Paroli,
    DAlembert,
    Fibonacci,
    Labouchere,
    OscarsGrind,
]


@dataclass
class ConstrainedResult:
    """A system run against a real bankroll and a real table maximum."""

    name: str
    bets: int
    turnover: float
    ending_balance: float
    starting_balance: float
    ruined: bool

    @property
    def profit(self) -> float:
        return self.ending_balance - self.starting_balance


def measure_constrained(
    factory: Callable[[], BettingSystem],
    balance: float = 1000.0,
    unit: float = 1.0,
    rolls: int = 100_000,
    win_chance: float = 49.5,
    table_max: float = 10_000.0,
    rng: Optional[random.Random] = None,
) -> ConstrainedResult:
    """Run a system until the rolls run out or it cannot fund its next bet.

    This is the same measurement as :func:`measure` with the two limits
    every real player has: money runs out, and the table refuses bets
    above its maximum. Escalating systems depend on neither limit
    existing, which is why they look profitable until they meet one.
    """
    rng = rng or random.Random()
    system = factory()
    system.unit = unit
    payout = multiplier_for(win_chance)
    start = balance
    turnover = 0.0
    ruined = False
    placed = 0

    for _ in range(rolls):
        bet = min(system.next_bet(), table_max)
        if bet > balance:
            ruined = True
            break
        won = rng.random() * 100.0 < win_chance
        balance += bet * (payout - 1) if won else -bet
        turnover += bet
        placed += 1
        system.settle(won)

    return ConstrainedResult(
        system.name, placed, turnover, balance, start, ruined
    )
