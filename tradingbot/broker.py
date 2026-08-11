"""
Execution layer.

The backtester and the live bot must run the SAME strategy object. If they
don't, you are testing one system and trading another, and the backtest
tells you nothing about the thing holding your money.

So execution hides behind one small interface. Swapping `PaperBroker` for
`CcxtBroker` changes where the orders go and nothing else.

    Broker (abstract)
      ├── PaperBroker   simulated fills, no money at risk  <- live here for weeks
      └── CcxtBroker    real exchange via ccxt             <- only after that

Progression, in order, no skipping:

  1. BACKTEST      historical bars, instant, free. Catches logic errors.
  2. PAPER TRADE   live feed, simulated fills, real time. Catches the bugs
                   a backtest structurally cannot: stale data, API errors,
                   reconnects, clock drift, your own restart logic.
  3. LIVE, SMALL   real money, size so small the loss is tuition.
  4. LIVE          only after (3) matches (2) for a meaningful period.

Most blown-up retail bots skipped step 2. A backtest cannot fail to
receive a websocket message.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timezone


@dataclass
class Fill:
    timestamp: datetime
    symbol: str
    side: str  # "buy" | "sell"
    units: float
    price: float
    fee: float


class Broker(ABC):
    """Minimal surface a strategy runner needs."""

    @abstractmethod
    def get_price(self, symbol: str) -> float: ...

    @abstractmethod
    def get_position(self, symbol: str) -> float:
        """Signed units currently held. Negative = short."""

    @abstractmethod
    def get_equity(self) -> float: ...

    @abstractmethod
    def market_order(self, symbol: str, units: float) -> Fill:
        """Buy (units > 0) or sell (units < 0) at market."""

    def rebalance_to_weight(self, symbol: str, target_weight: float) -> Fill | None:
        """Move the position to `target_weight` of equity.

        Lives on the base class so paper and live rebalance identically —
        the one place where a discrepancy would be most expensive.
        """
        price = self.get_price(symbol)
        equity = self.get_equity()
        desired = (target_weight * equity) / price
        delta = desired - self.get_position(symbol)

        if abs(delta * price) < equity * 1e-4:  # dust
            return None
        return self.market_order(symbol, delta)


@dataclass
class PaperBroker(Broker):
    """Simulated fills against a live price you feed in.

    Deliberately pessimistic: you always cross the spread. A paper broker
    that fills at mid will flatter every strategy you test on it.
    """

    cash: float = 10_000.0
    commission: float = 0.0004
    slippage: float = 0.0002
    positions: dict[str, float] = field(default_factory=dict)
    fills: list[Fill] = field(default_factory=list)
    _prices: dict[str, float] = field(default_factory=dict)

    def set_price(self, symbol: str, price: float) -> None:
        """Push the latest price in from your data feed."""
        self._prices[symbol] = price

    def get_price(self, symbol: str) -> float:
        if symbol not in self._prices:
            raise RuntimeError(f"no price for {symbol}; call set_price first")
        return self._prices[symbol]

    def get_position(self, symbol: str) -> float:
        return self.positions.get(symbol, 0.0)

    def get_equity(self) -> float:
        return self.cash + sum(
            units * self._prices.get(sym, 0.0)
            for sym, units in self.positions.items()
        )

    def market_order(self, symbol: str, units: float) -> Fill:
        ref = self.get_price(symbol)
        direction = 1.0 if units > 0 else -1.0
        price = ref * (1 + self.slippage * direction)
        fee = abs(units * price) * self.commission

        self.cash -= units * price + fee
        self.positions[symbol] = self.positions.get(symbol, 0.0) + units

        fill = Fill(
            timestamp=datetime.now(timezone.utc),
            symbol=symbol,
            side="buy" if units > 0 else "sell",
            units=abs(units),
            price=price,
            fee=fee,
        )
        self.fills.append(fill)
        return fill


class CcxtBroker(Broker):
    """Real exchange orders via ccxt. NOT wired up — read before using.

        pip install ccxt
        exchange = ccxt.binance({"apiKey": ..., "secret": ...})
        exchange.set_sandbox_mode(True)   # testnet FIRST

    Before this touches real money, handle every one of these — each is a
    real failure mode that has cost people real money:

      * IDEMPOTENCY. Network timeout != order rejected. Attach a client
        order id and check whether it landed before retrying, or a flaky
        connection turns one intended buy into three.
      * RECONCILIATION. On every start, read the true position from the
        exchange. Never trust local state across a restart.
      * PARTIAL FILLS. `units` requested is not `units` filled.
      * PRECISION. Exchanges reject sizes/prices off their tick and lot
        grid: use `exchange.amount_to_precision` / `price_to_precision`.
      * RATE LIMITS. `enableRateLimit: True`, and back off on 429.
      * MIN NOTIONAL. Tiny rebalances get rejected, not silently skipped.
      * KILL SWITCH. A way to flatten and stop that does not require the
        bot to be healthy — because you will need it when it isn't.
      * KEY HYGIENE. Trade-only permissions, withdrawals disabled, keys in
        env vars or a secrets manager, never committed.
    """

    def __init__(self, *_, **__):
        raise NotImplementedError(
            "CcxtBroker is a documented stub. Implement it only after your "
            "strategy has survived a long paper-trading run — and read the "
            "checklist in this class's docstring first."
        )

    def get_price(self, symbol: str) -> float: ...
    def get_position(self, symbol: str) -> float: ...
    def get_equity(self) -> float: ...
    def market_order(self, symbol: str, units: float) -> Fill: ...
