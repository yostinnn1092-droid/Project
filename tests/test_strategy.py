"""Tests for the streak trigger and martingale sequencing."""

import pytest

from baccarat_bot.shoe import Outcome
from baccarat_bot.strategy import (
    Direction,
    Stage,
    StreakMartingale,
    StreakTracker,
    StrategyConfig,
)

P, B, T = Outcome.PLAYER, Outcome.BANKER, Outcome.TIE
BANKROLL = 1000.0


def feed(strategy, outcomes):
    """Play a scripted sequence, returning the bet placed on each coup."""
    placed = []
    for outcome in outcomes:
        decision = strategy.decide(BANKROLL, BANKROLL)
        placed.append(decision)
        strategy.observe(outcome)
    return placed


class TestStreakTracker:
    def test_counts_consecutive_sides(self):
        tracker = StreakTracker()
        for outcome in (P, P, P):
            tracker.observe(outcome)
        assert (tracker.side, tracker.length) == (P, 3)

    def test_tie_does_not_break_or_extend_a_run(self):
        tracker = StreakTracker()
        for outcome in (P, P, T, P):
            tracker.observe(outcome)
        assert (tracker.side, tracker.length) == (P, 3)

    def test_opposite_side_starts_a_new_run(self):
        tracker = StreakTracker()
        for outcome in (P, P, P, B):
            tracker.observe(outcome)
        assert (tracker.side, tracker.length) == (B, 1)
        assert tracker.run_id == 2


class TestTrigger:
    def test_no_bet_before_three_in_a_row(self):
        strategy = StreakMartingale()
        placed = feed(strategy, [P, P])
        assert placed == [None, None]

    def test_bets_on_the_coup_after_three_in_a_row(self):
        strategy = StreakMartingale()
        placed = feed(strategy, [P, P, P, B])
        assert placed[:3] == [None, None, None]
        assert placed[3] is not None
        assert placed[3].side is P
        assert placed[3].stage is Stage.BASE

    def test_tie_interrupted_run_still_triggers(self):
        strategy = StreakMartingale()
        placed = feed(strategy, [B, B, T, B, P])
        # The tie is transparent, so the fourth coup completes B,B,B.
        assert placed[4] is not None
        assert placed[4].side is B

    def test_stake_is_one_percent_of_bankroll(self):
        strategy = StreakMartingale()
        placed = feed(strategy, [P, P, P, B])
        assert placed[3].stake == pytest.approx(BANKROLL * 0.01)

    def test_against_direction_bets_the_other_side(self):
        strategy = StreakMartingale(StrategyConfig(direction=Direction.AGAINST))
        placed = feed(strategy, [P, P, P, B])
        assert placed[3].side is B


class TestMartingale:
    def test_win_resets_without_martingale(self):
        strategy = StreakMartingale()
        placed = feed(strategy, [P, P, P, P, P])
        assert placed[3].stage is Stage.BASE          # bet placed, wins
        assert placed[4] is None                      # run already spent

    def test_loss_doubles_once_on_the_next_coup(self):
        strategy = StreakMartingale()
        placed = feed(strategy, [P, P, P, B, B])
        assert placed[3].stake == pytest.approx(10.0)
        assert placed[4].stage is Stage.MARTINGALE
        assert placed[4].stake == pytest.approx(20.0)
        assert placed[4].side is P                    # same side as the base bet

    def test_two_losses_stand_down_and_wait_for_a_new_run(self):
        strategy = StreakMartingale()
        # P,P,P triggers; two banker results lose both steps.
        placed = feed(strategy, [P, P, P, B, B, B, B])
        assert placed[4].stage is Stage.MARTINGALE
        assert placed[5] is None                      # sequence over, standing down
        # Bankers now have their own run of three (coups 4,5,6) -> re-arm.
        assert placed[6] is not None
        assert placed[6].side is B
        assert placed[6].stage is Stage.BASE

    def test_tie_pushes_without_consuming_the_martingale_step(self):
        strategy = StreakMartingale()
        placed = feed(strategy, [P, P, P, T, T, B, B])
        assert placed[3].stage is Stage.BASE
        assert placed[4].stage is Stage.BASE          # push, same stage
        assert placed[4].stake == pytest.approx(placed[3].stake)
        assert placed[5].stage is Stage.BASE          # still the base bet
        assert placed[6].stage is Stage.MARTINGALE    # only the loss advances it
        assert placed[6].stake == pytest.approx(20.0)

    def test_martingale_can_be_disabled(self):
        strategy = StreakMartingale(StrategyConfig(martingale_steps=0))
        placed = feed(strategy, [P, P, P, B, B])
        assert placed[3] is not None
        assert placed[4] is None                      # loss ends the sequence

    def test_extra_steps_keep_doubling(self):
        strategy = StreakMartingale(StrategyConfig(martingale_steps=2))
        placed = feed(strategy, [P, P, P, B, B, B])
        assert [p.stake for p in placed[3:6]] == pytest.approx([10.0, 20.0, 40.0])


class TestRetrigger:
    def test_new_run_policy_does_not_rearm_on_the_same_run(self):
        strategy = StreakMartingale()
        placed = feed(strategy, [P] * 8)
        # Only the coup right after the first three players is wagered.
        assert sum(1 for p in placed if p is not None) == 1

    def test_every_n_policy_rearms_every_three(self):
        strategy = StreakMartingale(StrategyConfig(retrigger="every_n"))
        placed = feed(strategy, [P] * 7)
        # Runs of 3 and 6 both arm a bet.
        assert [i for i, p in enumerate(placed) if p is not None] == [3, 6]


class TestStakeBase:
    def test_session_base_keeps_the_stake_flat(self):
        strategy = StreakMartingale(StrategyConfig(stake_base="session"))
        strategy.decide(500.0, BANKROLL)
        for outcome in (P, P, P):
            strategy.observe(outcome)
        decision = strategy.decide(500.0, BANKROLL)
        assert decision.stake == pytest.approx(BANKROLL * 0.01)

    def test_current_base_scales_with_the_bankroll(self):
        strategy = StreakMartingale()
        for outcome in (P, P, P):
            strategy.observe(outcome)
        decision = strategy.decide(500.0, BANKROLL)
        assert decision.stake == pytest.approx(5.0)


class TestUnplacedBets:
    def test_unsettled_bet_keeps_the_sequence_at_its_stage(self):
        strategy = StreakMartingale()
        feed(strategy, [P, P, P])
        first = strategy.decide(BANKROLL, BANKROLL)
        assert first.stage is Stage.BASE
        strategy.observe(B, bet_settled=False)        # blocked by risk limits
        second = strategy.decide(BANKROLL, BANKROLL)
        assert second.stage is Stage.BASE             # not advanced by the loss
        assert second.stake == pytest.approx(first.stake)


class TestConfigValidation:
    @pytest.mark.parametrize(
        "kwargs",
        [
            {"streak_length": 0},
            {"stake_pct": 0},
            {"stake_pct": 1.5},
            {"martingale_steps": -1},
            {"martingale_multiplier": 1.0},
            {"retrigger": "sometimes"},
            {"stake_base": "yesterday"},
        ],
    )
    def test_bad_config_is_rejected(self, kwargs):
        with pytest.raises(ValueError):
            StrategyConfig(**kwargs)
