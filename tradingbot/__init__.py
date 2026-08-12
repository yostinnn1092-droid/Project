"""A minimal, honest trading-bot skeleton for learning.

Pipeline:  data -> strategy -> risk -> execution -> metrics
"""

from .backtest import BacktestResult, Costs, run
# NOTE: kronos_signal is NOT imported here — it needs torch + the Kronos
# source, which the core package deliberately does not depend on. Import it
# explicitly: `from tradingbot.kronos_signal import KronosSignal`.
from .broker import Broker, Fill, PaperBroker
from .data import load_csv, resample, synthetic, train_test_split, validate
from .risk import RiskLimits, RiskManager, position_size_from_stop
from .strategy import BuyAndHold, MeanReversion, SmaCrossover, Strategy

__all__ = [
    "BacktestResult",
    "Broker",
    "BuyAndHold",
    "Costs",
    "Fill",
    "MeanReversion",
    "PaperBroker",
    "RiskLimits",
    "RiskManager",
    "SmaCrossover",
    "Strategy",
    "load_csv",
    "position_size_from_stop",
    "resample",
    "run",
    "synthetic",
    "train_test_split",
    "validate",
]
