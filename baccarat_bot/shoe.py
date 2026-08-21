"""Baccarat shoe and hand resolution.

Implements the standard punto banco drawing rules so paper trading and
backtests produce realistic outcome distributions (roughly 45.9% banker,
44.6% player, 9.5% tie) rather than a naive coin flip.
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field
from enum import Enum
from typing import List, Optional


class Outcome(str, Enum):
    """Result of a single baccarat coup."""

    PLAYER = "player"
    BANKER = "banker"
    TIE = "tie"


#: Card ranks as they are counted in baccarat. Tens and faces are worth zero.
_RANKS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 0, 0, 0]


def hand_total(cards: List[int]) -> int:
    """Baccarat hand value: sum of card points modulo 10."""
    return sum(cards) % 10


@dataclass
class Coup:
    """A single resolved baccarat hand."""

    outcome: Outcome
    player_cards: List[int] = field(default_factory=list)
    banker_cards: List[int] = field(default_factory=list)

    @property
    def player_total(self) -> int:
        return hand_total(self.player_cards)

    @property
    def banker_total(self) -> int:
        return hand_total(self.banker_cards)


def _banker_draws(banker_total: int, player_third: Optional[int]) -> bool:
    """Standard banker drawing rule, given the player's third card (if any)."""
    if player_third is None:
        # Player stood: banker draws on 0-5, stands on 6-7.
        return banker_total <= 5
    if banker_total <= 2:
        return True
    if banker_total == 3:
        return player_third != 8
    if banker_total == 4:
        return 2 <= player_third <= 7
    if banker_total == 5:
        return 4 <= player_third <= 7
    if banker_total == 6:
        return 6 <= player_third <= 7
    return False  # 7 stands; 8-9 are naturals and never reach here


class Shoe:
    """An 8-deck baccarat shoe that reshuffles when the cut card is reached."""

    def __init__(
        self,
        decks: int = 8,
        penetration: float = 0.85,
        rng: Optional[random.Random] = None,
    ) -> None:
        if decks < 1:
            raise ValueError("decks must be >= 1")
        if not 0.1 <= penetration <= 1.0:
            raise ValueError("penetration must be between 0.1 and 1.0")
        self.decks = decks
        self.penetration = penetration
        self._rng = rng or random.Random()
        self._cards: List[int] = []
        self._cut = 0
        self.shuffle()

    def shuffle(self) -> None:
        """Rebuild and shuffle the shoe."""
        self._cards = [rank for rank in _RANKS for _ in range(4 * self.decks)]
        self._rng.shuffle(self._cards)
        self._cut = int(len(self._cards) * self.penetration)

    @property
    def cards_remaining(self) -> int:
        return len(self._cards)

    def _draw(self) -> int:
        if not self._cards:
            self.shuffle()
        return self._cards.pop()

    def deal(self) -> Coup:
        """Deal and resolve one coup according to punto banco rules."""
        if len(self._cards) < (len(_RANKS) * 4 * self.decks) - self._cut:
            # Cut card reached: reshuffle before the next coup.
            self.shuffle()

        player = [self._draw(), self._draw()]
        banker = [self._draw(), self._draw()]

        p_total, b_total = hand_total(player), hand_total(banker)

        # Naturals end the coup immediately.
        if p_total < 8 and b_total < 8:
            player_third: Optional[int] = None
            if p_total <= 5:
                player_third = self._draw()
                player.append(player_third)
            if _banker_draws(hand_total(banker), player_third):
                banker.append(self._draw())

        p_total, b_total = hand_total(player), hand_total(banker)
        if p_total > b_total:
            outcome = Outcome.PLAYER
        elif b_total > p_total:
            outcome = Outcome.BANKER
        else:
            outcome = Outcome.TIE

        return Coup(outcome=outcome, player_cards=player, banker_cards=banker)
