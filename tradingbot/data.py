"""
Data layer.

A bot is only ever as good as its bars. Everything downstream — signals,
backtests, live orders — inherits whatever mistakes live in here, so this
module is deliberately strict about the shape of what it hands back.

Canonical bar schema (one row per closed bar, ascending by time):

    timestamp | open | high | low | close | volume

Rules enforced on load:
  * sorted ascending by timestamp
  * no duplicate timestamps
  * no NaNs in OHLCV
  * high >= max(open, close), low <= min(open, close)

A bar that fails those checks is not a bar, it is a data bug that will
quietly become a fake profit in your backtest.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

REQUIRED = ["open", "high", "low", "close", "volume"]


def load_csv(
    path: str | Path,
    timestamp_col: str = "timestamp",
    tz: str | None = None,
) -> pd.DataFrame:
    """Load OHLCV bars from a CSV and validate them.

    Column names are lowercased, so `Open`/`OPEN`/`open` all work. Common
    aliases for the time column (`timestamps`, `date`, `datetime`, `time`)
    are detected automatically.
    """
    # utf-8-sig strips the BOM that Excel and many broker exports leave behind;
    # without it the first column is literally named "﻿timestamp".
    df = pd.read_csv(path, encoding="utf-8-sig")
    df.columns = [c.strip().lower() for c in df.columns]

    if timestamp_col not in df.columns:
        for alias in ("timestamps", "date", "datetime", "time", "open_time"):
            if alias in df.columns:
                timestamp_col = alias
                break
        else:
            raise ValueError(
                f"no timestamp column found; have {list(df.columns)}"
            )

    df = df.rename(columns={timestamp_col: "timestamp"})
    df["timestamp"] = pd.to_datetime(df["timestamp"], format="mixed")
    if tz:
        df["timestamp"] = df["timestamp"].dt.tz_localize(tz, ambiguous="NaT")

    missing = [c for c in REQUIRED if c not in df.columns]
    if missing:
        raise ValueError(f"missing required columns: {missing}")

    df = df[["timestamp", *REQUIRED]].copy()
    return validate(df)


def validate(df: pd.DataFrame) -> pd.DataFrame:
    """Sort, de-duplicate, and sanity-check bars. Raises on unusable data."""
    df = df.sort_values("timestamp").reset_index(drop=True)

    dupes = df["timestamp"].duplicated().sum()
    if dupes:
        # Keep the last print of a repeated timestamp: on most feeds a repeat
        # is a correction of the earlier one, not a second distinct bar.
        df = df.drop_duplicates("timestamp", keep="last").reset_index(drop=True)

    if df[REQUIRED].isna().any().any():
        bad = df[df[REQUIRED].isna().any(axis=1)]
        raise ValueError(f"{len(bad)} bars contain NaN in OHLCV; clean them first")

    hi_ok = df["high"] >= df[["open", "close"]].max(axis=1) - 1e-9
    lo_ok = df["low"] <= df[["open", "close"]].min(axis=1) + 1e-9
    if not (hi_ok.all() and lo_ok.all()):
        n = int((~(hi_ok & lo_ok)).sum())
        raise ValueError(f"{n} bars have high/low inconsistent with open/close")

    if (df[["open", "high", "low", "close"]] <= 0).any().any():
        raise ValueError("non-positive prices present")

    return df


def synthetic(
    n: int = 5_000,
    start: float = 2_000.0,
    vol: float = 0.001,
    drift: float = 0.0,
    seed: int = 7,
    freq: str = "5min",
) -> pd.DataFrame:
    """Generate geometric-Brownian-motion bars.

    For plumbing tests ONLY. GBM has no trends, no regimes, no volatility
    clustering and no fat tails, so any strategy that looks profitable on
    it is curve-fit to noise. Never use this to judge a strategy.
    """
    rng = np.random.default_rng(seed)
    steps = rng.normal(drift, vol, n)
    close = start * np.exp(np.cumsum(steps))

    # Build an OHLC envelope around each close that respects the invariants.
    open_ = np.concatenate([[start], close[:-1]])
    spread = np.abs(rng.normal(0, vol, n)) * close
    high = np.maximum(open_, close) + spread
    low = np.minimum(open_, close) - spread

    return validate(
        pd.DataFrame(
            {
                "timestamp": pd.date_range("2020-01-01", periods=n, freq=freq),
                "open": open_,
                "high": high,
                "low": low,
                "close": close,
                "volume": rng.integers(1_000, 100_000, n).astype(float),
            }
        )
    )


def train_test_split(
    df: pd.DataFrame, test_frac: float = 0.3
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Split chronologically — never randomly.

    Random k-fold on time series leaks the future into the training set and
    is the single most common way backtests end up lying to you.
    """
    cut = int(len(df) * (1 - test_frac))
    return (
        df.iloc[:cut].reset_index(drop=True),
        df.iloc[cut:].reset_index(drop=True),
    )
