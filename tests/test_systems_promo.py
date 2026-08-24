"""Tests for betting systems and promotional EV."""

import random

import pytest

from baccarat_bot.promo import (
    HOUSE_EDGE,
    bonus_verdict,
    max_wagering_multiple,
    rakeback_verdict,
)
from baccarat_bot.dice import multiplier_for
from baccarat_bot.systems import (
    ALL_SYSTEMS,
    DAlembert,
    Fibonacci,
    Flat,
    Martingale,
    measure,
    measure_constrained,
)


class TestSystemMechanics:
    def test_flat_never_moves(self):
        s = Flat(unit=2.0)
        for won in (True, False, False, True):
            assert s.next_bet() == 2.0
            s.settle(won)

    def test_martingale_doubles_and_resets(self):
        s = Martingale(unit=1.0)
        assert s.next_bet() == 1.0
        s.settle(False)
        assert s.next_bet() == 2.0
        s.settle(False)
        assert s.next_bet() == 4.0
        s.settle(True)
        assert s.next_bet() == 1.0

    def test_dalembert_steps_and_floors_at_one_unit(self):
        s = DAlembert(unit=1.0)
        s.settle(False)
        assert s.next_bet() == 2.0
        s.settle(True)
        assert s.next_bet() == 1.0
        s.settle(True)  # already at the floor
        assert s.next_bet() == 1.0

    def test_fibonacci_walks_the_sequence(self):
        s = Fibonacci(unit=1.0)
        seen = []
        for _ in range(6):
            seen.append(s.next_bet())
            s.settle(False)
        assert seen == [1, 1, 2, 3, 5, 8]

    def test_fibonacci_steps_back_two_on_a_win(self):
        s = Fibonacci(unit=1.0)
        for _ in range(4):
            s.next_bet()
            s.settle(False)
        assert s.next_bet() == 5
        s.settle(True)
        assert s.next_bet() == 2


class TestNoSystemBeatsTheEdge:
    """The central claim: staking rules do not change return per dollar."""

    def test_expected_value_per_bet_is_the_edge_at_any_stake(self):
        """The theorem everything else rests on, stated exactly.

        A staking rule only chooses ``stake`` before a roll. Expectation
        is linear, so if every individual bet returns -1% of its stake,
        no sequence of stakes can return anything else.
        """
        for chance in (1.0, 5.0, 20.0, 49.5, 90.0, 98.0):
            p = chance / 100
            payout = multiplier_for(chance)
            for stake in (0.0001, 1.0, 1000.0, 1e6):
                ev = p * stake * (payout - 1) + (1 - p) * (-stake)
                assert ev == pytest.approx(-0.01 * stake, rel=1e-9)

    def test_flat_betting_converges_on_the_edge(self):
        turnover = net = 0.0
        for seed in range(20):
            r = measure(Flat, rolls=50_000, rng=random.Random(seed))
            turnover += r.turnover
            net += r.net
        assert net / turnover == pytest.approx(-0.01, abs=0.004)

    @pytest.mark.parametrize("factory", ALL_SYSTEMS, ids=lambda f: f().name)
    def test_no_system_turns_a_profit_over_many_runs(self, factory):
        """Escalating systems have tails too fat to pin to -1% cheaply,
        so assert the direction: none of them come out ahead."""
        turnover = profit = 0.0
        for seed in range(150):
            r = measure_constrained(
                factory, balance=1000.0, unit=1.0, rolls=3000,
                rng=random.Random(7000 + seed),
            )
            turnover += r.turnover
            profit += r.profit
        assert profit < 0, f"{factory().name} showed a profit"
        assert profit / turnover < 0

    def test_escalating_systems_ruin_far_more_often_than_flat(self):
        def ruin_rate(factory):
            reps = [
                measure_constrained(
                    factory, balance=200.0, unit=1.0, rolls=5000,
                    rng=random.Random(400 + i),
                )
                for i in range(200)
            ]
            return sum(1 for r in reps if r.ruined) / len(reps)

        assert ruin_rate(Flat) < 0.05
        assert ruin_rate(Martingale) > 0.5


class TestRakeback:
    def test_partial_rakeback_still_loses(self):
        assert not rakeback_verdict(0.50, "dice").profitable

    def test_full_rakeback_only_breaks_even(self):
        v = rakeback_verdict(1.0, "dice")
        assert v.net_per_dollar == pytest.approx(0.0)
        assert not v.profitable

    def test_rakeback_above_the_edge_is_profitable(self):
        assert rakeback_verdict(1.5, "dice").profitable

    def test_share_of_edge_is_not_share_of_turnover(self):
        as_edge = rakeback_verdict(0.05, "dice", rate_is_share_of_edge=True)
        as_turnover = rakeback_verdict(0.05, "dice", rate_is_share_of_edge=False)
        assert as_edge.rebate_per_dollar == pytest.approx(0.0005)
        assert as_turnover.rebate_per_dollar == pytest.approx(0.05)
        assert not as_edge.profitable and as_turnover.profitable

    def test_projected_profit_scales_with_turnover(self):
        v = rakeback_verdict(0.0, "dice")
        assert v.over(10_000) == pytest.approx(-100.0)

    def test_unknown_game_rejected(self):
        with pytest.raises(ValueError):
            rakeback_verdict(0.1, "keno")


class TestBonuses:
    def test_low_wagering_bonus_is_worth_claiming(self):
        assert bonus_verdict(10.0, 10, "dice").profitable

    def test_breakeven_is_the_inverse_of_the_edge(self):
        assert max_wagering_multiple("dice") == pytest.approx(100.0)
        v = bonus_verdict(10.0, 100, "dice")
        assert v.expected_value == pytest.approx(0.0)

    def test_high_wagering_bonus_costs_more_than_it_pays(self):
        v = bonus_verdict(10.0, 200, "dice")
        assert not v.profitable
        assert v.expected_value == pytest.approx(-10.0)

    def test_lower_edge_games_clear_requirements_more_cheaply(self):
        assert max_wagering_multiple("blackjack") > max_wagering_multiple("dice")
        assert max_wagering_multiple("dice") > max_wagering_multiple("roulette")

    def test_required_turnover_is_bonus_times_multiple(self):
        assert bonus_verdict(25.0, 40, "dice").required_turnover == pytest.approx(1000.0)

    @pytest.mark.parametrize("kwargs", [{"bonus": 0}, {"bonus": -5}])
    def test_bad_bonus_rejected(self, kwargs):
        with pytest.raises(ValueError):
            bonus_verdict(wagering_multiple=10, **kwargs)


class TestEdgeTable:
    def test_all_edges_are_plausible(self):
        for game, edge in HOUSE_EDGE.items():
            assert 0 < edge < 0.10, game
