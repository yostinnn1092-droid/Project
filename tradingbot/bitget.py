"""
Bitget REST connector — market data (open) and account access (signed).

Stdlib only. No `requests`, no `ccxt`. Two reasons: one less dependency to
audit on the machine that holds your keys, and the signing scheme is thirty
lines, so you can read it and know exactly what gets sent.

    BitgetPublic()   no credentials, read-only market data
    BitgetClient()   credentials from ENV VARS, account + orders

WHY THE SPLIT
-------------
Everything useful for research — candles, tickers, contract specs — needs no
credentials at all. Backtesting, calibration and paper trading run entirely
on `BitgetPublic`, so the key-handling problem never arises until the moment
you actually intend to send an order.

KEYS COME FROM THE ENVIRONMENT, ALWAYS
--------------------------------------
    export BITGET_API_KEY=...
    export BITGET_API_SECRET=...
    export BITGET_API_PASSPHRASE=...

There is deliberately no `api_key=` constructor argument. A key passed as an
argument ends up in shell history, in tracebacks, in log files, and in chat
transcripts. Reading them from the environment keeps them out of all four.
`BitgetClient` also refuses to include key material in its own repr.

THE ORDER GATE
--------------
`place_order` raises unless BOTH hold:

    BitgetClient(live=True)                       explicit in code
    BITGET_LIVE_CONFIRM="I ACCEPT LIVE TRADING RISK"   explicit in the env

Same posture as `xauusd/broker.py`: one flag is something you copy from an
example by accident, two is a decision. Default is read-only, and read-only
means every write path raises before a request is built.

WHAT THIS DOES NOT DO
---------------------
It is a transport, not a trading system. Idempotency keys, reconciliation on
restart, partial-fill handling and a kill switch are listed in `CcxtBroker`'s
docstring and are still your problem. Do not let "the API connects" become
"the bot is ready".
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any

import pandas as pd

BASE = "https://api.bitget.com"
LIVE_PHRASE = "I ACCEPT LIVE TRADING RISK"

#: Bitget granularity strings, keyed by the repo's canonical pandas offsets so
#: `resample(df, "4h")` and `candles(..., "4h")` mean the same thing.
#:
#: Spot and futures accept DIFFERENT vocabularies for the same bar size —
#: spot wants "4h" and "1day", futures want "4H" and "1D". Passing the wrong
#: one is a 400, not a silent fallback, so the two are mapped separately
#: rather than hoping one set works everywhere.
GRANULARITY_SPOT = {
    "1min": "1min", "5min": "5min", "15min": "15min", "30min": "30min",
    "1h": "1h", "4h": "4h", "6h": "6h", "12h": "12h",
    "1D": "1day", "1W": "1week",
}
GRANULARITY_MIX = {
    "1min": "1m", "3min": "3m", "5min": "5m", "15min": "15m", "30min": "30m",
    "1h": "1H", "4h": "4H", "6h": "6H", "12h": "12H",
    "1D": "1D", "1W": "1W", "1M": "1M",
}


class BitgetError(RuntimeError):
    """A request reached Bitget and Bitget refused it.

    Distinct from a transport failure on purpose: a 200 carrying
    `code != "00000"` is an application-level rejection (bad symbol, bad
    signature, insufficient margin) and retrying it unchanged will fail
    identically. Transport errors are the ones worth retrying.
    """


def _get(url: str, headers: dict[str, str] | None = None,
         body: bytes | None = None, method: str = "GET",
         timeout: int = 30) -> dict[str, Any]:
    req = urllib.request.Request(url, data=body, method=method,
                                 headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            payload = json.loads(r.read())
    except urllib.error.HTTPError as e:
        # Bitget returns its error JSON in the body of a 4xx, and that body
        # says WHY. Swallowing it and reporting the status code alone turns a
        # one-line fix into a debugging session.
        detail = e.read().decode("utf-8", "replace")[:400]
        raise BitgetError(f"HTTP {e.code} from {url.split('?')[0]}: {detail}") from None

    if payload.get("code") != "00000":
        raise BitgetError(f"{payload.get('code')}: {payload.get('msg')}")
    return payload


class BitgetPublic:
    """Unauthenticated market data. Safe to run anywhere, holds no secrets."""

    def __init__(self, base: str = BASE):
        self.base = base.rstrip("/")

    # ---------------------------------------------------------------- meta
    def server_time(self) -> int:
        """Milliseconds since epoch, per Bitget.

        Worth checking on startup: the signature includes a timestamp, and a
        clock more than ~30s out gets every signed request rejected with an
        error that does not mention the clock.
        """
        return int(_get(f"{self.base}/api/v2/public/time")["data"]["serverTime"])

    def clock_skew_ms(self) -> int:
        """Local clock minus exchange clock. Large values break signing."""
        return int(time.time() * 1000) - self.server_time()

    def symbols(self, product: str = "spot") -> list[dict]:
        """Tradeable instruments. `product` is 'spot' or 'USDT-FUTURES'."""
        if product == "spot":
            return _get(f"{self.base}/api/v2/spot/public/symbols")["data"]
        q = urllib.parse.urlencode({"productType": product})
        return _get(f"{self.base}/api/v2/mix/market/contracts?{q}")["data"]

    def ticker(self, symbol: str, product: str = "spot") -> dict:
        if product == "spot":
            q = urllib.parse.urlencode({"symbol": symbol})
            path = f"/api/v2/spot/market/tickers?{q}"
        else:
            q = urllib.parse.urlencode({"symbol": symbol, "productType": product})
            path = f"/api/v2/mix/market/ticker?{q}"
        data = _get(f"{self.base}{path}")["data"]
        return data[0] if isinstance(data, list) else data

    def spread_bps(self, symbol: str, product: str = "spot") -> float:
        """Live bid/ask spread in basis points.

        The single most useful number before trusting any backtest: compare
        it against the strategy's edge per trade. If the spread is wider, the
        strategy is arithmetic that loses money.
        """
        t = self.ticker(symbol, product)
        bid, ask = float(t["bidPr"]), float(t["askPr"])
        return (ask - bid) / ((ask + bid) / 2) * 10_000

    # --------------------------------------------------------------- bars
    def candles(self, symbol: str, timeframe: str = "1h", limit: int = 200,
                product: str = "spot", end_ms: int | None = None,
                deep: bool = False) -> pd.DataFrame:
        """One page of bars, in this repo's canonical schema.

        Returns `timestamp | open | high | low | close | volume`, ascending,
        which is exactly what `tradingbot.data.validate` expects — so the
        output drops straight into the backtester with no adapter.

        `deep=True` switches to the `history-candles` endpoint, which is the
        one that pages back past the recent window. The regular endpoint
        stops after a few hundred bars regardless of `endTime`.
        """
        table = GRANULARITY_SPOT if product == "spot" else GRANULARITY_MIX
        params: dict[str, Any] = {"symbol": symbol,
                                  "granularity": table.get(timeframe, timeframe),
                                  "limit": min(limit, 200)}
        kind = "history-candles" if deep else "candles"
        if product == "spot":
            path = f"/api/v2/spot/market/{kind}"
        else:
            path = f"/api/v2/mix/market/{kind}"
            params["productType"] = product
        if end_ms is not None:
            params["endTime"] = int(end_ms)

        rows = _get(f"{self.base}{path}?{urllib.parse.urlencode(params)}")["data"]
        return _to_frame(rows)

    def history(self, symbol: str, timeframe: str = "1h", bars: int = 1_000,
                product: str = "spot", pause: float = 0.12) -> pd.DataFrame:
        """Page backwards until `bars` bars are collected.

        One request caps at 200 bars, which is not enough to backtest
        anything. Bitget pages by `endTime`, walking backwards from now, so
        each call asks for bars strictly older than the oldest one held.

        Stops early — rather than looping forever — when a page comes back
        empty or fails to extend the range, which is what happens once you
        reach the start of the instrument's listed history.

        BE SUSPICIOUS OF WHAT COMES BACK. Perpetuals are listed, not born:
        `XAUUSDT` only goes back to December 2025, so asking for 5,000 4h
        bars returns roughly 1,400 and no error. Always check the span of
        the result rather than the row count you requested — a short series
        will happily produce a confident-looking backtest of nothing.
        """
        out: list[pd.DataFrame] = []
        end: int | None = None
        got = 0
        while got < bars:
            page = self.candles(symbol, timeframe, 200, product,
                                end_ms=end, deep=True)
            if page.empty:
                break
            oldest = int(page["timestamp"].iloc[0].timestamp() * 1000)
            if end is not None and oldest >= end:
                break  # no progress; we are at the beginning of history
            out.append(page)
            got += len(page)
            end = oldest
            time.sleep(pause)  # stay under the public rate limit

        if not out:
            return _to_frame([])
        df = (pd.concat(out, ignore_index=True)
                .drop_duplicates("timestamp")
                .sort_values("timestamp")
                .reset_index(drop=True))
        return df.tail(bars).reset_index(drop=True)

    def contract_spec(self, symbol: str, product: str = "USDT-FUTURES") -> dict:
        """Fees, tick and lot grid for a futures contract.

        `takerFeeRate` and `makerFeeRate` are the two numbers that decide
        whether a strategy is viable; read them from here rather than
        assuming, because they are account-tier dependent.
        """
        q = urllib.parse.urlencode({"productType": product, "symbol": symbol})
        rows = _get(f"{self.base}/api/v2/mix/market/contracts?{q}")["data"]
        if not rows:
            raise BitgetError(f"no contract named {symbol} in {product}")
        return rows[0]

    def round_trip_bps(self, symbol: str, product: str = "USDT-FUTURES",
                       maker: bool = False) -> float:
        """Round-trip fee in bps, straight from the venue's own schedule."""
        spec = self.contract_spec(symbol, product)
        rate = float(spec["makerFeeRate" if maker else "takerFeeRate"])
        return rate * 2 * 10_000


