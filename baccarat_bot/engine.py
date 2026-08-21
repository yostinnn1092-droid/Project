"""Session engine: wires strategy, risk guards and a driver together."""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import List, Optional

from .drivers.base import BaccaratDriver, DriverError, RoundResult
from .risk import RiskManager
from .shoe import Outcome
from .strategy import Decision, Stage, StreakMartingale

log = logging.getLogger(__name__)


@dataclass
class RoundRecord:
    """One coup as the engine saw it."""

    index: int
    outcome: Outcome
    decision: Optional[Decision]
    profit: float
    balance: float
    rejected: Optional[str] = None


@dataclass
class SessionReport:
    """Outcome of a completed session."""

    starting_balance: float
    ending_balance: float
    rounds: int
    bets: int
    wins: int
    losses: int
    pushes: int
    stop_reason: str
    records: List[RoundRecord] = field(default_factory=list)

    @property
    def profit(self) -> float:
        return self.ending_balance - self.starting_balance

    @property
    def roi(self) -> float:
        if self.starting_balance <= 0:
            return 0.0
        return self.profit / self.starting_balance

    def summary(self) -> str:
        return (
            f"rounds={self.rounds} bets={self.bets} "
            f"W/L/push={self.wins}/{self.losses}/{self.pushes} "
            f"start={self.starting_balance:.8f} end={self.ending_balance:.8f} "
            f"pnl={self.profit:+.8f} roi={self.roi:+.2%} "
            f"stopped: {self.stop_reason}"
        )


class BotEngine:
    """Runs one betting session to completion."""

    def __init__(
        self,
        driver: BaccaratDriver,
        strategy: StreakMartingale,
        risk: RiskManager,
        delay: float = 0.0,
        keep_records: bool = True,
    ) -> None:
        self.driver = driver
        self.strategy = strategy
        self.risk = risk
        self.delay = delay
        self.keep_records = keep_records

    async def run(self) -> SessionReport:
        start = self.risk.starting_balance
        balance = start
        wins = losses = pushes = 0
        records: List[RoundRecord] = []

        while not self.risk.stopped:
            decision = self.strategy.decide(balance, start)
            rejected: Optional[str] = None
            stake = 0.0
            side: Optional[Outcome] = None

            if decision is not None:
                stake, rejected = self.risk.vet_stake(decision.stake, balance)
                if rejected is None:
                    side = decision.side
                else:
                    log.warning("bet not placed: %s", rejected)

            try:
                result: RoundResult = await self.driver.play_round(side, stake)
            except DriverError as exc:
                self.risk.stop_reason = f"driver error: {exc}"
                log.error("stopping: %s", exc)
                break

            placed = side is not None
            if placed:
                if result.outcome is Outcome.TIE:
                    pushes += 1
                elif result.profit > 0:
                    wins += 1
                else:
                    losses += 1

            self.strategy.observe(result.outcome, bet_settled=placed)
            self.risk.round_played(placed)

            balance = (
                result.balance if result.balance is not None else balance + result.profit
            )

            if self.keep_records:
                records.append(
                    RoundRecord(
                        index=self.risk.rounds,
                        outcome=result.outcome,
                        decision=decision if placed else None,
                        profit=result.profit,
                        balance=balance,
                        rejected=rejected,
                    )
                )

            if placed:
                log.info(
                    "#%d %s bet %.8f on %s (%s) -> %+.8f | balance %.8f",
                    self.risk.rounds,
                    result.outcome.value,
                    stake,
                    decision.side.value,
                    decision.stage.value,
                    result.profit,
                    balance,
                )
            else:
                log.debug(
                    "#%d %s (watching, streak %s x%d)",
                    self.risk.rounds,
                    result.outcome.value,
                    self.strategy.tracker.side.value
                    if self.strategy.tracker.side
                    else "-",
                    self.strategy.tracker.length,
                )

            # A rejected stake that can never clear would spin forever.
            if rejected is not None and self.strategy.stage is not Stage.IDLE:
                self.risk.stop_reason = f"cannot place required bet: {rejected}"
                break

            self.risk.check_session(balance)

            if self.delay:
                await asyncio.sleep(self.delay)

        return SessionReport(
            starting_balance=start,
            ending_balance=balance,
            rounds=self.risk.rounds,
            bets=self.risk.bets,
            wins=wins,
            losses=losses,
            pushes=pushes,
            stop_reason=self.risk.stop_reason or "completed",
            records=records,
        )
