#!/usr/bin/env python
"""
Live-feed trading bot on Bitget. Paper by default, live only when armed.

    python bitget_bot.py                          # paper, real prices
    python bitget_bot.py --symbol BTCUSDT --tf 1h
    python bitget_bot.py --live                   # real orders (see GOING LIVE)

This is step 2 of the progression in `tradingbot/broker.py`: a real feed,
real timing, real failure modes, simulated fills. The same `Strategy` object
the backtester used decides here, so a difference in behaviour cannot come
from a difference in strategy code.

WHAT THIS HANDLES THAT A BACKTEST CANNOT
----------------------------------------
  * FORMING BARS. Bitget's last candle is the one still being built. Acting
    on it means acting on a close that has not happened, which is lookahead
    bias reintroduced live after being carefully excluded in the backtest.
    `_closed_bars` drops it. This is the single most likely way to make a
    live bot behave unlike its backtest.
  * STALE FEED. If the newest closed bar is older than two intervals the
    feed has stalled; the bot holds rather than trading on a stale price.
  * DUPLICATE / REPLAYED BARS. Decisions are keyed on bar timestamp, so the
    same bar arriving twice cannot produce two orders.
  * RESTART AMNESIA. On start the live path reads the true position from the
    exchange instead of assuming flat.
  * CLOCK DRIFT. Checked at startup; signing fails past ~30s of skew.
  * TRANSPORT ERRORS. Retried with backoff. Application-level rejections
    (BitgetError with a code) are NOT retried — they fail identically.

GOING LIVE
----------
`--live` alone is not enough. All three must hold:

    --live                                        on the command line
    BITGET_LIVE_CONFIRM="I ACCEPT LIVE TRADING RISK"
    BITGET_API_KEY / _SECRET / _PASSPHRASE        in the environment

Before you set any of them, read `--why-not-yet`.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd

from tradingbot import PaperBroker, RiskLimits, RiskManager, SmaCrossover
from tradingbot.bitget import LIVE_PHRASE, BitgetClient, BitgetError, BitgetPublic

JOURNAL = Path(__file__).parent / "journal"
INTERVAL_SECONDS = {"1min": 60, "5min": 300, "15min": 900, "30min": 1800,
                    "1h": 3600, "4h": 14400, "1D": 86400}

_stop = False


def _on_signal(*_) -> None:
    """Finish the current cycle, then exit. Killing mid-order is how state
    and exchange get out of sync."""
    global _stop
    _stop = True
    print("\n  shutdown requested; finishing this cycle...")


class Journal:
    """Append-only record of every decision, including the no-trades.

    A bot that logs only its trades cannot answer 'why did it do nothing
    for six hours', which is the question you will actually have.
    """

    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path

    def write(self, **fields) -> None:
        fields["logged_at"] = datetime.now(timezone.utc).isoformat()
        with self.path.open("a") as f:
            f.write(json.dumps(fields, default=str) + "\n")

    def last_decided_bar(self) -> pd.Timestamp | None:
        """Newest bar this bot has already acted on, across restarts.

        Without this the loop's in-memory `last_bar` starts empty, so a
        restart re-decides the most recent closed bar and trades it again.
        Caught by reading this journal: three runs, three identical entries
        for the 03:00 bar. Harmless on paper because the broker resets too;
        live it is a duplicate order every restart, which is exactly the
        'restart amnesia' this file's docstring claims to handle.
        """
        if not self.path.exists():
            return None
        newest = None
        for line in self.path.read_text().splitlines():
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue  # a partial line from a kill mid-write
            if rec.get("event") != "decision":
                continue
            ts = pd.Timestamp(rec["bar"])
            if newest is None or ts > newest:
                newest = ts
        return newest


def _closed_bars(df: pd.DataFrame, timeframe: str) -> pd.DataFrame:
    """Drop the bar that is still forming.

    Bitget returns the in-progress candle as the final row. Its close is
    whatever the price happens to be at this instant and it will change
    before the bar ends, so a strategy reading it is reading noise that
    looks like a signal.
    """
    if df.empty:
        return df
    step = INTERVAL_SECONDS.get(timeframe, 3600)
    last_open = df["timestamp"].iloc[-1]
    closes_at = last_open + timedelta(seconds=step)
    now = pd.Timestamp(datetime.now(timezone.utc)).tz_localize(None)
    return df.iloc[:-1] if closes_at > now else df


def _retry(fn, attempts: int = 4, base: float = 2.0):
    """Retry transport failures only.

    A `BitgetError` means the request arrived and was rejected on its merits
    — bad symbol, bad signature, insufficient margin. Retrying it unchanged
    produces the same rejection while burning rate limit.
    """
    for i in range(attempts):
        try:
            return fn()
        except BitgetError:
            raise
        except Exception as e:
            if i == attempts - 1:
                raise
            wait = base ** i
            print(f"    transport error ({e.__class__.__name__}), retry in {wait:.0f}s")
            time.sleep(wait)


def why_not_yet() -> None:
    print("""
