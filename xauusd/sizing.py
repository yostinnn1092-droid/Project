"""
Position sizing from the BROKER'S OWN symbol specification.

Never assume XAUUSD is 100 oz a lot, that a pip is $1, or that the minimum
size is 0.01. Those vary by broker, by account currency and by symbol suffix,
and a wrong contract size scales every position by a constant factor — the
kind of error that turns a 0.5% risk into a 5% risk without anything looking
obviously broken.

`SymbolSpec` is populated from the venue (MT5's `symbol_info`) and passed in.
Nothing downstream guesses.

THE RULE
--------
    risk_cash  = equity x risk_pct
    risk/lot   = (stop_distance / tick_size) x tick_value
    lots       = risk_cash / risk_per_lot

then rounded DOWN to the broker's volume step and clamped to its limits.
Rounding down matters: rounding up quietly exceeds the risk budget you set,
on every single trade.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class SymbolSpec:
    """Everything the sizer needs, straight from the broker."""

    name: str
    digits: int
    point: float             # smallest price increment, e.g. 0.01 for XAUUSD
    tick_size: float         # price increment used for tick_value
    tick_value: float        # account-currency P&L per tick per 1.0 lot
    contract_size: float     # units per lot (informational; sizing uses tick_value)
    volume_min: float
    volume_max: float
    volume_step: float
    stops_level_points: float = 0.0   # broker's minimum SL/TP distance
    freeze_level_points: float = 0.0

    @classmethod
    def from_mt5(cls, info) -> "SymbolSpec":
        """Build from an MT5 `symbol_info` object."""
        return cls(
            name=info.name,
            digits=int(info.digits),
            point=float(info.point),
            tick_size=float(info.trade_tick_size or info.point),
            tick_value=float(info.trade_tick_value),
            contract_size=float(info.trade_contract_size),
            volume_min=float(info.volume_min),
            volume_max=float(info.volume_max),
            volume_step=float(info.volume_step),
            stops_level_points=float(getattr(info, "trade_stops_level", 0) or 0),
            freeze_level_points=float(getattr(info, "trade_freeze_level", 0) or 0),
        )

    @classmethod
    def demo_xauusd(cls) -> "SymbolSpec":
        """A PLACEHOLDER for offline testing only.

        Values resemble a common XAUUSD contract (100 oz, $1 per $0.01 move).
        They are NOT authoritative for any broker. Live and demo runs must
        pull the real spec; this exists so the backtest can run without a
        terminal attached.
        """
        return cls(
            name="XAUUSD", digits=2, point=0.01, tick_size=0.01,
            tick_value=1.0, contract_size=100.0,
            volume_min=0.01, volume_max=100.0, volume_step=0.01,
            stops_level_points=0.0,
        )


@dataclass(frozen=True)
class SizingResult:
    lots: float
    risk_cash: float
    risk_per_lot: float
    stop_distance: float
    capped_by: str | None  # None | "volume_min" | "volume_max" | "exposure"
    rejected_reason: str | None = None

    @property
    def ok(self) -> bool:
        return self.rejected_reason is None and self.lots > 0


def round_to_step(value: float, step: float) -> float:
    """Round DOWN to the broker's volume step.

    Down, never nearest: rounding up exceeds the risk budget on every trade,
    and the excess compounds across a strategy's lifetime.
    """
    if step <= 0:
        return value
    return int(value / step) * step


def position_size(
    equity: float,
    entry_price: float,
    stop_price: float,
    spec: SymbolSpec,
    risk_pct: float,
    max_total_exposure: float = 1.0,
    open_exposure_lots: float = 0.0,
) -> SizingResult:
    """Lots to risk exactly `risk_pct` of equity if the stop is hit."""
    stop_distance = abs(entry_price - stop_price)
    risk_cash = equity * (risk_pct / 100.0)

    if stop_distance <= 0:
        return SizingResult(0.0, risk_cash, 0.0, stop_distance, None,
                            "stop equals entry")
    if equity <= 0:
        return SizingResult(0.0, 0.0, 0.0, stop_distance, None, "no equity")

    # Broker minimum stop distance, where the venue enforces one.
    if spec.stops_level_points > 0:
        min_dist = spec.stops_level_points * spec.point
        if stop_distance < min_dist:
            return SizingResult(
                0.0, risk_cash, 0.0, stop_distance, None,
                f"stop {stop_distance:.2f} inside broker minimum {min_dist:.2f}")

    ticks = stop_distance / spec.tick_size
    risk_per_lot = ticks * spec.tick_value
    if risk_per_lot <= 0:
        return SizingResult(0.0, risk_cash, 0.0, stop_distance, None,
                            "non-positive risk per lot; check tick_value")

    raw = risk_cash / risk_per_lot
    lots = round_to_step(raw, spec.volume_step)
    capped: str | None = None

    # Exposure ceiling. Notional per lot is approximated from the entry price
    # and contract size; this is a guard rail, not a margin calculation.
    if max_total_exposure > 0 and spec.contract_size > 0:
        notional_per_lot = entry_price * spec.contract_size
        max_lots_by_exposure = (equity * max_total_exposure) / notional_per_lot
        remaining = max_lots_by_exposure - open_exposure_lots
        if lots > remaining:
            lots = round_to_step(max(remaining, 0.0), spec.volume_step)
            capped = "exposure"

    if lots < spec.volume_min:
        # Do NOT round up to the minimum: that would silently take more risk
        # than the config permits. Skipping the trade is the correct answer.
        return SizingResult(
            0.0, risk_cash, risk_per_lot, stop_distance, "volume_min",
            f"required {raw:.4f} lots below broker minimum {spec.volume_min}; "
            f"taking it would exceed the {risk_pct}% risk budget")

    if lots > spec.volume_max:
        lots = spec.volume_max
        capped = "volume_max"

    return SizingResult(lots, risk_cash, risk_per_lot, stop_distance, capped)


def realised_risk_pct(lots: float, stop_distance: float, spec: SymbolSpec,
                      equity: float) -> float:
    """Actual risk the sized position carries, after rounding.

    Rounding to the volume step means intended and actual risk differ. The
    journal records this so "we risked 0.5%" is a measurement rather than an
    assumption.
    """
    if equity <= 0:
        return 0.0
    risk = (stop_distance / spec.tick_size) * spec.tick_value * lots
    return 100.0 * risk / equity
