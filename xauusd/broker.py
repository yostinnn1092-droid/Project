"""
Broker abstraction: paper (demo) and MT5.

The strategy never talks to a broker directly. It emits intent — direction,
stop, targets, risk — and an adapter turns that into orders. Swapping venues
is therefore a config change, and the SAME strategy object drives backtest,
demo and live, so a discrepancy between them cannot come from a difference in
strategy code.

SAFETY POSTURE
--------------
`mode` must be "live" AND `live_confirm` must equal the exact phrase before
any adapter will place a real order. Defaulting to demo is not enough on its
own — a config file copied from an example would happily go live. The
confirmation phrase makes it a deliberate act.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timezone

import pandas as pd

from .config import BotConfig
from .sizing import SymbolSpec

LIVE_PHRASE = "I ACCEPT LIVE TRADING RISK"


@dataclass
class Position:
    ticket: int
    symbol: str
    direction: int
    lots: float
    entry: float
    stop: float
    tp: float
    opened: datetime


@dataclass
class OrderResult:
    ok: bool
    ticket: int | None = None
    price: float | None = None
    lots: float | None = None
    error: str | None = None


class Broker(ABC):
    @abstractmethod
    def symbol_spec(self, symbol: str) -> SymbolSpec: ...

    @abstractmethod
    def equity(self) -> float: ...

    @abstractmethod
    def bars(self, symbol: str, timeframe: str, count: int) -> pd.DataFrame: ...

    @abstractmethod
    def spread_points(self, symbol: str) -> float: ...

    @abstractmethod
    def positions(self, symbol: str) -> list[Position]: ...

    @abstractmethod
    def open(self, symbol: str, direction: int, lots: float,
             stop: float, tp: float, comment: str) -> OrderResult: ...

    @abstractmethod
    def modify(self, ticket: int, stop: float | None, tp: float | None) -> OrderResult: ...

    @abstractmethod
    def close(self, ticket: int, lots: float | None = None) -> OrderResult: ...


# ----------------------------------------------------------------------
@dataclass
class PaperBrokerAdapter(Broker):
    """Simulated fills against bars you supply. No money at risk.

    Run this against a LIVE data feed for weeks before considering the MT5
    adapter. A backtest cannot fail to receive a price; this can, and the
    failures it exposes — stale bars, restarts, gaps — are the ones that
    actually break live systems.
    """

    data: pd.DataFrame
    starting_equity: float = 10_000.0
    spec: SymbolSpec = field(default_factory=SymbolSpec.demo_xauusd)
    spread: float = 20.0
    _equity: float = field(init=False)
    _positions: dict[int, Position] = field(default_factory=dict)
    _next_ticket: int = 1
    _cursor: int = 0

    def __post_init__(self) -> None:
        self._equity = self.starting_equity

    def symbol_spec(self, symbol: str) -> SymbolSpec:
        return self.spec

    def equity(self) -> float:
        return self._equity

    def bars(self, symbol: str, timeframe: str, count: int) -> pd.DataFrame:
        end = min(self._cursor + 1, len(self.data))
        return self.data.iloc[max(0, end - count):end].reset_index(drop=True)

    def spread_points(self, symbol: str) -> float:
        return self.spread

    def positions(self, symbol: str) -> list[Position]:
        return [p for p in self._positions.values() if p.symbol == symbol]

    def open(self, symbol, direction, lots, stop, tp, comment) -> OrderResult:
        px = float(self.data["close"].iloc[self._cursor])
        # Always cross the spread — a paper broker filling at mid flatters
        # every strategy tested on it.
        fill = px + direction * (self.spread * self.spec.point) / 2
        t = self._next_ticket
        self._next_ticket += 1
        self._positions[t] = Position(t, symbol, direction, lots, fill, stop, tp,
                                      datetime.now(timezone.utc))
        return OrderResult(True, t, fill, lots)

    def modify(self, ticket, stop, tp) -> OrderResult:
        p = self._positions.get(ticket)
        if p is None:
            return OrderResult(False, error="unknown ticket")
        if stop is not None:
            p.stop = stop
        if tp is not None:
            p.tp = tp
        return OrderResult(True, ticket)

    def close(self, ticket, lots=None) -> OrderResult:
        p = self._positions.get(ticket)
        if p is None:
            return OrderResult(False, error="unknown ticket")
        px = float(self.data["close"].iloc[self._cursor])
        fill = px - p.direction * (self.spread * self.spec.point) / 2
        qty = min(lots or p.lots, p.lots)
        pnl = ((fill - p.entry) * p.direction / self.spec.tick_size) * self.spec.tick_value * qty
        self._equity += pnl
        if qty >= p.lots:
            del self._positions[ticket]
        else:
            p.lots -= qty
        return OrderResult(True, ticket, fill, qty)

    def advance(self) -> bool:
        self._cursor += 1
        return self._cursor < len(self.data)


# ----------------------------------------------------------------------
class MT5Broker(Broker):
    """MetaTrader 5 adapter.

    Requires the `MetaTrader5` package and a running terminal:

        pip install MetaTrader5

    Symbol specifications are read from the terminal — contract size, tick
    value, volume step, stops level — never assumed. That is the difference
    between sizing correctly and sizing by a constant factor error.

    CHECKLIST BEFORE LIVE (each item is a documented way people lose money):

      * IDEMPOTENCY — a timeout is not a rejection. Tag orders with the magic
        number and reconcile before retrying, or one intended entry becomes
        three.
      * RECONCILIATION — read positions from the terminal on every start.
        Never trust local state across a restart.
      * PARTIAL FILLS — requested volume is not filled volume.
      * PRECISION — round prices to `digits` and volumes to `volume_step`, or
        the server rejects the order.
      * STOPS LEVEL — brokers refuse stops closer than `trade_stops_level`.
      * WEEKEND / ROLLOVER — do not send orders into a closed session.
      * KILL SWITCH — a way to flatten that does not require the bot to be
        healthy, because you will need it when it is not.
      * CREDENTIALS — never in source. Environment or a secrets manager.
    """

    def __init__(self, config: BotConfig):
        self.cfg = config
        self._mt5 = None
        self._connected = False

    def connect(self, login: int | None = None, password: str | None = None,
                server: str | None = None, path: str | None = None) -> bool:
        try:
            import MetaTrader5 as mt5  # noqa: N813
        except ImportError as exc:  # pragma: no cover - environment dependent
            raise ImportError(
                "MetaTrader5 package not installed. `pip install MetaTrader5` "
                "(Windows, with a running MT5 terminal)."
            ) from exc

        self._mt5 = mt5
        kw = {k: v for k, v in
              dict(login=login, password=password, server=server, path=path).items()
              if v is not None}
        if not mt5.initialize(**kw):
            raise RuntimeError(f"MT5 initialize failed: {mt5.last_error()}")

        if not mt5.symbol_select(self.cfg.execution.symbol, True):
            raise RuntimeError(f"cannot select symbol {self.cfg.execution.symbol}")

        self._connected = True
        return True

    def _guard_live(self) -> None:
        x = self.cfg.execution
        if x.mode == "live" and x.live_confirm != LIVE_PHRASE:
            raise PermissionError(
                "live mode requires execution.live_confirm == "
                f"{LIVE_PHRASE!r}. Refusing to place real orders."
            )
        if x.mode == "backtest":
            raise PermissionError("broker calls are not permitted in backtest mode")

    def symbol_spec(self, symbol: str) -> SymbolSpec:
        info = self._mt5.symbol_info(symbol)
        if info is None:
            raise RuntimeError(f"no symbol_info for {symbol}")
        return SymbolSpec.from_mt5(info)

    def equity(self) -> float:
        acc = self._mt5.account_info()
        if acc is None:
            raise RuntimeError("no account_info")
        return float(acc.equity)

    def bars(self, symbol: str, timeframe: str, count: int) -> pd.DataFrame:
        tf = {
            "M1": self._mt5.TIMEFRAME_M1, "M5": self._mt5.TIMEFRAME_M5,
            "M15": self._mt5.TIMEFRAME_M15, "M30": self._mt5.TIMEFRAME_M30,
            "H1": self._mt5.TIMEFRAME_H1, "H4": self._mt5.TIMEFRAME_H4,
            "D1": self._mt5.TIMEFRAME_D1,
        }[timeframe]
        # start_pos=1 skips the still-forming bar. Including it would mean
        # deciding on a candle whose high, low and close are not yet final.
        rates = self._mt5.copy_rates_from_pos(symbol, tf, 1, count)
        if rates is None or len(rates) == 0:
            raise RuntimeError(f"no rates for {symbol} {timeframe}")
        df = pd.DataFrame(rates)
        df["timestamp"] = pd.to_datetime(df["time"], unit="s")
        return df.rename(columns={"tick_volume": "volume"})[
            ["timestamp", "open", "high", "low", "close", "volume"]]

    def spread_points(self, symbol: str) -> float:
        t = self._mt5.symbol_info_tick(symbol)
        info = self._mt5.symbol_info(symbol)
        if t is None or info is None:
            return float("inf")
        return (t.ask - t.bid) / info.point

    def positions(self, symbol: str) -> list[Position]:
        pos = self._mt5.positions_get(symbol=symbol) or []
        return [
            Position(
                ticket=p.ticket, symbol=p.symbol,
                direction=1 if p.type == self._mt5.POSITION_TYPE_BUY else -1,
                lots=float(p.volume), entry=float(p.price_open),
                stop=float(p.sl), tp=float(p.tp),
                opened=datetime.fromtimestamp(p.time, tz=timezone.utc),
            )
            for p in pos
            if p.magic == self.cfg.execution.magic_number
        ]

    def open(self, symbol, direction, lots, stop, tp, comment) -> OrderResult:
        self._guard_live()
        mt5 = self._mt5
        info = mt5.symbol_info(symbol)
        tick = mt5.symbol_info_tick(symbol)
        price = tick.ask if direction > 0 else tick.bid

        req = {
            "action": mt5.TRADE_ACTION_DEAL,
            "symbol": symbol,
            "volume": round(lots, 2),
            "type": mt5.ORDER_TYPE_BUY if direction > 0 else mt5.ORDER_TYPE_SELL,
            "price": price,
            "sl": round(stop, info.digits),
            "tp": round(tp, info.digits),
            "deviation": self.cfg.execution.deviation_points,
            "magic": self.cfg.execution.magic_number,
            "comment": comment[:31],
            "type_time": mt5.ORDER_TIME_GTC,
            "type_filling": mt5.ORDER_FILLING_IOC,
        }
        res = mt5.order_send(req)
        if res is None or res.retcode != mt5.TRADE_RETCODE_DONE:
            return OrderResult(False, error=f"order_send failed: "
                                            f"{getattr(res, 'retcode', None)} "
                                            f"{mt5.last_error()}")
        return OrderResult(True, res.order, float(res.price), float(res.volume))

    def modify(self, ticket, stop, tp) -> OrderResult:
        self._guard_live()
        mt5 = self._mt5
        pos = next((p for p in mt5.positions_get() or [] if p.ticket == ticket), None)
        if pos is None:
            return OrderResult(False, error="position not found")
        info = mt5.symbol_info(pos.symbol)
        req = {
            "action": mt5.TRADE_ACTION_SLTP,
            "position": ticket,
            "symbol": pos.symbol,
            "sl": round(stop if stop is not None else pos.sl, info.digits),
            "tp": round(tp if tp is not None else pos.tp, info.digits),
        }
        res = mt5.order_send(req)
        ok = res is not None and res.retcode == mt5.TRADE_RETCODE_DONE
        return OrderResult(ok, ticket, error=None if ok else str(mt5.last_error()))

    def close(self, ticket, lots=None) -> OrderResult:
        self._guard_live()
        mt5 = self._mt5
        pos = next((p for p in mt5.positions_get() or [] if p.ticket == ticket), None)
        if pos is None:
            return OrderResult(False, error="position not found")
        tick = mt5.symbol_info_tick(pos.symbol)
        is_buy = pos.type == mt5.POSITION_TYPE_BUY
        req = {
            "action": mt5.TRADE_ACTION_DEAL,
            "symbol": pos.symbol,
            "volume": round(lots or pos.volume, 2),
            "type": mt5.ORDER_TYPE_SELL if is_buy else mt5.ORDER_TYPE_BUY,
            "position": ticket,
            "price": tick.bid if is_buy else tick.ask,
            "deviation": self.cfg.execution.deviation_points,
            "magic": self.cfg.execution.magic_number,
            "type_time": mt5.ORDER_TIME_GTC,
            "type_filling": mt5.ORDER_FILLING_IOC,
        }
        res = mt5.order_send(req)
        ok = res is not None and res.retcode == mt5.TRADE_RETCODE_DONE
        return OrderResult(ok, ticket, error=None if ok else str(mt5.last_error()))

    def shutdown(self) -> None:
        if self._mt5 is not None and self._connected:
            self._mt5.shutdown()
            self._connected = False
