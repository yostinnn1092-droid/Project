"""Preflight checks for live play.

``baccarat-bot check`` walks the whole live path in order and reports what
is ready and what is not, so setup problems surface one at a time instead
of as a stack trace mid-session.
"""

from __future__ import annotations

import inspect
from typing import List, Optional, Tuple

from .config import BotConfig

OK, WARN, FAIL = "ok", "warn", "fail"

_MARK = {OK: "[ ok ]", WARN: "[warn]", FAIL: "[FAIL]"}


class Check:
    """One preflight result."""

    def __init__(self, name: str, status: str, detail: str, fix: str = "") -> None:
        self.name = name
        self.status = status
        self.detail = detail
        self.fix = fix

    def render(self) -> str:
        line = f"{_MARK[self.status]} {self.name}: {self.detail}"
        if self.fix and self.status != OK:
            line += f"\n         -> {self.fix}"
        return line


def check_package() -> Check:
    """Is a stakeapi with Cloudflare support installed?"""
    try:
        from stakeapi import StakeAPI
    except ImportError:
        return Check(
            "stakeapi installed",
            FAIL,
            "not installed",
            "pip install -e '.[live]'",
        )

    params = inspect.signature(StakeAPI.__init__).parameters
    if "cf_clearance" not in params:
        return Check(
            "stakeapi installed",
            FAIL,
            "PyPI build without Cloudflare support (no cf_clearance)",
            "pip install --force-reinstall 'stakeapi @ "
            "git+https://github.com/brokechubb/StakeAPI.git'",
        )
    return Check("stakeapi installed", OK, "GitHub build with cf_clearance support")


def check_credentials(config: BotConfig) -> List[Check]:
    """Are the credentials the chosen site needs actually present?"""
    creds = config.credentials
    checks = [
        Check(
            "access token",
            OK if creds.access_token else FAIL,
            "present" if creds.access_token else "missing",
            "set STAKE_ACCESS_TOKEN in .env (DevTools -> Network -> "
            "/_api/graphql -> x-access-token header)",
        ),
        Check("site", OK, creds.base_url),
    ]

    if "stake.com" in creds.base_url:
        checks.append(
            Check(
                "cf_clearance",
                OK if creds.cf_clearance else FAIL,
                "present" if creds.cf_clearance else "missing (stake.com needs it)",
                "set STAKE_CF_CLEARANCE in .env (DevTools -> Application -> "
                "Cookies -> stake.com -> cf_clearance)",
            )
        )
        checks.append(
            Check(
                "user agent",
                OK if creds.user_agent else FAIL,
                "present" if creds.user_agent else "missing (must match cf_clearance)",
                "set STAKE_USER_AGENT to the exact UA of the browser that "
                "obtained the cf_clearance cookie",
            )
        )
        checks.append(
            Check(
                "same-IP requirement",
                WARN,
                "cf_clearance is bound to the IP that solved the challenge",
                "run this bot on the same machine/network as that browser; "
                "a server or cloud container will be rejected",
            )
        )
    return checks


def check_mutation() -> Check:
    """Has the guessed baccarat mutation been replaced with a real one?"""
    from .drivers import stake as stake_driver

    source = stake_driver.BACCARAT_BET_MUTATION
    if "CasinoGameBaccarat" in source and "baccaratBet" in source:
        return Check(
            "baccarat mutation",
            WARN,
            "still the unverified default guess",
            "capture the real BaccaratBet operation from DevTools "
            "(Network -> /_api/graphql -> play one hand) and replace "
            "BACCARAT_BET_MUTATION in baccarat_bot/drivers/stake.py",
        )
    return Check("baccarat mutation", OK, "customized")


def check_observe_stake(config: BotConfig) -> Check:
    """Can the bot see coups it does not bet on?"""
    if config.observe_stake > 0:
        return Check(
            "observe stake",
            OK,
            f"{config.observe_stake} per watched coup",
        )
    return Check(
        "observe stake",
        FAIL,
        "0 -- the bot cannot observe coups without betting",
        "set BOT_OBSERVE_STAKE to the table minimum; Stake baccarat is an "
        "Originals game, so a coup only exists if you bet on it",
    )


async def check_connection(config: BotConfig) -> Check:
    """Do the credentials actually authenticate?"""
    try:
        from stakeapi import StakeAPI
    except ImportError:
        return Check("live connection", FAIL, "stakeapi not installed")

    creds = config.credentials
    if not creds.access_token:
        return Check("live connection", FAIL, "skipped -- no access token")

    kwargs = {"access_token": creds.access_token, "base_url": creds.base_url}
    params = inspect.signature(StakeAPI.__init__).parameters
    if "cf_clearance" in params:
        kwargs["cf_clearance"] = creds.cf_clearance
        kwargs["user_agent"] = creds.user_agent

    try:
        async with StakeAPI(**kwargs) as client:
            balances = await client.get_user_balance()
    except Exception as exc:  # noqa: BLE001 - report anything the API raises
        message = str(exc)
        if "403" in message:
            return Check(
                "live connection",
                FAIL,
                "Cloudflare returned 403 before the API saw the token",
                "cf_clearance is missing, expired, or was issued to a "
                "different IP/User-Agent than this machine",
            )
        if "session is invalid" in message.lower():
            return Check(
                "live connection",
                FAIL,
                "the API rejected the token",
                "the token is expired or belongs to the other site; "
                "log in again and copy a fresh x-access-token",
            )
        return Check("live connection", FAIL, message)

    available = balances.get("available", {})
    funded = {c: a for c, a in available.items() if a > 0}
    detail = "authenticated; " + (
        ", ".join(f"{c}={a}" for c, a in sorted(funded.items()))
        if funded
        else "no funded currencies"
    )
    return Check("live connection", OK, detail)


async def run_checks(config: BotConfig) -> Tuple[List[Check], bool]:
    """Run every preflight check in order."""
    checks: List[Check] = [check_package()]
    checks.extend(check_credentials(config))
    checks.append(await check_connection(config))
    checks.append(check_mutation())
    checks.append(check_observe_stake(config))
    ready = not any(c.status == FAIL for c in checks)
    return checks, ready


def render(checks: List[Check], ready: bool) -> str:
    lines = [c.render() for c in checks]
    lines.append("")
    if ready:
        warnings = [c for c in checks if c.status == WARN]
        if warnings:
            lines.append(
                f"Credentials work, but {len(warnings)} warning(s) above still "
                "stand between you and a sane live run."
            )
        else:
            lines.append("All checks passed.")
    else:
        failed = sum(1 for c in checks if c.status == FAIL)
        lines.append(f"{failed} blocking problem(s); live mode will not run.")
    return "\n".join(lines)
