"""A streak-triggered baccarat bot built on the StakeAPI wrapper."""

from .config import BotConfig, StakeCredentials
from .engine import BotEngine, SessionReport
from .risk import RiskConfig, RiskManager
from .shoe import Coup, Outcome, Shoe
from .strategy import Direction, Stage, StreakMartingale, StrategyConfig

__version__ = "0.1.0"

__all__ = [
    "BotConfig",
    "StakeCredentials",
    "BotEngine",
    "SessionReport",
    "RiskConfig",
    "RiskManager",
    "Coup",
    "Outcome",
    "Shoe",
    "Direction",
    "Stage",
    "StreakMartingale",
    "StrategyConfig",
    "__version__",
]
