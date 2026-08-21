"""Configuration loading from environment / .env."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from .risk import RiskConfig
from .strategy import Direction, StrategyConfig


def load_dotenv(path: str = ".env") -> None:
    """Minimal .env loader; existing environment variables win."""
    env_path = Path(path)
    if not env_path.is_file():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip("'\""))


def _f(name: str, default: float) -> float:
    raw = os.getenv(name)
    return float(raw) if raw not in (None, "") else default


def _i(name: str, default: int) -> int:
    raw = os.getenv(name)
    return int(raw) if raw not in (None, "") else default


@dataclass
class StakeCredentials:
    """Credentials for the live driver."""

    access_token: Optional[str] = None
    cf_clearance: Optional[str] = None
    user_agent: Optional[str] = None
    base_url: str = "https://stake.com"
    currency: str = "usdt"

    @classmethod
    def from_env(cls) -> "StakeCredentials":
        return cls(
            access_token=os.getenv("STAKE_ACCESS_TOKEN") or None,
            cf_clearance=os.getenv("STAKE_CF_CLEARANCE") or None,
            user_agent=os.getenv("STAKE_USER_AGENT") or None,
            base_url=os.getenv("STAKE_BASE_URL", "https://stake.com"),
            currency=os.getenv("STAKE_CURRENCY", "usdt").lower(),
        )

    def validate(self) -> None:
        if not self.access_token:
            raise ValueError("STAKE_ACCESS_TOKEN is required for the live driver")
        if "stake.com" in self.base_url and not self.cf_clearance:
            raise ValueError(
                "stake.com requires STAKE_CF_CLEARANCE (and a matching "
                "STAKE_USER_AGENT); stake.us works with the token alone"
            )


@dataclass
class BotConfig:
    """Everything a session needs."""

    strategy: StrategyConfig = field(default_factory=StrategyConfig)
    risk: RiskConfig = field(default_factory=RiskConfig)
    credentials: StakeCredentials = field(default_factory=StakeCredentials)
    paper_balance: float = 1000.0
    delay: float = 1.5
    observe_stake: float = 0.0

    @classmethod
    def from_env(cls) -> "BotConfig":
        load_dotenv()
        strategy = StrategyConfig(
            streak_length=_i("BOT_STREAK_LENGTH", 3),
            stake_pct=_f("BOT_STAKE_PCT", 0.01),
            direction=Direction(os.getenv("BOT_DIRECTION", "follow")),
            martingale_steps=_i("BOT_MARTINGALE_STEPS", 1),
            martingale_multiplier=_f("BOT_MARTINGALE_MULTIPLIER", 2.0),
            retrigger=os.getenv("BOT_RETRIGGER", "new_run"),
            stake_base=os.getenv("BOT_STAKE_BASE", "current"),
        )
        risk = RiskConfig(
            stop_loss_pct=_f("BOT_STOP_LOSS_PCT", 0.20),
            take_profit_pct=_f("BOT_TAKE_PROFIT_PCT", 0.0),
            max_rounds=_i("BOT_MAX_ROUNDS", 0),
            max_bets=_i("BOT_MAX_BETS", 0),
            max_stake_pct=_f("BOT_MAX_STAKE_PCT", 0.10),
            min_stake=_f("BOT_MIN_STAKE", 0.0),
            stake_precision=_i("BOT_STAKE_PRECISION", 8),
        )
        return cls(
            strategy=strategy,
            risk=risk,
            credentials=StakeCredentials.from_env(),
            paper_balance=_f("BOT_PAPER_BALANCE", 1000.0),
            delay=_f("BOT_DELAY", 1.5),
            observe_stake=_f("BOT_OBSERVE_STAKE", 0.0),
        )
