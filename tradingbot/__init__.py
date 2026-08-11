"""A minimal, honest trading-bot skeleton for learning.

Pipeline:  data -> strategy -> risk -> execution -> metrics
"""

from .backtest import BacktestResult, Costs, run
from .broker import Broker, Fill, PaperBroker
from .data import load_csv, synthetic, train_test_split, validate
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
    "run",
    "synthetic",
    "train_test_split",
    "validate",
]