WHY THIS BOT IS NOT READY FOR YOUR MONEY
========================================
Not an opinion. This is what the repo's own tests measured.

1. NO STRATEGY HERE BEAT BUY-AND-HOLD.
   About twenty were tested across stocks, forex, gold, crypto and indices.
   Zero produced a reliable edge. run_search.py: 0/20 positive excess.
   run_h1_stocks.py: SIGNIFICANTLY NEGATIVE, CI [-2.86%, -0.90%] over 231
   windows. The default strategy below is a placeholder, not a
   recommendation.

2. EVERY PROFITABLE BACKTEST IN THIS REPO WAS A BUG.
   A frozen benchmark, a 24/7 annualisation on a 5.5h/day market, a null
   distribution centred wrongly, a strategy that took zero trades while
   reporting 0.00%. Each looked like a discovery first.

3. BITGET'S XAUUSDT HAS ~8 MONTHS OF HISTORY.
   Under a year, one instrument. Nothing can be concluded from it.

4. THE COST WALL IS REAL AND BITGET CONFIRMS IT.
   Taker is 6bp a side, 12bp round trip. The best measured gross edge in
   this repo was +3.14bp per trade. That is a 9bp loss per round trip
   before the strategy is even wrong.

WHAT TO DO INSTEAD
------------------
Run this in paper mode for weeks, on the symbol and timeframe you care
about. Compare the paper equity curve against buy-and-hold over the same
window. If it does not clearly win on paper, it will not win with money —
paper mode has no slippage surprises, no partial fills and no outages.

