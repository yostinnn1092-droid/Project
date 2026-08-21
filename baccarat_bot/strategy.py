"""Streak-trigger strategy with a single martingale step.

Rules implemented (see README for the full statement):

1. Watch coups. Ties are *transparent*: they neither extend nor break a
   run, so P P T P is a run of three players.
2. When a side reaches ``streak_length`` (default 3) in a row, arm a bet.
3. Stake ``stake_pct`` of the bankroll (default 1%) on that side --
   ``follow`` bets with the streak, ``against`` bets the other side.
4. Win -> stand down and wait for the next qualifying run.
5. Tie -> the bet pushes; the stake is returned and re-placed at the same
   martingale stage (a push costs nothing, so it must not burn the step).
6. Loss -> double the stake once, same side, on the very next coup.
   Win or push resolves as above; a second loss stands down and waits for
   the next run.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import List, Optional

from .shoe import Outcome

#: Sides that can actually be wagered on by this strategy.
BETTABLE = (Outcome.PLAYER, Outcome.BANKER)


class Direction(str, Enum):
    """Which way to bet once a streak triggers."""

    FOLLOW = "follow"
    AGAINST = "against"


class Stage(str, Enum):
    """Where the strategy is in its bet sequence."""

    IDLE = "idle"
    BASE = "base"
    MARTINGALE = "martingale"


@dataclass
class StreakTracker:
    """Tracks consecutive player/banker results, ignoring ties."""

    side: Optional[Outcome] = None
    length: int = 0
    #: Incremented every time a *new* run starts, so a spent run can be
    #: distinguished from the fresh one that follows it.
    run_id: int = 0

    def observe(self, outcome: Outcome) -> None:
        if outcome is Outcome.TIE:
            return  # transparent: does not extend or break the run
        if outcome is self.side:
            self.length += 1
        else:
            self.side = outcome
            self.length = 1
            self.run_id += 1


@dataclass
class Decision:
    """A bet the strategy wants placed on the next coup."""

    side: Outcome
    stake: float
    stage: Stage
    streak_side: Outcome
    streak_length: int


@dataclass
class StrategyConfig:
    """Tunables for :class:`StreakMartingale`."""

    streak_length: int = 3
    stake_pct: float = 0.01
    direction: Direction = Direction.FOLLOW
    martingale_steps: int = 1
    martingale_multiplier: float = 2.0
    #: ``new_run`` requires a fresh run before re-arming (P P P P triggers
    #: once). ``every_n`` re-arms each time the run grows by
    #: ``streak_length`` again.
    retrigger: str = "new_run"
    #: ``current`` sizes the base stake off the live bankroll; ``session``
    #: sizes it off the balance the session started with (flat staking).
    stake_base: str = "current"

    def __post_init__(self) -> None:
        if self.streak_length < 1:
            raise ValueError("streak_length must be >= 1")
        if not 0 < self.stake_pct <= 1:
            raise ValueError("stake_pct must be in (0, 1]")
        if self.martingale_steps < 0:
            raise ValueError("martingale_steps must be >= 0")
        if self.martingale_multiplier <= 1:
            raise ValueError("martingale_multiplier must be > 1")
        if self.retrigger not in ("new_run", "every_n"):
            raise ValueError("retrigger must be 'new_run' or 'every_n'")
        if self.stake_base not in ("current", "session"):
            raise ValueError("stake_base must be 'current' or 'session'")


class StreakMartingale:
    """The strategy state machine.

    Drive it by alternating :meth:`decide` (what to bet on the next coup)
    and :meth:`observe` (what the coup actually produced).
    """

    def __init__(self, config: Optional[StrategyConfig] = None) -> None:
        self.config = config or StrategyConfig()
        self.tracker = StreakTracker()
        self.stage = Stage.IDLE
        self.pending: Optional[Decision] = None
        self._bet_side: Optional[Outcome] = None
        self._last_stake = 0.0
        self._losses_in_sequence = 0
        self._spent_run_id: Optional[int] = None
        self._triggered_at_length = 0
        self.history: List[Outcome] = []

    # -- inspection ---------------------------------------------------

    @property
    def in_sequence(self) -> bool:
        """True while a bet sequence is live (base or martingale)."""
        return self.stage is not Stage.IDLE

    def _armed(self) -> bool:
        """Has the current run qualified to open a sequence?"""
        cfg = self.config
        if self.tracker.side is None or self.tracker.length < cfg.streak_length:
            return False
        if cfg.retrigger == "every_n":
            return self.tracker.length % cfg.streak_length == 0
        return self.tracker.run_id != self._spent_run_id

    def _side_to_bet(self, streak_side: Outcome) -> Outcome:
        if self.config.direction is Direction.FOLLOW:
            return streak_side
        return Outcome.BANKER if streak_side is Outcome.PLAYER else Outcome.PLAYER

    # -- driving ------------------------------------------------------

    def decide(self, bankroll: float, session_start: float) -> Optional[Decision]:
        """Return the bet for the next coup, or ``None`` to sit it out."""
        cfg = self.config

        if self.stage is Stage.IDLE:
            if not self._armed():
                self.pending = None
                return None
            streak_side = self.tracker.side
            assert streak_side is not None  # guarded by _armed()
            base = session_start if cfg.stake_base == "session" else bankroll
            stake = base * cfg.stake_pct
            self.stage = Stage.BASE
            self._bet_side = self._side_to_bet(streak_side)
            self._losses_in_sequence = 0
            self._triggered_at_length = self.tracker.length
            # Mark this run as used so it cannot arm a second sequence.
            self._spent_run_id = self.tracker.run_id
        else:
            # Mid-sequence: stake was set when the loss was recorded.
            stake = self._last_stake
            streak_side = self.tracker.side or self._bet_side

        assert self._bet_side is not None
        self._last_stake = stake
        self.pending = Decision(
            side=self._bet_side,
            stake=stake,
            stage=self.stage,
            streak_side=streak_side or self._bet_side,
            streak_length=self._triggered_at_length,
        )
        return self.pending

    def observe(self, outcome: Outcome, bet_settled: bool = True) -> None:
        """Feed the coup result back in.

        Args:
            outcome: What the coup produced.
            bet_settled: False when a decision was returned but the bet was
                never actually placed (rejected, or blocked by risk limits);
                the sequence then stays at its current stage.
        """
        self.history.append(outcome)
        decision = self.pending
        self.pending = None

        if decision is not None and bet_settled:
            self._settle(decision, outcome)

        self.tracker.observe(outcome)

    def _settle(self, decision: Decision, outcome: Outcome) -> None:
        if outcome is Outcome.TIE:
            return  # push: stake returned, stage unchanged, bet is re-placed

        if outcome is decision.side:
            self._reset_sequence()
            return

        self._losses_in_sequence += 1
        if self._losses_in_sequence > self.config.martingale_steps:
            self._reset_sequence()
            return

        self.stage = Stage.MARTINGALE
        self._last_stake = decision.stake * self.config.martingale_multiplier

    def _reset_sequence(self) -> None:
        self.stage = Stage.IDLE
        self._bet_side = None
        self._last_stake = 0.0
        self._losses_in_sequence = 0
        self._triggered_at_length = 0
