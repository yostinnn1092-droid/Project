"""
Configuration for the XAUUSD trend-pullback system.

Every tunable lives here. Nothing is hard-coded in the strategy, the sizing,
or the execution layer, so a change of broker, risk appetite or timeframe is
a config edit rather than a code edit — and so the exact parameter set behind
any result can be serialised alongside it.

DEFAULTS ARE CONSERVATIVE ON PURPOSE. They are starting points for testing,
not recommended settings. No value here has been optimised against historical
data, because a config tuned to maximise a backtest is a config fitted to
noise; see `docs/` and the repo README for what that costs.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path


@dataclass
class RegimeConfig:
    """H4 trend-regime filter."""

    ema_fast: int = 50
    ema_slow: int = 200
    adx_period: int = 14
    #: Below this, the market is treated as ranging and the answer is NO TRADE.
    adx_min: float = 20.0
    #: Above this, trend is extended enough that pullback entries often become
    #: reversal entries. Set to None to disable the upper guard.
    adx_max: float | None = 50.0


@dataclass
class EntryConfig:
    """H1 pullback-and-rejection entry."""

    ema_trend: int = 200      # H1 trend filter
    ema_fast: int = 20        # pullback zone, near edge
    ema_slow: int = 50        # pullback zone, far edge
    #: How close price must come to the EMA zone, as a multiple of ATR.
    #: Touching is not required and not sufficient — see `signals.py`.
    zone_atr_mult: float = 0.75
    #: Bars the pullback may take before the setup is considered stale.
    pullback_max_bars: int = 12
    #: Bars over which the pullback-and-rejection may unfold. Requiring the
    #: dip and the rejection close on ONE candle is a rare shape and starves
    #: the system (measured: 1 trade in 10,640 bars). 3 is a normal reading.
    rejection_window: int = 3

    rsi_period: int = 14
    use_rsi_filter: bool = True
    rsi_long_min: float = 40.0
    rsi_long_max: float = 65.0
    rsi_short_min: float = 35.0
    rsi_short_max: float = 60.0

    #: Reject entries whose candle body is a smaller fraction of its range
    #: than this — an indecisive close is not a confirmation.
    min_body_fraction: float = 0.35


@dataclass
class StructureConfig:
    """Swing detection and support/resistance filtering."""

    #: Bars either side required to confirm a swing. A swing is therefore only
    #: KNOWN `swing_lookback` bars after it forms; the code never treats it as
    #: known earlier.
    swing_lookback: int = 3
    #: How far back to search for structure.
    lookback_bars: int = 120
    #: Merge swing levels within this ATR multiple into one zone.
    zone_merge_atr: float = 0.5
    #: Bars searched for the swing that anchors the stop. Deliberately
    #: shorter than `lookback_bars` (which feeds S/R zones): the stop belongs
    #: to the structure being traded, not the widest swing in memory.
    stop_swing_window: int = 30
    #: Refuse longs whose distance to the next resistance is smaller than this
    #: multiple of the intended stop distance — i.e. no buying into a wall.
    min_headroom_r: float = 1.5


@dataclass
class RiskConfig:
    """Stops, targets and position sizing."""

    atr_period: int = 14
    #: Primary stop distance = ATR x this.
    atr_stop_mult: float = 1.8
    #: Extra room beyond the structural swing, as an ATR multiple.
    swing_buffer_atr: float = 0.25
    #: Hard ceiling on stop distance as an ATR multiple, so a structural stop
    #: on a wide bar cannot silently become an enormous risk.
    max_stop_atr_mult: float = 3.5

    take_profit_1_r: float = 1.5
    take_profit_2_r: float = 2.5
    #: Fraction of the position closed at TP1.
    tp1_close_fraction: float = 0.5
    #: Move the stop to entry (plus costs) once TP1 is filled.
    breakeven_after_tp1: bool = True
    breakeven_offset_r: float = 0.05

    #: Set to 1.0% by explicit instruction (the brief was truncated here).
    #:
    #: RISK PERCENT SCALES OUTCOMES; IT DOES NOT CREATE EDGE. Doubling this
    #: roughly doubles returns AND drawdowns, because every trade is sized
    #: proportionally. On a strategy with positive expectancy that is a
    #: choice about volatility tolerance. On one with negative expectancy it
    #: doubles the rate of loss and nothing else — sizing cannot repair a
    #: signal. This system's expectancy measured -0.035R, so read any change
    #: here as a change in how fast, not whether.
    risk_per_trade_pct: float = 1.0
    #: Hard cap on simultaneous exposure, as a multiple of equity. Not a
    #: target — a ceiling the sizing logic may never exceed.
    #:
    #: RAISED TO 2.0 SO THE 1% RISK SETTING IS ACTUALLY DELIVERABLE. Gold
    #: near $3,400 with a 1.8xATR stop (~$25) needs roughly 1.39x equity of
    #: notional to put 1% at risk. At a 1.0x cap the sizer silently clipped
    #: every trade to ~0.72% actual risk — safe, but not what the config
    #: claimed. 2.0x leaves headroom without permitting real leverage abuse;
    #: it is notional exposure, not margin, and gold CFDs are typically
    #: margined far above this.
    max_total_exposure: float = 2.0
    max_concurrent_positions: int = 1
    #: Refuse to trade once equity is this far below its high-water mark.
    max_drawdown_halt_pct: float = 20.0
    daily_loss_halt_pct: float = 4.0
    #: Bars a position may live before being closed regardless of P&L.
    max_hold_bars: int = 72


@dataclass
class ExecutionConfig:
    """Broker-facing settings."""

    symbol: str = "XAUUSD"
    timeframe: str = "H1"
    confirm_timeframe: str = "H4"

    #: DEMO BY DEFAULT. Live trading requires an explicit, deliberate change
    #: plus the confirmation phrase in `live_confirm`.
    mode: str = "demo"           # "backtest" | "demo" | "live"
    live_confirm: str = ""       # must equal "I ACCEPT LIVE TRADING RISK"

    #: Reject entries when the spread exceeds this multiple of median spread.
    max_spread_mult: float = 2.0
    #: Absolute ceiling in points, as a backstop when history is thin.
    max_spread_points: float = 50.0
    #: Slippage tolerance passed to the broker, in points.
    deviation_points: int = 20
    magic_number: int = 20260812

    #: Trade only on a CLOSED bar. Acting intrabar means acting on a price
    #: that may not exist by the time the bar completes.
    trade_on_bar_close_only: bool = True


@dataclass
class BotConfig:
    regime: RegimeConfig = field(default_factory=RegimeConfig)
    entry: EntryConfig = field(default_factory=EntryConfig)
    structure: StructureConfig = field(default_factory=StructureConfig)
    risk: RiskConfig = field(default_factory=RiskConfig)
    execution: ExecutionConfig = field(default_factory=ExecutionConfig)

    def to_json(self, path: str | Path) -> None:
        Path(path).write_text(json.dumps(asdict(self), indent=2), encoding="utf-8")

    @classmethod
    def from_json(cls, path: str | Path) -> "BotConfig":
        d = json.loads(Path(path).read_text(encoding="utf-8"))
        return cls(
            regime=RegimeConfig(**d.get("regime", {})),
            entry=EntryConfig(**d.get("entry", {})),
            structure=StructureConfig(**d.get("structure", {})),
            risk=RiskConfig(**d.get("risk", {})),
            execution=ExecutionConfig(**d.get("execution", {})),
        )

    def fingerprint(self) -> str:
        """Stable hash of the whole config, stamped into every journal entry.

        Reproducibility means being able to answer "what settings produced
        this trade?" months later. A hash in every log line answers it.
        """
        import hashlib

        blob = json.dumps(asdict(self), sort_keys=True).encode()
        return hashlib.sha256(blob).hexdigest()[:12]

    def validate(self) -> list[str]:
        """Return a list of problems. Empty list means the config is coherent."""
        p: list[str] = []
        r, e, x = self.risk, self.entry, self.execution

        if not 0 < r.risk_per_trade_pct <= 5:
            p.append(f"risk_per_trade_pct={r.risk_per_trade_pct} outside (0, 5]")
        if r.take_profit_1_r >= r.take_profit_2_r:
            p.append("take_profit_1_r must be less than take_profit_2_r")
        if not 0 < r.tp1_close_fraction < 1:
            p.append("tp1_close_fraction must be strictly between 0 and 1")
        if r.max_stop_atr_mult <= r.atr_stop_mult:
            p.append("max_stop_atr_mult must exceed atr_stop_mult")
        if r.max_total_exposure > 30:
            p.append(f"max_total_exposure={r.max_total_exposure} implies extreme leverage")
        if e.ema_fast >= e.ema_slow:
            p.append("entry.ema_fast must be shorter than entry.ema_slow")
        if e.ema_slow >= e.ema_trend:
            p.append("entry.ema_slow must be shorter than entry.ema_trend")
        if x.mode not in ("backtest", "demo", "live"):
            p.append(f"unknown mode {x.mode!r}")
        if x.mode == "live" and x.live_confirm != "I ACCEPT LIVE TRADING RISK":
            p.append("live mode requires execution.live_confirm to be set exactly")
        return p
