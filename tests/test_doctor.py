"""Tests for the preflight checks."""

import pytest

from baccarat_bot.config import BotConfig, StakeCredentials
from baccarat_bot.doctor import (
    FAIL,
    OK,
    WARN,
    check_credentials,
    check_mutation,
    check_observe_stake,
    render,
)


def config_for(**kwargs) -> BotConfig:
    config = BotConfig()
    config.credentials = StakeCredentials(**kwargs)
    return config


class TestCredentialChecks:
    def test_missing_token_fails(self):
        checks = check_credentials(config_for(base_url="https://stake.us"))
        token = next(c for c in checks if c.name == "access token")
        assert token.status is FAIL or token.status == FAIL

    def test_stake_us_does_not_require_cloudflare(self):
        checks = check_credentials(
            config_for(access_token="t", base_url="https://stake.us")
        )
        assert not any(c.name == "cf_clearance" for c in checks)

    def test_stake_com_requires_cloudflare(self):
        checks = check_credentials(
            config_for(access_token="t", base_url="https://stake.com")
        )
        cf = next(c for c in checks if c.name == "cf_clearance")
        assert cf.status == FAIL

    def test_stake_com_warns_about_ip_binding(self):
        checks = check_credentials(
            config_for(
                access_token="t",
                cf_clearance="c",
                user_agent="ua",
                base_url="https://stake.com",
            )
        )
        ip = next(c for c in checks if c.name == "same-IP requirement")
        assert ip.status == WARN
        assert "cloud container" in ip.fix

    def test_complete_stake_com_credentials_pass(self):
        checks = check_credentials(
            config_for(
                access_token="t",
                cf_clearance="c",
                user_agent="ua",
                base_url="https://stake.com",
            )
        )
        blocking = [c for c in checks if c.status == FAIL]
        assert blocking == []


class TestMutationCheck:
    def test_default_guess_warns(self):
        assert check_mutation().status == WARN


class TestObserveStakeCheck:
    def test_zero_observe_stake_fails(self):
        config = BotConfig()
        config.observe_stake = 0.0
        assert check_observe_stake(config).status == FAIL

    def test_positive_observe_stake_passes(self):
        config = BotConfig()
        config.observe_stake = 0.1
        assert check_observe_stake(config).status == OK


class TestRender:
    def test_blocking_problems_are_counted(self):
        checks = check_credentials(config_for(base_url="https://stake.com"))
        output = render(checks, ready=False)
        assert "blocking problem" in output

    def test_fix_hints_are_shown_for_failures(self):
        checks = check_credentials(config_for(base_url="https://stake.com"))
        assert "->" in render(checks, ready=False)

    def test_passing_run_says_so(self):
        from baccarat_bot.doctor import Check

        checks = [Check("a", OK, "fine"), Check("b", OK, "fine")]
        assert "All checks passed." in render(checks, ready=True)

    def test_warnings_are_surfaced_even_when_ready(self):
        from baccarat_bot.doctor import Check

        checks = [Check("a", OK, "fine"), Check("b", WARN, "iffy", "do x")]
        assert "warning(s)" in render(checks, ready=True)
