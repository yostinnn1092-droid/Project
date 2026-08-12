#!/usr/bin/env python
"""
Fetch hourly stock bars from Yahoo Finance into data/stocks_h1/.

    python fetch_stocks.py

Yahoo caps the 1-hour interval at 730 days, so each symbol yields roughly
3,500 bars over two years. That is short history, but it is *many
instruments*, which is the axis the earlier H1 result was missing: one stock
over 15 months cannot distinguish a real effect from that stock's story.

SURVIVORSHIP BIAS — READ BEFORE TRUSTING ANY RESULT FROM THIS
------------------------------------------------------------
The tickers below are companies that are large and listed *today*. Firms that
went bankrupt, were delisted, or were acquired after collapsing are missing,
because you cannot download data for a company that no longer trades.

So this basket is pre-filtered for survival. Buy-and-hold looks better on it
than it would have looked in advance, and any strategy that is mostly long
inherits the same flattery. The basket deliberately includes names that have
had long bad stretches (INTC, PFE, BA, NKE, VZ) to blunt this, but it cannot
remove it. A properly unbiased test needs a point-in-time index constituent
list, which is not free.
"""

from __future__ import annotations

import json
import subprocess
import time
from pathlib import Path

import pandas as pd

OUT = Path(__file__).parent / "data" / "stocks_h1"
FX_OUT = Path(__file__).parent / "data" / "forex_h1"
UA = "Mozilla/5.0 (compatible; tradingbot-research/1.0)"
URL = "https://query1.finance.yahoo.com/v8/finance/chart/{sym}?range=2y&interval=1h"
# Yahoo caps the 5-minute interval at 60 days of history.
URL_M5 = "https://query1.finance.yahoo.com/v8/finance/chart/{sym}?range=60d&interval=5m"
URL_M1 = "https://query1.finance.yahoo.com/v8/finance/chart/{sym}?range=7d&interval=1m"

TICKERS = [
    # broad market / benchmark
    "SPY", "QQQ",
    # mega-cap tech
    "AAPL", "MSFT", "NVDA", "GOOGL", "AMZN",
    # financials
    "JPM", "BAC",
    # energy
    "XOM", "CVX",
    # healthcare
    "JNJ", "PFE",
    # consumer staples / discretionary
    "KO", "WMT", "MCD", "NKE",
    # industrials
    "CAT", "BA",
    # telecom / semis that have struggled
    "VZ", "INTC",
]


def fetch(sym: str, m5: bool = False, m1: bool = False) -> pd.DataFrame | None:
    url = (URL_M1 if m1 else (URL_M5 if m5 else URL)).format(sym=sym)
    for attempt in range(3):
        out = subprocess.run(
            ["curl", "-sS", "--max-time", "60", "-A", UA, url],
            capture_output=True, text=True,
        )
        body = out.stdout.strip()
        if not body:
            time.sleep(3)
            continue
        try:
            d = json.loads(body)
            res = d["chart"]["result"][0]
        except Exception:
            time.sleep(3)
            continue

        ts = res.get("timestamp") or []
        q = res["indicators"]["quote"][0]
        rows = []
        for i, t in enumerate(ts):
            o, h, l, c = q["open"][i], q["high"][i], q["low"][i], q["close"][i]
            v = q["volume"][i]
            # Yahoo emits nulls for bars with no trading; drop rather than fill.
            if None in (o, h, l, c):
                continue
            rows.append({
                "timestamp": pd.Timestamp(t, unit="s"),
                "open": float(o), "high": float(h),
                "low": float(l), "close": float(c),
                "volume": float(v or 0),
            })
        if not rows:
            return None
        return pd.DataFrame(rows).sort_values("timestamp").reset_index(drop=True)
    return None


M5_TICKERS = ["EURUSD=X", "GBPUSD=X", "USDJPY=X", "AUDUSD=X",
              "GC=F", "SI=F", "BTC-USD", "ETH-USD"]
M5_OUT = Path(__file__).parent / "data" / "m5"

# Yahoo caps the 1-minute interval at 7 days. Short, but 1-minute strategies
# generate many trades per day, so trade count is still usable.
M1_TICKERS = ["EURUSD=X", "GBPUSD=X", "USDJPY=X", "AUDUSD=X",
              "GC=F", "BTC-USD", "ETH-USD"]
M1_OUT = Path(__file__).parent / "data" / "m1"

GOLD_TICKERS = ["GC=F"]   # COMEX gold front-month; the free proxy for XAUUSD
GOLD_OUT = Path(__file__).parent / "data" / "gold_h1"

FX_TICKERS = [
    "EURUSD=X", "GBPUSD=X", "USDJPY=X", "AUDUSD=X", "USDCAD=X",
    "NZDUSD=X", "USDCHF=X", "EURGBP=X", "EURJPY=X", "GBPJPY=X",
]


def main() -> None:
    import sys
    forex = "--forex" in sys.argv
    gold = "--gold" in sys.argv
    m5 = "--m5" in sys.argv
    m1 = "--m1" in sys.argv
    out = M1_OUT if m1 else (M5_OUT if m5 else (GOLD_OUT if gold else (FX_OUT if forex else OUT)))
    tickers = M1_TICKERS if m1 else (M5_TICKERS if m5 else (GOLD_TICKERS if gold else (FX_TICKERS if forex else TICKERS)))
    out.mkdir(parents=True, exist_ok=True)
    ok, failed = 0, []
    for sym in tickers:
        df = fetch(sym, m5=m5, m1=m1)
        if df is None or len(df) < 500:
            failed.append(sym)
            print(f"  {sym:<6} FAILED")
        else:
            df.to_csv(out / f"{sym.replace('=X', '').replace('=F', '').replace('-USD', '')}.csv", index=False)
            print(f"  {sym:<9} {len(df):>6,} bars  "
                  f"{df['timestamp'].iloc[0]:%Y-%m-%d} -> {df['timestamp'].iloc[-1]:%Y-%m-%d}")
            ok += 1
        time.sleep(1.5)  # be polite; Yahoo throttles bursts

    print(f"\n{ok} saved, {len(failed)} failed" + (f": {failed}" if failed else ""))


if __name__ == "__main__":
    main()