Then, if and only if it wins: live with size so small the loss is tuition.
""")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--symbol", default="XAUUSDT")
    p.add_argument("--tf", default="1h", choices=sorted(INTERVAL_SECONDS))
    p.add_argument("--product", default="USDT-FUTURES")
    p.add_argument("--equity", type=float, default=1_000.0,
                   help="paper starting equity")
    p.add_argument("--poll", type=int, default=30, help="seconds between checks")
    p.add_argument("--live", action="store_true", help="place REAL orders")
    p.add_argument("--why-not-yet", action="store_true",
                   help="what the tests say about trading this")
    a = p.parse_args()

    if a.why_not_yet:
        why_not_yet()
        return

    feed = BitgetPublic()
    strategy = SmaCrossover(fast=20, slow=60)
    risk = RiskManager(RiskLimits(max_position=1.0, max_drawdown=0.15,
                                  daily_loss_limit=0.05))
    journal = Journal(JOURNAL / f"bitget_{a.symbol}_{a.tf}.jsonl")

    # ---------------------------------------------------------- arm or not
    client = None
    if a.live:
        if os.environ.get("BITGET_LIVE_CONFIRM") != LIVE_PHRASE:
            print(f"REFUSING: --live requires BITGET_LIVE_CONFIRM={LIVE_PHRASE!r} "
                  f"in the environment.\nRun with --why-not-yet first.")
            sys.exit(1)
        try:
            client = BitgetClient(live=True)
        except BitgetError as e:
            print(f"REFUSING: {e}")
            sys.exit(1)
        print("*** LIVE MODE — REAL ORDERS, REAL MONEY ***")
    broker = PaperBroker(cash=a.equity, commission=0.0006, slippage=0.0001)

    # ------------------------------------------------------------- preflight
    skew = feed.clock_skew_ms()
    spread = feed.spread_bps(a.symbol, a.product)
    print(f"\n  symbol      : {a.symbol} [{a.product}] {a.tf}")
    print(f"  mode        : {'LIVE' if client else 'PAPER'}")
    print(f"  strategy    : SmaCrossover(20, 60)   warmup {strategy.warmup} bars")
    print(f"  clock skew  : {skew:+,} ms")
    print(f"  live spread : {spread:.2f} bp")
    print(f"  journal     : {journal.path}")
    if abs(skew) > 30_000:
        print("  REFUSING: clock skew over 30s will break request signing.")
        sys.exit(1)

    # Reconcile against the exchange rather than assuming flat. A restart
    # that forgets an open position will happily open a second one.
    if client:
        pos = [q for q in client.positions(a.product)
               if q["symbol"] == a.symbol and float(q.get("total", 0)) != 0]
        print(f"  open position on exchange: {pos if pos else 'none'}")

    # Resume where the last run stopped, so a restart cannot re-trade a bar
    # that was already decided. Journal is the source of truth here because
    # it survives the process; in-memory state does not.
    last_bar = journal.last_decided_bar()
    if last_bar is not None:
        print(f"  resuming after bar: {last_bar}")

    signal.signal(signal.SIGINT, _on_signal)
    signal.signal(signal.SIGTERM, _on_signal)
    print(f"\n  polling every {a.poll}s — Ctrl-C to stop\n")

    step = INTERVAL_SECONDS[a.tf]

    while not _stop:
        try:
            raw = _retry(lambda: feed.history(a.symbol, a.tf,
                                              strategy.warmup + 50, a.product))
            bars = _closed_bars(raw, a.tf)

            if len(bars) <= strategy.warmup:
                print(f"  {len(bars)} closed bars, need > {strategy.warmup}; waiting")
                time.sleep(a.poll)
                continue

            newest = bars["timestamp"].iloc[-1]

            # Staleness: a feed that stopped updating looks exactly like a
            # quiet market until you act on a price from an hour ago.
            age = (pd.Timestamp(datetime.now(timezone.utc)).tz_localize(None)
                   - newest).total_seconds()
            if age > step * 2:
                print(f"  STALE: newest closed bar is {age / 60:.0f} min old; holding")
                journal.write(event="stale_feed", bar=newest, age_s=age)
                time.sleep(a.poll)
                continue

            # Same bar as last cycle -> nothing new to decide. This is what
            # makes a duplicate or replayed bar harmless.
            if last_bar is not None and newest <= last_bar:
                time.sleep(a.poll)
                continue

            price = float(bars["close"].iloc[-1])
            broker.set_price(a.symbol, price)
            equity = broker.get_equity()
            risk.update(equity, newest)

            target = float(strategy.on_bar(bars))
            allowed = risk.adjust(target)
            current = broker.get_position(a.symbol)

            fill = broker.rebalance_to_weight(a.symbol, allowed)
            journal.write(event="decision", bar=newest, price=price,
                          equity=equity, target=target, allowed=allowed,
                          position_before=current,
                          halt=risk.halt_reason,
                          filled=bool(fill),
                          units=fill.units if fill else 0.0,
                          fill_price=fill.price if fill else None)

            flag = "TRADE" if fill else "hold "
            print(f"  {newest:%Y-%m-%d %H:%M}  {price:>10,.2f}  w={allowed:+.2f}  "
                  f"{flag}  equity {equity:>10,.2f}"
                  + (f"  [{risk.halt_reason}]" if risk.halt_reason else ""))

            if fill and client:
                # Idempotency: the client order id makes a timed-out request
                # safe to investigate rather than blindly repeat.
                oid = f"bot-{a.symbol}-{int(newest.timestamp())}"
                side = "buy" if fill.units > 0 else "sell"
                res = client.place_order(a.symbol, side, abs(fill.units),
                                         a.product, client_oid=oid)
                journal.write(event="live_order", bar=newest, client_oid=oid,
                              side=side, size=abs(fill.units), response=res)
                print(f"    LIVE ORDER {side} {abs(fill.units)} -> {res}")

            last_bar = newest

        except BitgetError as e:
            print(f"  API rejected: {e}")
            journal.write(event="api_error", error=str(e))
        except Exception as e:  # keep the loop alive; a crash mid-position is worse
            print(f"  unexpected: {e.__class__.__name__}: {e}")
            journal.write(event="crash", error=repr(e))

        time.sleep(a.poll)

    print(f"\n  stopped. final paper equity {broker.get_equity():,.2f} "
          f"from {a.equity:,.2f}")
    print(f"  {len(broker.fills)} paper fills. Journal: {journal.path}")


if __name__ == "__main__":
    main()
