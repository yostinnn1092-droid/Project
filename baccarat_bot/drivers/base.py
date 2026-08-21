"""Driver protocol: how the engine places bets and learns outcomes."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Protocol, runtime_checkable

from ..shoe import Outcome


@dataclass
class RoundResult:
    """The settled result of one coup from the driver's point of view."""

    outcome: Outcome
    #: Net profit for the round: positive win, negative loss, 0.0 for a
    #: push or for a coup we sat out.
    profit: float = 0.0
    stake: float = 0.0
    balance: Optional[float] = None
    raw: Optional[dict] = None


class DriverError(RuntimeError):
    """Raised when a driver cannot place a bet or read a result."""


@runtime_checkable
class BaccaratDriver(Protocol):
    """Everything the engine needs from a table.

    Two implementations ship with the bot: :class:`~.paper.PaperDriver`
    (a local simulated shoe) and :class:`~.stake.StakeDriver` (live, via
    the StakeAPI wrapper).
    """

    async def get_balance(self) -> float:
        """Current wagerable balance in the configured currency."""

    async def play_round(self, side: Optional[Outcome], stake: float) -> RoundResult:
        """Play one coup.

        Args:
            side: Side to back, or ``None`` to observe the coup without
                wagering.
            stake: Amount to wager; ignored when ``side`` is ``None``.
        """

    async def close(self) -> None:
        """Release any underlying resources."""
