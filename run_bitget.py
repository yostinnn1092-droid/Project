#!/usr/bin/env python
"""
Connect to Bitget and check whether its gold market clears the cost wall.

    python run_bitget.py                 # market data only, no credentials
    python run_bitget.py --account       # adds balances/positions (needs keys)

Section 3 is the point. Every strategy in this repo died to the same
arithmetic: gross edge per trade smaller than the round-trip cost. Bitget
publishes its fee schedule over the API, so that comparison can be made
against the venue's real numbers instead of an assumed 12bp.
"""

from __future__ import annotations

import sys

from tradingbot.bitget import BitgetClient, BitgetError, BitgetPublic

SYMBOL = "XAUUSDT"
PRODUCT = "USDT-FUTURES"


def header(t: str) -> None:
    print(f"\n{'=' * 74}\n{t}\n{'=' * 74}")


def main() -> None:
    b = BitgetPublic()

    header("1. CONNECTION")
    skew = b.clock_skew_ms()
    print(f"  endpoint          : {b.base}")
    print(f"  clock skew        : {skew:+,} ms")
    if abs(skew) > 30_000:
        print("  WARNING: >30s skew will make every signed request fail.")
    print(f"  spot symbols      : {len(b.symbols()):,}")
    print(f"  futures contracts : {len(b.symbols(PRODUCT)):,}")

    header(f"2. {SYMBOL} — the gold market")
    t = b.ticker(SYMBOL, PRODUCT)
    spec = b.contract_spec(SYMBOL, PRODUCT)
    print(f"  last              : {float(t['lastPr']):>12,.2f}")
    print(f"  bid / ask         : {float(t['bidPr']):>12,.2f} / {float(t['askPr']):,.2f}")
    print(f"  24h range         : {float(t['low24h']):>12,.2f} - {float(t['high24h']):,.2f}")
    print(f"  live spread       : {b.spread_bps(SYMBOL, PRODUCT):>12.2f} bp")
    print(f"  min order         : {spec['minTradeNum']:>12} contracts"
          f"  (~${float(spec['minTradeUSDT']):,.0f} notional)")
    print(f"  contract type     : {spec['symbolType']:>12}")

    header("3. THE COST WALL, USING BITGET'S PUBLISHED FEES")
    taker = b.round_trip_bps(SYMBOL, PRODUCT)
    maker = b.round_trip_bps(SYMBOL, PRODUCT, maker=True)
    spread = b.spread_bps(SYMBOL, PRODUCT)
    print(f"  taker round trip  : {taker:>12.1f} bp")
    print(f"  maker round trip  : {maker:>12.1f} bp")
    print(f"  + spread crossed  : {spread:>12.2f} bp")
    print(f"  realistic taker   : {taker + spread:>12.2f} bp per round trip")
    print()
    print(f"  measured scalper gross edge : {3.14:>8.2f} bp")
    print(f"  cost to collect it (taker)  : {taker + spread:>8.2f} bp")
    print(f"  net                         : {3.14 - taker - spread:>8.2f} bp")
    print()
    print("  This repo assumed 12bp round-trip throughout. Bitget's actual")
    print("  taker schedule is 6bp per side, so that assumption was correct")
    print("  rather than pessimistic — and the scalper still loses on it.")
    print()
    print(f"  Maker-only would cost {maker:.1f}bp and clear the 3.14bp edge, which")
    print("  is exactly what run_maker.py tested. It failed there for a")
    print("  different reason: the fills you get are the ones that went")
    print("  against you. Read that section before assuming maker rebates")
    print("  are the way out.")

    header("4. HISTORY AVAILABLE — AND WHY IT IS NOT ENOUGH")
    for tf, want in (("1h", 5_000), ("4h", 5_000)):
        h = b.history(SYMBOL, tf, want, PRODUCT)
        if h.empty:
            print(f"  {tf:>4}: no data")
            continue
        span = (h["timestamp"].iloc[-1] - h["timestamp"].iloc[0])
        print(f"  {tf:>4}: {len(h):>6,} bars  {h['timestamp'].iloc[0]:%Y-%m-%d}"
              f" -> {h['timestamp'].iloc[-1]:%Y-%m-%d}"
              f"  ({span.days}d = {span.days / 365.25:.2f} years)")

    print("\n  That is the contract's ENTIRE life — XAUUSDT listed in December")
    print("  2025 — not a limit of this client. Asking for 5,000 4h bars")
    print("  returns ~1,450 and no error, which is exactly how a short sample")
    print("  sneaks into a backtest unnoticed.")
    print()
    print("  Under a year on ONE instrument is not enough to conclude anything.")
    print("  run_h1_stocks.py needed 231 windows across 21 stocks before the")
    print("  H1 trend result stopped flipping sign, and run_search.py showed")
    print("  that the best of 20 strategies beats the best of 20 RANDOM ones")
    print("  by less than people assume. A single 8-month series will produce")
    print("  a confident number and it will mean nothing.")
    print()
    print("  Use this feed for live prices and paper trading. Keep judging")
    print("  strategies on the long multi-instrument data already in data/.")

    print("\n  Bars come back in this repo's canonical schema, so they feed")
    print("  the backtester with no adapter:")
    print("      from tradingbot.bitget import BitgetPublic")
    print("      from tradingbot import run, SmaCrossover, Costs")
    print("      bars = BitgetPublic().history('XAUUSDT', '4h', 2000, 'USDT-FUTURES')")
    print("      run(bars, SmaCrossover(), costs=Costs(0.0006, 0.0001), bar_freq='4h')")

    if "--account" in sys.argv:
        header("5. ACCOUNT (signed)")
        try:
            c = BitgetClient()
        except BitgetError as e:
            print(f"  {e}")
            return
        print(f"  client: {c!r}")
        try:
            nonzero = [b_ for b_ in c.balances() if b_.total > 0]
            print(f"  spot balances with a balance: {len(nonzero)}")
            for bal in nonzero[:10]:
                print(f"    {bal.coin:<8}{bal.available:>16,.8f} free"
                      f"{bal.frozen:>16,.8f} frozen")
            pos = [p for p in c.positions(PRODUCT) if float(p.get("total", 0)) != 0]
            print(f"  open futures positions: {len(pos)}")
            for p in pos:
                print(f"    {p['symbol']:<12}{p['holdSide']:<6}"
                      f"{float(p['total']):>12}  entry {p.get('openPriceAvg')}")
        except BitgetError as e:
            print(f"  signed request failed: {e}")


if __name__ == "__main__":
    main()
