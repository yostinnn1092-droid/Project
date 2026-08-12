"""
XAUUSD H1 trend-pullback trading system.

    config.py      every tunable, serialisable, fingerprinted
    indicators.py  EMA / ATR / ADX / RSI — all strictly causal
    structure.py   swing points, S/R zones, headroom checks
    strategy.py    H4 regime -> H1 pullback -> rejection -> sized order
    sizing.py      risk-based lots from the BROKER'S symbol spec
    broker.py      paper and MT5 adapters behind one interface
    journal.py     every decision logged, including every no-trade

NO CLAIM OF PROFITABILITY IS MADE OR IMPLIED. The strategy encodes a
widely-used market hypothesis (trends persist; pullbacks into dynamic support
offer favourable entries). That hypothesis may be false, may have decayed, or
may not survive costs on your broker. Nothing here has been validated as
profitable, and this repo's own README documents fifteen strategies that
looked promising and were not.

Use `run_xauusd_backtest.py` to test it, then paper trade for weeks, then
consider small live size. In that order.
"""

from .config import (
    BotConfig,
    EntryConfig,
    ExecutionConfig,
    RegimeConfig,
    RiskConfig,
    StructureConfig,
)
from .journal import Decision, Journal
from .sizing import SizingResult, SymbolSpec, position_size
from .strategy import TrendPullbackStrategy

__all__ = [
    "BotConfig",
    "Decision",
    "EntryConfig",
    "ExecutionConfig",
    "Journal",
    "RegimeConfig",
    "RiskConfig",
    "SizingResult",
    "StructureConfig",
    "SymbolSpec",
    "TrendPullbackStrategy",
    "position_size",
]
