"""Paper driver: a local simulated table with no network access."""

from __future__ import annotations

import random
from typing import Optional

from ..shoe import Outcome, Shoe
from .base import RoundResult

#: Commission taken on winning banker bets.
BANKER_COMMISSION = 0.05


class PaperDriver:
    """Deals from a local :class:`~..shoe.Shoe` against a virtual bankroll.

    Payouts follow the standard table: player pays 1:1, banker pays 1:1
    less 5% commission, and a tie pushes any player/banker bet.
    """

    name = "paper"

    def __init__(
        self,
        balance: float = 1000.0,
        seed: Optional[int] = None,
        decks: int = 8,
    ) -> None:
        self.balance = float(balance)
        self.shoe = Shoe(decks=decks, rng=random.Random(seed))

    async def get_balance(self) -> float:
        return self.balance

    async def play_round(self, side: Optional[Outcome], stake: float) -> RoundResult:
        coup = self.shoe.deal()

        if side is None or stake <= 0:
            return RoundResult(outcome=coup.outcome, balance=self.balance)

        if stake > self.balance:
            raise ValueError(
                f"stake {stake:.8f} exceeds paper balance {self.balance:.8f}"
            )

        if coup.outcome is Outcome.TIE:
            profit = 0.0  # push
        elif coup.outcome is side:
            profit = stake * (1 - BANKER_COMMISSION) if side is Outcome.BANKER else stake
        else:
            profit = -stake

        self.balance += profit
        return RoundResult(
            outcome=coup.outcome,
            profit=profit,
            stake=stake,
            balance=self.balance,
        )

    async def close(self) -> None:
        return None
