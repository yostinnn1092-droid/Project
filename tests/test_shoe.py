"""Tests for the punto banco rules engine."""

import collections
import random

import pytest

from baccarat_bot.shoe import Outcome, Shoe, _banker_draws, hand_total


class TestHandTotal:
    @pytest.mark.parametrize(
        "cards,expected",
        [([9, 9], 8), ([0, 0], 0), ([5, 5], 0), ([7, 2], 9), ([1, 2, 3], 6)],
    )
    def test_modulo_ten(self, cards, expected):
        assert hand_total(cards) == expected


class TestBankerRule:
    def test_stands_on_six_when_player_stood(self):
        assert _banker_draws(6, None) is False

    def test_draws_on_five_when_player_stood(self):
        assert _banker_draws(5, None) is True

    def test_three_stands_only_against_an_eight(self):
        assert _banker_draws(3, 8) is False
        assert _banker_draws(3, 9) is True

    def test_six_draws_only_against_six_or_seven(self):
        assert [_banker_draws(6, c) for c in (5, 6, 7, 8)] == [False, True, True, False]

    def test_seven_always_stands(self):
        assert all(_banker_draws(7, c) is False for c in range(10))


class TestShoe:
    def test_deals_two_to_three_cards_per_side(self):
        shoe = Shoe(rng=random.Random(0))
        for _ in range(200):
            coup = shoe.deal()
            assert 2 <= len(coup.player_cards) <= 3
            assert 2 <= len(coup.banker_cards) <= 3

    def test_naturals_stand_pat(self):
        shoe = Shoe(rng=random.Random(0))
        for _ in range(500):
            coup = shoe.deal()
            if hand_total(coup.player_cards[:2]) >= 8 or hand_total(
                coup.banker_cards[:2]
            ) >= 8:
                assert len(coup.player_cards) == 2
                assert len(coup.banker_cards) == 2

    def test_outcome_matches_totals(self):
        shoe = Shoe(rng=random.Random(1))
        for _ in range(500):
            coup = shoe.deal()
            if coup.outcome is Outcome.PLAYER:
                assert coup.player_total > coup.banker_total
            elif coup.outcome is Outcome.BANKER:
                assert coup.banker_total > coup.player_total
            else:
                assert coup.player_total == coup.banker_total

    def test_distribution_matches_real_baccarat(self):
        shoe = Shoe(rng=random.Random(42))
        counts = collections.Counter(shoe.deal().outcome for _ in range(60000))
        total = sum(counts.values())
        # Published figures: banker 45.86%, player 44.62%, tie 9.52%.
        assert counts[Outcome.BANKER] / total == pytest.approx(0.4586, abs=0.01)
        assert counts[Outcome.PLAYER] / total == pytest.approx(0.4462, abs=0.01)
        assert counts[Outcome.TIE] / total == pytest.approx(0.0952, abs=0.01)

    def test_reshuffles_and_never_runs_dry(self):
        shoe = Shoe(decks=1, rng=random.Random(3))
        for _ in range(2000):
            shoe.deal()
        assert shoe.cards_remaining > 0

    def test_seeded_shoes_are_reproducible(self):
        a = [Shoe(rng=random.Random(9)).deal().outcome for _ in range(1)]
        b = [Shoe(rng=random.Random(9)).deal().outcome for _ in range(1)]
        assert a == b

    @pytest.mark.parametrize("kwargs", [{"decks": 0}, {"penetration": 0.0}])
    def test_bad_config_is_rejected(self, kwargs):
        with pytest.raises(ValueError):
            Shoe(**kwargs)