def _to_frame(rows: list) -> pd.DataFrame:
    """Bitget candle arrays -> canonical OHLCV frame.

    Wire format is [ts_ms, open, high, low, close, base_vol, quote_vol, ...]
    with every field a STRING. Feeding those strings to pandas gives object
    columns that compare lexicographically — "9" > "10" — so the cast to
    float is not cosmetic.
    """
    cols = ["timestamp", "open", "high", "low", "close", "volume"]
    if not rows:
        return pd.DataFrame({c: pd.Series(dtype="float64") for c in cols}).astype(
            {"timestamp": "datetime64[ns]"})

    df = pd.DataFrame([r[:6] for r in rows], columns=cols)
    df["timestamp"] = pd.to_datetime(df["timestamp"].astype("int64"), unit="ms")
    for c in ("open", "high", "low", "close", "volume"):
        df[c] = df[c].astype(float)
    return df.sort_values("timestamp").reset_index(drop=True)


@dataclass
class Balance:
    coin: str
    available: float
    frozen: float

    @property
    def total(self) -> float:
        return self.available + self.frozen


class BitgetClient(BitgetPublic):
    """Signed access to a Bitget account. Read-only unless explicitly armed.

    Credentials are read from the environment at construction and never
    accepted as arguments — see the module docstring.
    """

    def __init__(self, live: bool = False, base: str = BASE, demo: bool = False):
        super().__init__(base)
        self._key = os.environ.get("BITGET_API_KEY", "")
        self._secret = os.environ.get("BITGET_API_SECRET", "")
        self._passphrase = os.environ.get("BITGET_API_PASSPHRASE", "")
        self.live = live
        #: Demo trading. Bitget routes simulated orders by the `paptrading`
        #: header in addition to the S-prefixed symbols and SUSDT-FUTURES
        #: product type.
        #:
        #: UNVERIFIED HERE. The public demo endpoints are confirmed working,
        #: but the signed order path could not be exercised without real
        #: credentials, and Bitget's own documentation is inconsistent about
        #: whether demo needs its own API key or accepts a live one. If demo
        #: orders come back rejected, generate a key from inside Demo mode in
        #: the Bitget UI and use that. Said plainly rather than presented as
        #: tested.
        self.demo = demo

        missing = [n for n, v in (
            ("BITGET_API_KEY", self._key),
            ("BITGET_API_SECRET", self._secret),
            ("BITGET_API_PASSPHRASE", self._passphrase)) if not v]
        if missing:
            raise BitgetError(
                "missing credentials in the environment: " + ", ".join(missing)
                + "\nSet them in your shell (never pass them as arguments, and "
                  "never paste them into a chat window):\n"
                  "  export BITGET_API_KEY=...\n"
                  "  export BITGET_API_SECRET=...\n"
                  "  export BITGET_API_PASSPHRASE=...")

    def __repr__(self) -> str:
        # Never let key material reach a traceback, a log line or a notebook.
        return f"BitgetClient(live={self.live}, key=***{self._key[-4:]})"

    # ------------------------------------------------------------- signing
    def _sign(self, ts: str, method: str, path: str, body: str) -> str:
        """base64(HMAC-SHA256(timestamp + METHOD + path + body, secret)).

        `path` must include the query string exactly as sent, in the same
        order. Re-encoding the params between signing and sending is the
        classic cause of a signature that looks correct and is rejected.
        """
        prehash = f"{ts}{method.upper()}{path}{body}"
        digest = hmac.new(self._secret.encode(), prehash.encode(),
                          hashlib.sha256).digest()
        return base64.b64encode(digest).decode()

    def _signed(self, method: str, path: str, params: dict | None = None,
                body: dict | None = None) -> dict[str, Any]:
        if params:
            path = f"{path}?{urllib.parse.urlencode(params)}"
        payload = json.dumps(body) if body else ""
        ts = str(int(time.time() * 1000))

        headers = {
            "ACCESS-KEY": self._key,
            "ACCESS-SIGN": self._sign(ts, method, path, payload),
            "ACCESS-TIMESTAMP": ts,
            "ACCESS-PASSPHRASE": self._passphrase,
            "Content-Type": "application/json",
            "locale": "en-US",
        }
        if self.demo:
            headers["paptrading"] = "1"
        return _get(f"{self.base}{path}", headers=headers,
                    body=payload.encode() if payload else None, method=method)

    # ---------------------------------------------------------------- read
    def balances(self) -> list[Balance]:
        rows = self._signed("GET", "/api/v2/spot/account/assets")["data"]
        return [Balance(r["coin"], float(r["available"]), float(r.get("frozen", 0)))
                for r in rows]

    def futures_account(self, product: str = "USDT-FUTURES",
                        margin_coin: str = "USDT") -> dict:
        return self._signed("GET", "/api/v2/mix/account/accounts",
                            {"productType": product})["data"]

    def positions(self, product: str = "USDT-FUTURES") -> list[dict]:
        return self._signed("GET", "/api/v2/mix/position/all-position",
                            {"productType": product})["data"]

    # --------------------------------------------------------------- write
    def _guard(self) -> None:
        """Two independent locks, both deliberate acts by a human.

        Checked before a request is constructed, so a read-only client cannot
        emit a write even if the endpoint were called by mistake.
        """
        if not self.live:
            raise BitgetError(
                "client is read-only. Construct BitgetClient(live=True) to arm "
                "it — and only after the strategy has survived paper trading.")
        if os.environ.get("BITGET_LIVE_CONFIRM") != LIVE_PHRASE:
            raise BitgetError(
                f"BITGET_LIVE_CONFIRM must equal {LIVE_PHRASE!r} to place real "
                "orders. Refusing.")

    def place_order(self, symbol: str, side: str, size: float,
                    product: str = "USDT-FUTURES", margin_coin: str = "USDT",
                    order_type: str = "market", price: float | None = None,
                    client_oid: str | None = None) -> dict:
        """Send a real order. Gated by `_guard`; read the docstring above it.

        `client_oid` is passed through and you should always set one: if the
        response times out you cannot otherwise tell a rejected order from a
        filled one, and retrying blindly doubles your position.
        """
        self._guard()
        if side not in ("buy", "sell"):
            raise ValueError(f"side must be 'buy' or 'sell', got {side!r}")

        body: dict[str, Any] = {
            "symbol": symbol, "productType": product, "marginCoin": margin_coin,
            "marginMode": "crossed", "side": side, "orderType": order_type,
            "size": str(size),
        }
        if order_type == "limit":
            if price is None:
                raise ValueError("limit order requires a price")
            body["price"] = str(price)
        if client_oid:
            body["clientOid"] = client_oid

        return self._signed("POST", "/api/v2/mix/order/place-order", body=body)["data"]
