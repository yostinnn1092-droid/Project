"""Tests for the Stake Dice model and the autobet condition engine."""

import random

import pytest

from baccarat_bot.dice import (
    MAX_WIN_CHANCE,
    ParoliConfig,
    ParoliStrategy,
    multiplier_for,
    run_session,
)


class TestMultiplier:
    @pytest.mark.parametrize(
        "chance,expected", [(49.5, 2.0), (20.0, 4.95), (98.0, 99 / 98), (9.9, 10.0)]
    )
    def test_matches_stake_payout_table(self, chance, expected):
        assert multiplier_for(chance) == pytest.approx(expected)

    def test_house_edge_is_one_percent(self):
        for chance in (1.0, 20.0, 49.5, 90.0):
            ev = (chance / 100) * multiplier_for(chance) - 1
            assert ev == pytest.approx(-0.01)

    @pytest.mark.parametrize("chance", [0.0, 99.5, -1])
    def test_out_of_range_rejected(self, chance):
        with pytest.raises(ValueError):
            multiplier_for(chance)


class TestConditions:
    def strategy(self, **kwargs):
        return ParoliStrategy(ParoliConfig(**kwargs), base_bet=1.0)

    def test_first_loss_sets_win_chance_to_twenty(self):
        s = self.strategy()
        s.register(won=False)
        assert s.win_chance == pytest.approx(20.0)
        assert s.bet == pytest.approx(1.0)  # condition 1 has not fired yet

    def test_every_second_loss_raises_win_chance(self):
        s = self.strategy()
        for _ in range(2):
            s.register(won=False)
        assert s.win_chance == pytest.approx(21.0)
        for _ in range(2):
            s.register(won=False)
        assert s.win_chance == pytest.approx(22.0)

    def test_bet_only_escalates_past_three_losses(self):
        s = self.strategy()
        for _ in range(3):
            s.register(won=False)
        assert s.bet == pytest.approx(1.0)
        s.register(won=False)
        assert s.bet == pytest.approx(1.5)
        s.register(won=False)
        assert s.bet == pytest.approx(2.25)

    def test_escalation_is_geometric(self):
        s = self.strategy()
        for _ in range(8):
            s.register(won=False)
        assert s.bet == pytest.approx(1.5 ** 5)

    def test_a_win_resets_everything(self):
        s = self.strategy()
        for _ in range(6):
            s.register(won=False)
        s.register(won=True)
        assert s.bet == pytest.approx(1.0)
        assert s.win_chance == pytest.approx(49.5)
        assert s.loss_streak == 0

    def test_win_chance_is_capped(self):
        s = self.strategy(chance_step_pct=40.0)
        for _ in range(10):
            s.register(won=False)
        assert s.win_chance <= MAX_WIN_CHANCE


class TestSession:
    def test_flat_betting_converges_on_the_house_edge(self):
        """Pooled over many seeds -- a single session at 2x payout has a
        standard error near 0.7%, far too wide to assert against."""
        cfg = ParoliConfig(
            base_bet_pct=0.001,
            first_loss_win_chance=49.5,
            bet_raise_pct=0.0,
            chance_step_pct=0.0,
        )
        profit = turnover = 0.0
        for seed in range(10):
            report = run_session(
                cfg, balance=1000.0, max_rolls=20000, rng=random.Random(seed)
            )
            profit += report.profit
            turnover += report.turnover
        assert profit / turnover == pytest.approx(-0.01, abs=0.008)

    def test_session_stops_when_bankrupt(self):
        cfg = ParoliConfig(base_bet_pct=0.9)
        report = run_session(cfg, balance=10.0, max_rolls=500, rng=random.Random(1))
        assert report.busted
        assert report.rolls < 500

    def test_stop_loss_halts_the_session(self):
        cfg = ParoliConfig(base_bet_pct=0.05)
        report = run_session(
            cfg, balance=1000.0, max_rolls=5000, stop_loss_pct=0.2,
            rng=random.Random(3),
        )
        assert report.ending_balance <= 800.0
        assert report.stopped == "stop-loss"

    def test_table_minimum_stops_play(self):
        cfg = ParoliConfig(base_bet_pct=0.001)
        report = run_session(
            cfg, balance=1000.0, max_rolls=100, min_bet=5.0, rng=random.Random(2)
        )
        assert report.stopped == "below table minimum"
        assert report.rolls == 0

    def test_seeded_sessions_reproduce(self):
        cfg = ParoliConfig()
        a = run_session(cfg, rng=random.Random(11))
        b = run_session(cfg, rng=random.Random(11))
        assert a.ending_balance == b.ending_balance

    def test_turnover_accumulates(self):
        report = run_session(
            ParoliConfig(), balance=1000.0, max_rolls=50, rng=random.Random(5)
        )
        assert report.turnover > 0
        assert report.rolls > 0


class TestConfigValidation:
    @pytest.mark.parametrize(
        "kwargs",
        [{"base_win_chance": 0}, {"base_bet_pct": 0}, {"base_bet_pct": 2},
         {"chance_step_every": 0}],
    )
    def test_bad_config_rejected(self, kwargs):
        with pytest.raises(ValueError):
            ParoliConfig(**kwargs)
