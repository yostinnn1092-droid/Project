"""Where a gambling edge can actually come from: money paid outside the bet.

No staking rule changes the return on a wager -- see :mod:`systems`, where
every classic system measures 0.99 per dollar staked. What *can* change
it is value that does not come from the game: rakeback, reloads, bonuses,
cashback. Those pay per unit of turnover (or as a lump sum) rather than
per unit of luck, so they add to the same ledger the edge subtracts from.

The whole question is one comparison: does the rebate you receive per
dollar wagered exceed the edge you pay per dollar wagered?
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

#: House edge by Stake game, as a fraction of each amount staked.
HOUSE_EDGE = {
    "dice": 0.01,
    "limbo": 0.01,
    "baccarat_banker": 0.0106,
    "baccarat_player": 0.0124,
    "blackjack": 0.005,
    "roulette": 0.027,
}


@dataclass
class RebateVerdict:
    """Whether a turnover-based rebate beats the edge."""

    edge_per_dollar: float
    rebate_per_dollar: float

    @property
    def net_per_dollar(self) -> float:
        """Expected profit per dollar wagered. Positive means +EV."""
        return self.rebate_per_dollar - self.edge_per_dollar

    @property
    def profitable(self) -> bool:
        return self.net_per_dollar > 0

    def over(self, turnover: float) -> float:
        """Expected profit after wagering this much in total."""
        return self.net_per_dollar * turnover

    def summary(self) -> str:
        verdict = "PROFITABLE" if self.profitable else "still losing"
        return (
            f"edge {self.edge_per_dollar:.4%}/$ vs rebate "
            f"{self.rebate_per_dollar:.4%}/$ -> "
            f"{self.net_per_dollar:+.4%} per $ wagered ({verdict})"
        )


def rakeback_verdict(
    rakeback_rate: float,
    game: str = "dice",
    rate_is_share_of_edge: bool = True,
) -> RebateVerdict:
    """Compare a rakeback rate against a game's house edge.

    Args:
        rakeback_rate: The advertised rate, as a fraction (0.05 for 5%).
        game: Key into :data:`HOUSE_EDGE`.
        rate_is_share_of_edge: Most sites, Stake included, quote rakeback
            as a share of the *house edge*, not of turnover -- 5%
            rakeback on a 1% edge returns 0.05%, not 5%, of what you
            wager. Set False if the rate really is a share of turnover.
    """
    if game not in HOUSE_EDGE:
        raise ValueError(f"unknown game {game!r}; known: {sorted(HOUSE_EDGE)}")
    edge = HOUSE_EDGE[game]
    rebate = rakeback_rate * edge if rate_is_share_of_edge else rakeback_rate
    return RebateVerdict(edge_per_dollar=edge, rebate_per_dollar=rebate)


def breakeven_rakeback_share(game: str = "dice") -> float:
    """Share of the house edge a rebate must return just to break even.

    It is always 1.0: a rebate has to hand back the entire edge before
    the game stops costing money. Rakeback is a discount, never a profit.
    """
    if game not in HOUSE_EDGE:
        raise ValueError(f"unknown game {game!r}")
    return 1.0


@dataclass
class BonusVerdict:
    """Whether a lump-sum bonus survives its wagering requirement."""

    bonus: float
    wagering_multiple: float
    edge: float

    @property
    def required_turnover(self) -> float:
        return self.bonus * self.wagering_multiple

    @property
    def expected_cost(self) -> float:
        """What clearing the requirement costs in expectation."""
        return self.required_turnover * self.edge

    @property
    def expected_value(self) -> float:
        return self.bonus - self.expected_cost

    @property
    def profitable(self) -> bool:
        return self.expected_value > 0

    def summary(self) -> str:
        verdict = "+EV, worth claiming" if self.profitable else "-EV, skip it"
        return (
            f"${self.bonus:,.2f} bonus at {self.wagering_multiple:g}x "
            f"requires ${self.required_turnover:,.2f} wagered, costing "
            f"${self.expected_cost:,.2f} at a {self.edge:.2%} edge -> "
            f"EV ${self.expected_value:+,.2f} ({verdict})"
        )


def bonus_verdict(
    bonus: float, wagering_multiple: float, game: str = "dice"
) -> BonusVerdict:
    """Evaluate a bonus against its wagering requirement."""
    if game not in HOUSE_EDGE:
        raise ValueError(f"unknown game {game!r}; known: {sorted(HOUSE_EDGE)}")
    if bonus <= 0:
        raise ValueError("bonus must be positive")
    if wagering_multiple < 0:
        raise ValueError("wagering_multiple must be >= 0")
    return BonusVerdict(bonus, wagering_multiple, HOUSE_EDGE[game])


def max_wagering_multiple(game: str = "dice") -> float:
    """Highest wagering requirement a bonus can carry and stay +EV.

    Clearing costs ``multiple x bonus x edge``; that stays under the
    bonus itself while ``multiple < 1 / edge``. On a 1% edge that is
    100x -- above it, the grind costs more than the bonus is worth.
    """
    if game not in HOUSE_EDGE:
        raise ValueError(f"unknown game {game!r}")
    return 1.0 / HOUSE_EDGE[game]
