"""Tests for the session engine and drivers."""

import pytest

from baccarat_bot.drivers.base import DriverError, RoundResult
from baccarat_bot.drivers.paper import PaperDriver
from baccarat_bot.drivers.stake import StakeDriver, _outcome_from_state
from baccarat_bot.engine import BotEngine
from baccarat_bot.risk import RiskConfig, RiskManager
from baccarat_bot.shoe import Outcome
from baccarat_bot.strategy import StreakMartingale, StrategyConfig

P, B, T = Outcome.PLAYER, Outcome.BANKER, Outcome.TIE


class ScriptedDriver:
    """Deals a fixed sequence of outcomes so sessions are deterministic."""

    def __init__(self, outcomes, balance=1000.0):
        self.outcomes = list(outcomes)
        self.balance = balance
        self.placed = []
        self.index = 0

    async def get_balance(self):
        return self.balance

    async def play_round(self, side, stake):
        if self.index >= len(self.outcomes):
            raise DriverError("script exhausted")
        outcome = self.outcomes[self.index]
        self.index += 1

        profit = 0.0
        if side is not None and stake > 0:
            self.placed.append((side, stake))
            if outcome is T:
                profit = 0.0
            elif outcome is side:
                profit = stake * 0.95 if side is B else stake
            else:
                profit = -stake
        self.balance += profit
        return RoundResult(
            outcome=outcome, profit=profit, stake=stake, balance=self.balance
        )

    async def close(self):
        return None


def build(driver, strategy_config=None, risk_config=None):
    return BotEngine(
        driver=driver,
        strategy=StreakMartingale(strategy_config or StrategyConfig()),
        risk=RiskManager(risk_config or RiskConfig(), driver.balance),
    )


@pytest.mark.asyncio
class TestPaperDriver:
    async def test_banker_win_pays_commission(self):
        driver = PaperDriver(balance=100.0, seed=0)
        driver.shoe.deal = lambda: type("C", (), {"outcome": B})()
        result = await driver.play_round(B, 10.0)
        assert result.profit == pytest.approx(9.5)

    async def test_player_win_pays_even_money(self):
        driver = PaperDriver(balance=100.0, seed=0)
        driver.shoe.deal = lambda: type("C", (), {"outcome": P})()
        result = await driver.play_round(P, 10.0)
        assert result.profit == pytest.approx(10.0)

    async def test_tie_pushes_the_bet(self):
        driver = PaperDriver(balance=100.0, seed=0)
        driver.shoe.deal = lambda: type("C", (), {"outcome": T})()
        result = await driver.play_round(P, 10.0)
        assert result.profit == 0.0
        assert driver.balance == 100.0

    async def test_watching_costs_nothing(self):
        driver = PaperDriver(balance=100.0, seed=0)
        result = await driver.play_round(None, 0.0)
        assert result.profit == 0.0
        assert driver.balance == 100.0

    async def test_stake_over_balance_is_refused(self):
        driver = PaperDriver(balance=5.0, seed=0)
        with pytest.raises(ValueError):
            await driver.play_round(P, 10.0)


@pytest.mark.asyncio
class TestEngine:
    async def test_watches_until_a_streak_appears(self):
        driver = ScriptedDriver([P, B, P, B, P])
        report = await build(driver, risk_config=RiskConfig(max_rounds=5)).run()
        assert driver.placed == []
        assert report.bets == 0
        assert report.profit == 0.0

    async def test_places_one_percent_after_three_in_a_row(self):
        driver = ScriptedDriver([P, P, P, P])
        await build(driver, risk_config=RiskConfig(max_rounds=4)).run()
        assert driver.placed == [(P, 10.0)]

    async def test_doubles_once_after_a_loss(self):
        driver = ScriptedDriver([P, P, P, B, B])
        await build(driver, risk_config=RiskConfig(max_rounds=5)).run()
        assert driver.placed == [(P, 10.0), (P, 20.0)]

    async def test_stands_down_after_two_losses(self):
        driver = ScriptedDriver([P, P, P, B, B, P, P])
        await build(driver, risk_config=RiskConfig(max_rounds=7)).run()
        assert driver.placed == [(P, 10.0), (P, 20.0)]

    async def test_tie_replays_the_same_stake(self):
        driver = ScriptedDriver([P, P, P, T, P])
        await build(driver, risk_config=RiskConfig(max_rounds=5)).run()
        assert driver.placed == [(P, 10.0), (P, 10.0)]

    async def test_counts_wins_losses_and_pushes(self):
        driver = ScriptedDriver([P, P, P, T, P])
        report = await build(driver, risk_config=RiskConfig(max_rounds=5)).run()
        assert (report.wins, report.losses, report.pushes) == (1, 0, 1)

    async def test_stop_loss_ends_the_session(self):
        driver = ScriptedDriver([P, P, P] + [B] * 40, balance=100.0)
        report = await build(
            driver,
            StrategyConfig(stake_pct=0.1),
            RiskConfig(stop_loss_pct=0.2, max_stake_pct=0.5, max_rounds=50),
        ).run()
        assert "stop-loss" in report.stop_reason
        assert report.rounds < 43

    async def test_driver_error_stops_cleanly(self):
        driver = ScriptedDriver([P, P])
        report = await build(driver, risk_config=RiskConfig(max_rounds=10)).run()
        assert "driver error" in report.stop_reason

    async def test_unplaceable_bet_stops_instead_of_spinning(self):
        driver = ScriptedDriver([P, P, P] + [B] * 10, balance=100.0)
        report = await build(
            driver, risk_config=RiskConfig(min_stake=50.0, max_rounds=20)
        ).run()
        assert "cannot place required bet" in report.stop_reason

    async def test_report_tracks_balance_and_roi(self):
        driver = ScriptedDriver([P, P, P, P])
        report = await build(driver, risk_config=RiskConfig(max_rounds=4)).run()
        assert report.ending_balance == pytest.approx(1010.0)
        assert report.roi == pytest.approx(0.01)
        assert len(report.records) == 4


class TestStakeDriverParsing:
    def test_reads_player_win(self):
        state = {"player": {"score": 8}, "banker": {"score": 5}}
        assert _outcome_from_state(state) is P

    def test_reads_banker_win(self):
        state = {"player": {"score": 2}, "banker": {"score": 9}}
        assert _outcome_from_state(state) is B

    def test_reads_tie(self):
        state = {"player": {"score": 7}, "banker": {"score": 7}}
        assert _outcome_from_state(state) is T

    def test_unreadable_state_raises(self):
        with pytest.raises(DriverError):
            _outcome_from_state({"player": {}})


@pytest.mark.asyncio
class TestStakeDriverGuards:
    async def test_dry_run_refuses_to_bet(self):
        driver = StakeDriver(client=object(), dry_run=True)
        with pytest.raises(DriverError, match="dry_run"):
            await driver.play_round(P, 1.0)

    async def test_watching_without_probe_stake_is_an_error(self):
        driver = StakeDriver(client=object(), dry_run=False, observe_stake=0.0)
        with pytest.raises(DriverError, match="no coup unless a bet is placed"):
            await driver.play_round(None, 0.0)

    async def test_balance_reads_the_configured_currency(self):
        class FakeClient:
            async def get_user_balance(self):
                return {"available": {"usdt": 12.5, "btc": 1.0}, "vault": {}}

        driver = StakeDriver(client=FakeClient(), currency="usdt")
        assert await driver.get_balance() == pytest.approx(12.5)
