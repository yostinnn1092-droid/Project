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
UA = "Mozilla/5.0 (compatible; tradingbot-research/1.0)"
URL = "https://query1.finance.yahoo.com/v8/finance/chart/{sym}?range=2y&interval=1h"

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


def fetch(sym: str) -> pd.DataFrame | None:
    for attempt in range(3):
        out = subprocess.run(
            ["curl", "-sS", "--max-time", "60", "-A", UA, URL.format(sym=sym)],
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


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    ok, failed = 0, []
    for sym in TICKERS:
        df = fetch(sym)
        if df is None or len(df) < 500:
            failed.append(sym)
            print(f"  {sym:<6} FAILED")
        else:
            df.to_csv(OUT / f"{sym}.csv", index=False)
            print(f"  {sym:<6} {len(df):>5,} bars  "
                  f"{df['timestamp'].iloc[0]:%Y-%m-%d} -> {df['timestamp'].iloc[-1]:%Y-%m-%d}")
            ok += 1
        time.sleep(1.5)  # be polite; Yahoo throttles bursts

    print(f"\n{ok} saved, {len(failed)} failed" + (f": {failed}" if failed else ""))


if __name__ == "__main__":
    main()
