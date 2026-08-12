#!/usr/bin/env python
"""
Fetch real forex data into data/.

    python fetch_forex.py                      # EUR/USD daily OHLC (no key needed)
    python fetch_forex.py --key YOUR_KEY       # adds GBP/USD, USD/JPY, AUD/USD
    python fetch_forex.py --ecb                # extra pairs, CLOSE-ONLY (see below)

Sources
-------
Alpha Vantage FX_DAILY — real open/high/low/close, ~19 years. The public
`demo` key serves EUR/USD only; a free key (alphavantage.co/support/#api-key)
unlocks the rest.

Frankfurter / ECB (`--ecb`) — official ECB reference rates. Free, no key, many
currencies, but **one rate per day**: there is no open, high or low. This
script writes open=high=low=close for those, which is honest but has
consequences you must respect:

  * high/low are fake, so any strategy using intrabar range, or a stop that
    depends on the bar's extremes, is meaningless on this data.
  * fills happen at the next day's close rather than its open.

ECB rates are also a daily fix, not tradable prices, and carry no spread.
Use them for cross-market sanity checks, never for cost-sensitive work.
"""

from __future__ import annotations

import argparse
import json
import time
import subprocess
from pathlib import Path

import pandas as pd

OUT = Path(__file__).parent / "data"
AV = "https://www.alphavantage.co/query"
ECB = "https://api.frankfurter.app"


def _get(url: str) -> dict:
    """Fetch JSON via curl.

    urllib is avoided deliberately: it sends `Python-urllib/3.x` as its user
    agent, which several data hosts reject outright (Alpha Vantage answered
    403 to urllib and 200 to curl for the identical URL). curl also picks up
    this environment's proxy and CA configuration without extra wiring.

    Retries once on an empty or non-JSON body, which free endpoints return
    under throttling. A single flaky response should not abort a multi-pair
    fetch and lose the pairs that already succeeded.
    """
    for attempt in range(2):
        out = subprocess.run(
            ["curl", "-sSL", "--max-time", "90", "-A",
             "Mozilla/5.0 (compatible; tradingbot-research/1.0)", url],
            capture_output=True, text=True,
        )
        body = out.stdout.strip()
        if body:
            try:
                return json.loads(body)
            except json.JSONDecodeError:
                pass
        if attempt == 0:
            time.sleep(5)
    print(f"  request failed (non-JSON/empty after retry): {url[:70]}...")
    return {}


def fetch_av(base: str, quote: str, key: str = "demo") -> pd.DataFrame | None:
    url = (f"{AV}?function=FX_DAILY&from_symbol={base}&to_symbol={quote}"
           f"&outputsize=full&apikey={key}")
    d = _get(url)
    series_key = next((k for k in d if "Time Series" in k), None)
    if series_key is None:
        note = list(d.values())[0] if d else "empty response"
        print(f"  {base}/{quote}: no data — {str(note)[:90]}")
        return None

    rows = [
        {
            "timestamp": pd.Timestamp(day),
            "open": float(v["1. open"]),
            "high": float(v["2. high"]),
            "low": float(v["3. low"]),
            "close": float(v["4. close"]),
            "volume": 0.0,  # spot FX has no consolidated volume
        }
        for day, v in d[series_key].items()
    ]
    return pd.DataFrame(rows).sort_values("timestamp").reset_index(drop=True)


def fetch_ecb(base: str, quote: str, start: str = "2007-01-01") -> pd.DataFrame | None:
    d = _get(f"{ECB}/{start}..?from={base}&to={quote}")
    rates = d.get("rates", {})
    if not rates:
        print(f"  {base}/{quote}: no ECB data")
        return None
    rows = []
    for day, v in sorted(rates.items()):
        if quote not in v:
            continue
        px = float(v[quote])
        # Close-only source: the OHLC columns are a shape, not information.
        rows.append({"timestamp": pd.Timestamp(day), "open": px, "high": px,
                     "low": px, "close": px, "volume": 0.0})
    return pd.DataFrame(rows)


def save(df: pd.DataFrame | None, name: str) -> None:
    if df is None or df.empty:
        return
    OUT.mkdir(exist_ok=True)
    path = OUT / f"{name}.csv"
    df.to_csv(path, index=False)
    print(f"  saved {len(df):>6,} bars -> {path.name}  "
          f"({df['timestamp'].iloc[0]:%Y-%m-%d} -> {df['timestamp'].iloc[-1]:%Y-%m-%d})")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--key", default="demo")
    ap.add_argument("--ecb", action="store_true", help="also fetch close-only ECB pairs")
    args = ap.parse_args()

    print("Alpha Vantage (real OHLC):")
    pairs = [("EUR", "USD")]
    if args.key != "demo":
        pairs += [("GBP", "USD"), ("USD", "JPY"), ("AUD", "USD")]
    for b, q in pairs:
        save(fetch_av(b, q, args.key), f"{b}{q}_1d")
        if len(pairs) > 1:
            time.sleep(15)  # free tier: 5 requests/minute

    if args.ecb:
        print("\nECB / Frankfurter (CLOSE-ONLY — high/low are synthetic):")
        for b, q in [("EUR", "GBP"), ("EUR", "JPY"), ("EUR", "AUD"), ("EUR", "CHF")]:
            save(fetch_ecb(b, q), f"{b}{q}_1d_closeonly")


if __name__ == "__main__":
    main()
