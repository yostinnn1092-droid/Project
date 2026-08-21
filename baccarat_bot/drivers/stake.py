"""Live driver backed by the StakeAPI GraphQL wrapper.

    !!  READ THIS BEFORE GOING LIVE  !!

Two things about this driver are *unverified*, because the StakeAPI
wrapper (github.com/brokechubb/StakeAPI) ships no baccarat support at
all -- its only verified wagering mutations are ``blackjackBet`` and
``blackjackNext``.

1. ``BACCARAT_BET_MUTATION`` below is modelled on the verified blackjack
   mutation and on Stake's usual Originals bet shape. The field name,
   the argument names and the ``state`` selection are a best guess. Copy
   the real mutation out of your browser DevTools (Network tab, filter
   ``/_api/graphql``, play one hand by hand) and paste it in -- that is
   the only edit this file should need.

2. Stake's baccarat is an *Originals* game: a coup only exists because
   you bet on it. There is no shared shoe to watch, so the streak the
   strategy needs cannot be read passively. When the strategy sits a
   coup out, this driver places a probe bet of ``observe_stake`` to
   generate an observable result. Those probes cost real money and carry
   the normal house edge. Set ``observe_stake`` to the table minimum and
   budget for it, or run the bot on ``paper`` where observation is free.
"""

from __future__ import annotations

from typing import Any, Dict, Optional
from uuid import uuid4

from ..shoe import Outcome
from .base import DriverError, RoundResult

#: Best-guess mutation -- see the module docstring. Replace with the real
#: operation captured from DevTools before trusting this with money.
BACCARAT_BET_MUTATION = """
mutation BaccaratBet(
  $amount: Float!,
  $currency: CurrencyEnum!,
  $identifier: String!,
  $player: Float!,
  $banker: Float!,
  $tie: Float!
) {
  baccaratBet(
    amount: $amount,
    currency: $currency,
    identifier: $identifier,
    player: $player,
    banker: $banker,
    tie: $tie
  ) {
    id
    active
    payout
    payoutMultiplier
    amount
    currency
    game
    state {
      ... on CasinoGameBaccarat {
        player { score cards { rank suit } }
        banker { score cards { rank suit } }
      }
    }
  }
}
"""


def _outcome_from_state(state: Dict[str, Any]) -> Outcome:
    """Derive the coup result from the returned game state."""
    player = (state or {}).get("player") or {}
    banker = (state or {}).get("banker") or {}
    if "score" not in player or "score" not in banker:
        raise DriverError(f"cannot read baccarat scores from state: {state!r}")
    p, b = int(player["score"]), int(banker["score"])
    if p > b:
        return Outcome.PLAYER
    if b > p:
        return Outcome.BANKER
    return Outcome.TIE


class StakeDriver:
    """Places real baccarat bets through a ``StakeAPI`` client."""

    name = "stake"

    def __init__(
        self,
        client: Any,
        currency: str = "usdt",
        observe_stake: float = 0.0,
        dry_run: bool = True,
    ) -> None:
        self.client = client
        self.currency = currency.lower()
        self.observe_stake = observe_stake
        self.dry_run = dry_run

    async def get_balance(self) -> float:
        balances = await self.client.get_user_balance()
        return float(balances.get("available", {}).get(self.currency, 0.0))

    async def play_round(self, side: Optional[Outcome], stake: float) -> RoundResult:
        wager_side, wager = side, stake
        if wager_side is None or wager <= 0:
            if self.observe_stake <= 0:
                raise DriverError(
                    "Stake baccarat produces no coup unless a bet is placed. "
                    "Set observe_stake to the table minimum so the bot can "
                    "watch for streaks, or run the paper driver instead."
                )
            # Probe bet purely to reveal the next coup.
            wager_side, wager = Outcome.BANKER, self.observe_stake

        if self.dry_run:
            raise DriverError(
                "StakeDriver is in dry_run mode and will not place a real bet. "
                "Pass dry_run=False once BACCARAT_BET_MUTATION is verified."
            )

        variables = {
            "amount": float(wager),
            "currency": self.currency,
            "identifier": uuid4().hex,
            "player": float(wager) if wager_side is Outcome.PLAYER else 0.0,
            "banker": float(wager) if wager_side is Outcome.BANKER else 0.0,
            "tie": 0.0,
        }
        data = await self.client._graphql_request(
            BACCARAT_BET_MUTATION,
            variables=variables,
            operation_name="BaccaratBet",
        )
        bet = (data or {}).get("baccaratBet")
        if not bet:
            raise DriverError(f"no baccaratBet payload in response: {data!r}")

        outcome = _outcome_from_state(bet.get("state") or {})
        payout = float(bet.get("payout") or 0.0)
        amount = float(bet.get("amount") or wager)
        # Stake reports gross payout; the wager is already debited.
        profit = payout - amount
        # A coup we only probed is not strategy P&L, but it is real money.
        return RoundResult(
            outcome=outcome,
            profit=profit if side is not None else profit,
            stake=amount,
            raw=bet,
        )

    async def close(self) -> None:
        await self.client.close()
