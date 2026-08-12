"""
Indicators — all strictly causal.

Every function here computes value[i] from bars 0..i only. No centred windows,
no `.shift(-1)`, no full-series fits. That constraint is the whole point: an
indicator that peeks is invisible in the code and catastrophic in the results,
and it is the single most common way a backtest lies.

Each returns a full Series aligned to the input index, with NaN during the
warm-up period. Callers must check for NaN rather than assume readiness — a
strategy that trades on a half-formed 200-EMA is trading on noise.
"""

from __future__ import annotations

import numpy as np
import pandas as pd


def ema(series: pd.Series, period: int) -> pd.Series:
    """Exponential moving average.

    `adjust=False` gives the recursive form used by trading platforms
    (MT5, TradingView), so backtest values match what the live chart shows.
    `adjust=True` would weight early observations differently and silently
    disagree with the broker's own indicator.
    """
    return series.ewm(span=period, adjust=False, min_periods=period).mean()


def sma(series: pd.Series, period: int) -> pd.Series:
    return series.rolling(period, min_periods=period).mean()


def true_range(df: pd.DataFrame) -> pd.Series:
    """max(high-low, |high-prev_close|, |low-prev_close|)."""
    h, l, c = df["high"], df["low"], df["close"]
    pc = c.shift(1)
    return pd.concat([h - l, (h - pc).abs(), (l - pc).abs()], axis=1).max(axis=1)


def atr(df: pd.DataFrame, period: int = 14) -> pd.Series:
    """Average True Range, Wilder-smoothed.

    Wilder's smoothing (alpha = 1/period) is what MT5's iATR uses. A simple
    rolling mean is a different number, and stop distances sized from the
    wrong one will not match the platform.
    """
    tr = true_range(df)
    return tr.ewm(alpha=1.0 / period, adjust=False, min_periods=period).mean()


def rsi(series: pd.Series, period: int = 14) -> pd.Series:
    """Wilder's RSI."""
    delta = series.diff()
    gain = delta.clip(lower=0.0)
    loss = (-delta).clip(lower=0.0)
    avg_gain = gain.ewm(alpha=1.0 / period, adjust=False, min_periods=period).mean()
    avg_loss = loss.ewm(alpha=1.0 / period, adjust=False, min_periods=period).mean()
    rs = avg_gain / avg_loss.replace(0.0, np.nan)
    out = 100.0 - (100.0 / (1.0 + rs))
    # avg_loss == 0 means an unbroken run of gains: RSI is 100 by definition.
    return out.fillna(100.0).where(avg_gain.notna(), np.nan)


def adx(df: pd.DataFrame, period: int = 14) -> pd.DataFrame:
    """Wilder's ADX with +DI and -DI.

    Returns columns: adx, plus_di, minus_di.

    ADX measures trend STRENGTH, not direction — a strong downtrend and a
    strong uptrend both read high. Direction comes from the EMA stack; ADX
    only answers "is there enough trend here to bother".
    """
    h, l, c = df["high"], df["low"], df["close"]
    up = h.diff()
    down = -l.diff()

    plus_dm = np.where((up > down) & (up > 0), up, 0.0)
    minus_dm = np.where((down > up) & (down > 0), down, 0.0)

    tr = true_range(df)
    atr_ = tr.ewm(alpha=1.0 / period, adjust=False, min_periods=period).mean()

    plus_s = pd.Series(plus_dm, index=df.index).ewm(
        alpha=1.0 / period, adjust=False, min_periods=period).mean()
    minus_s = pd.Series(minus_dm, index=df.index).ewm(
        alpha=1.0 / period, adjust=False, min_periods=period).mean()

    safe_atr = atr_.replace(0.0, np.nan)
    plus_di = 100.0 * plus_s / safe_atr
    minus_di = 100.0 * minus_s / safe_atr

    denom = (plus_di + minus_di).replace(0.0, np.nan)
    dx = 100.0 * (plus_di - minus_di).abs() / denom
    adx_ = dx.ewm(alpha=1.0 / period, adjust=False, min_periods=period).mean()

    return pd.DataFrame({"adx": adx_, "plus_di": plus_di, "minus_di": minus_di})


def body_fraction(df: pd.DataFrame) -> pd.Series:
    """|close - open| / (high - low). Candle conviction, in [0, 1].

    A pin bar scores near 0 (indecision); a marubozu near 1 (commitment).
    Used to reject entries on candles that closed without conviction.
    """
    rng = (df["high"] - df["low"]).replace(0.0, np.nan)
    return ((df["close"] - df["open"]).abs() / rng).fillna(0.0)


def resample_closed(df: pd.DataFrame, rule: str, now: pd.Timestamp) -> pd.DataFrame:
    """Resample to a higher timeframe, keeping only COMPLETED bars.

    This is the multi-timeframe lookahead trap. Resampling H1 to H4 at 09:00
    produces an H4 bar covering 08:00-12:00 whose high, low and close include
    prices that have not happened yet. Using it to decide the regime is
    reading the future — and it is invisible, because the code looks like
    ordinary resampling.

    The fix: drop the final bucket unless `now` is at or past its end. The
    strategy therefore always reasons from the last H4 candle that genuinely
    closed, exactly as it would live.
    """
    if df.empty:
        return df

    g = (
        df.set_index("timestamp")
        .resample(rule, label="left", closed="left")
        .agg({"open": "first", "high": "max", "low": "min",
              "close": "last", "volume": "sum"})
        .dropna(subset=["open", "high", "low", "close"])
    )
    if g.empty:
        return g.reset_index()

    period = pd.tseries.frequencies.to_offset(rule)
    last_start = g.index[-1]
    # The final bucket is only complete once `now` has reached its end.
    if pd.Timestamp(now) < last_start + period:
        g = g.iloc[:-1]
    return g.reset_index()
