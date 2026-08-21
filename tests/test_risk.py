"""Tests for the bankroll guards."""

import pytest

from baccarat_bot.risk import RiskConfig, RiskManager


def manager(**kwargs):
    return RiskManager(RiskConfig(**kwargs), starting_balance=1000.0)


class TestStakeVetting:
    def test_rounds_down_never_up(self):
        stake, reason = manager(stake_precision=2).vet_stake(1.999, 1000.0)
        assert (stake, reason) == (1.99, None)

    def test_rejects_below_table_minimum(self):
        _, reason = manager(min_stake=1.0).vet_stake(0.5, 1000.0)
        assert "below table minimum" in reason

    def test_rejects_stake_over_balance(self):
        _, reason = manager(max_stake_pct=1.0).vet_stake(50.0, 10.0)
        assert "exceeds balance" in reason

    def test_rejects_stake_over_max_fraction(self):
        _, reason = manager(max_stake_pct=0.1).vet_stake(200.0, 1000.0)
        assert "exceeds max" in reason

    def test_rejects_stake_that_rounds_to_zero(self):
        _, reason = manager(stake_precision=2).vet_stake(0.001, 1000.0)
        assert reason == "stake rounds to zero"

    def test_martingale_step_can_exceed_the_cap(self):
        """A doubled 1% stake must still clear a 10% cap."""
        risk = manager()
        assert risk.vet_stake(10.0, 1000.0)[1] is None
        assert risk.vet_stake(20.0, 1000.0)[1] is None


class TestSessionLimits:
    def test_stop_loss_trips(self):
        risk = manager(stop_loss_pct=0.2)
        assert risk.check_session(850.0) is None
        assert "stop-loss" in risk.check_session(800.0)
        assert risk.stopped

    def test_take_profit_trips(self):
        risk = manager(take_profit_pct=0.5)
        assert risk.check_session(1400.0) is None
        assert "take-profit" in risk.check_session(1500.0)

    def test_take_profit_disabled_by_zero(self):
        risk = manager(take_profit_pct=0.0)
        assert risk.check_session(1_000_000.0) is None

    def test_round_and_bet_limits(self):
        risk = manager(max_rounds=3)
        for _ in range(3):
            risk.round_played(placed=False)
        assert "round limit" in risk.check_session(1000.0)

        risk = manager(max_bets=2)
        for _ in range(2):
            risk.round_played(placed=True)
        assert "bet limit" in risk.check_session(1000.0)

    def test_placed_flag_separates_rounds_from_bets(self):
        risk = manager()
        risk.round_played(placed=False)
        risk.round_played(placed=True)
        assert (risk.rounds, risk.bets) == (2, 1)


class TestConfigValidation:
    @pytest.mark.parametrize(
        "kwargs",
        [{"stop_loss_pct": 1.5}, {"take_profit_pct": -0.1}, {"stake_precision": -1}],
    )
    def test_bad_config_is_rejected(self, kwargs):
        with pytest.raises(ValueError):
            RiskConfig(**kwargs)
