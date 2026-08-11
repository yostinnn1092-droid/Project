"""
Kronos as a signal source.

Kronos (https://github.com/shiyu-coder/Kronos, AAAI 2026) is a decoder-only
foundation model for K-line sequences. It is *generative*: it samples plausible
future candles rather than emitting one point forecast. This module turns that
into a target weight.

WHY GENERATIVE MATTERS HERE
---------------------------
A point forecast tells you where the model thinks price goes. A sampled
distribution also tells you HOW SURE it is — and conviction is exactly what
position sizing needs. Draw N paths; if they all agree on direction, size up;
if they disagree, the model is telling you it does not know, and the correct
response is a small position or none.

Note `KronosPredictor.predict()` averages over `sample_count` internally
(`preds = np.mean(preds, axis=1)`) and throws the spread away. So we draw
paths one at a time and keep them. That costs N sequential inference runs
where a batched implementation would cost roughly one — see `n_paths` below.

FORECAST ACCURACY IS NOT ALPHA
------------------------------
Read this before you get excited. Kronos's published benchmarks measure
forecast accuracy, not trading profit. Those are different things:

  * A model can be right about the *level* and useless about the *direction*.
  * It can be right about direction and still lose after costs, if the
    predicted move is smaller than the spread plus fees.
  * It was trained to reconstruct candles, not to find inefficiency. Nothing
    in its objective rewards profitable trading.

So treat a Kronos edge as a hypothesis to be tested by the same brutal
out-of-sample process as any other, not as a shortcut around it.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from .strategy import Strategy


class KronosSignal(Strategy):
    """Target weight from an ensemble of sampled Kronos price paths.

    Parameters
    ----------
    predictor
        A `KronosPredictor`. Build it with `load_kronos()` below.
    lookback
        Bars of context fed to the model. Must not exceed the checkpoint's
        `max_context` (512 for Kronos-small/base, 2048 for Kronos-mini).
    horizon
        Bars ahead to forecast. The position is held toward this horizon,
        so it should be >= `predict_every`.
    n_paths
        Independent sampled futures per forecast. More paths = a better
        estimate of conviction and a linearly larger compute bill. 8-16 is
        a reasonable range. With 1 path there is no dispersion to measure
        and `uncertainty_scaling` silently does nothing.
    predict_every
        Re-forecast only every k bars, reusing the last target in between.
        This is not an optimisation detail, it is what makes the backtest
        finishable: one forecast is ~0.3-3s, and 20,000 bars x every-bar
        inference is hours. It also reflects how you would really run it.
    entry_threshold
        Ignore predicted moves smaller than this (fraction, e.g. 0.002 =
        20bp). Set it at least as large as your round-trip cost, otherwise
        you are paying the broker to act on noise.
    max_weight
        Cap on |target weight|.
    uncertainty_scaling
        Scale the position by the fraction of paths agreeing on direction.
        Unanimous -> full size; a coin flip -> flat.

        KNOWN LIMITATION, verified empirically: agreement measures the
        model's INTERNAL CONSISTENCY, not its correctness. An untrained
        Kronos on this repo's sample data predicts -4% on every single
        forecast with 100% path agreement — maximally confident and
        completely wrong. A systematically biased model looks maximally
        convicted by this metric. So agreement is a useful *veto* (low
        agreement is real evidence of "don't know") but it is not
        evidence of skill. Only out-of-sample results are that.
    allow_short
        If False, negative signals map to flat instead of short.
    """

    def __init__(
        self,
        predictor,
        lookback: int = 256,
        horizon: int = 12,
        n_paths: int = 8,
        predict_every: int = 12,
        entry_threshold: float = 0.002,
        max_weight: float = 1.0,
        uncertainty_scaling: bool = True,
        allow_short: bool = False,
        temperature: float = 1.0,
        top_p: float = 0.9,
    ):
        if horizon < 1:
            raise ValueError("horizon must be >= 1")
        if n_paths < 1:
            raise ValueError("n_paths must be >= 1")

        self.predictor = predictor
        self.lookback = lookback
        self.horizon = horizon
        self.n_paths = n_paths
        self.predict_every = predict_every
        self.entry_threshold = entry_threshold
        self.max_weight = max_weight
        self.uncertainty_scaling = uncertainty_scaling
        self.allow_short = allow_short
        self.temperature = temperature
        self.top_p = top_p

        self.warmup = lookback + 1
        self._cached_weight = 0.0
        self._bars_seen = 0
        #: Per-forecast diagnostics. Inspect this before trusting anything.
        self.diagnostics: list[dict] = []

    # ------------------------------------------------------------------
    def on_bar(self, history: pd.DataFrame) -> float:
        self._bars_seen += 1

        # Throttle. Between forecasts we simply hold the last target, which
        # is also what a real deployment does between model runs.
        if (self._bars_seen - 1) % self.predict_every != 0:
            return self._cached_weight

        window = history.iloc[-self.lookback :]
        if len(window) < self.lookback:
            return 0.0

        x_df = window[["open", "high", "low", "close", "volume"]].copy()
        # Kronos expects an `amount` (turnover) column. If the feed has none,
        # approximate it; the model tolerates this better than a zero column.
        x_df["amount"] = window["volume"].to_numpy() * window["close"].to_numpy()

        x_ts = pd.Series(window["timestamp"].to_numpy())
        y_ts = self._future_timestamps(x_ts, self.horizon)
        last_close = float(window["close"].iloc[-1])

        paths = self._sample_paths(x_df, x_ts, y_ts)
        if paths is None:
            return self._cached_weight

        # Terminal return of each sampled path, relative to the last real close.
        terminal = paths[:, -1]
        path_returns = terminal / last_close - 1.0

        expected = float(np.mean(path_returns))
        dispersion = float(np.std(path_returns))
        # Conviction: how lopsided is the vote on direction? 0.5 = coin flip.
        up_frac = float(np.mean(path_returns > 0))
        agreement = abs(up_frac - 0.5) * 2.0

        weight = self._to_weight(expected, agreement)
        self._cached_weight = weight

        self.diagnostics.append(
            {
                "timestamp": window["timestamp"].iloc[-1],
                "last_close": last_close,
                "expected_return": expected,
                "dispersion": dispersion,
                "agreement": agreement,
                "target_weight": weight,
            }
        )
        return weight

    # ------------------------------------------------------------------
    def _to_weight(self, expected: float, agreement: float) -> float:
        if abs(expected) < self.entry_threshold:
            return 0.0

        # Scale so a move of exactly `entry_threshold` maps to a small
        # position and larger predicted moves scale up, capped at max_weight.
        raw = np.clip(expected / (self.entry_threshold * 5.0), -1.0, 1.0)
        if self.uncertainty_scaling:
            raw *= agreement

        weight = float(np.clip(raw * self.max_weight, -self.max_weight, self.max_weight))
        if not self.allow_short and weight < 0:
            return 0.0
        return weight

    def _sample_paths(self, x_df, x_ts, y_ts) -> np.ndarray | None:
        """Draw `n_paths` independent close-price paths. Shape (n_paths, horizon)."""
        paths = []
        for _ in range(self.n_paths):
            try:
                pred = self.predictor.predict(
                    df=x_df,
                    x_timestamp=x_ts,
                    y_timestamp=y_ts,
                    pred_len=self.horizon,
                    T=self.temperature,
                    top_p=self.top_p,
                    sample_count=1,  # keep paths separate; see module docstring
                    verbose=False,
                )
            except Exception:
                # A single failed draw must not kill the run. If every draw
                # fails we return None and the caller holds its last target.
                continue
            paths.append(pred["close"].to_numpy(dtype=float))

        if not paths:
            return None
        return np.vstack(paths)

    @staticmethod
    def _future_timestamps(x_ts: pd.Series, horizon: int) -> pd.Series:
        """Extrapolate the timestamps of the bars we are about to predict.

        These must be SYNTHESISED, never read from future rows of the
        dataframe. Reading them would work in a backtest and be impossible
        live, which is the exact shape of a lookahead bug.

        Caveat worth knowing: naive extrapolation by the median bar spacing
        is right for a 24/7 instrument and wrong across a session boundary,
        where the next bar is tomorrow morning rather than five minutes from
        now. Kronos consumes minute/hour/weekday/day/month features, so bad
        timestamps mean bad time features. A production version needs the
        venue's session calendar.
        """
        ts = pd.to_datetime(pd.Series(x_ts).reset_index(drop=True))
        step = ts.diff().dropna().median()
        if pd.isna(step) or step <= pd.Timedelta(0):
            step = pd.Timedelta(minutes=5)
        last = ts.iloc[-1]
        # Exactly `horizon` stamps: KronosPredictor indexes its output frame
        # with these, so any other length raises a shape mismatch.
        return pd.Series([last + step * (i + 1) for i in range(horizon)])

    def diagnostics_frame(self) -> pd.DataFrame:
        return pd.DataFrame(self.diagnostics)


# ----------------------------------------------------------------------
def load_kronos(
    model_id: str = "NeoQuasar/Kronos-small",
    tokenizer_id: str = "NeoQuasar/Kronos-Tokenizer-base",
    device: str | None = None,
    max_context: int = 512,
    kronos_repo: str | None = None,
):
    """Load pretrained Kronos and wrap it in a `KronosPredictor`.

    Requires the Kronos source on `sys.path` (it is not on PyPI):

        git clone https://github.com/shiyu-coder/Kronos
        pip install -r Kronos/requirements.txt

    then either run from that directory or pass `kronos_repo="/path/to/Kronos"`.

    This function deliberately has NO fallback to random weights. An
    untrained Kronos still emits perfectly well-formed candles, a backtest
    over them still produces a tidy equity curve, and that curve is pure
    noise. Silently degrading to it would be the most dangerous thing this
    module could do, so a missing checkpoint is a hard error.
    """
    import sys

    if kronos_repo:
        sys.path.insert(0, str(kronos_repo))

    try:
        from model import Kronos, KronosPredictor, KronosTokenizer
    except ImportError as exc:  # pragma: no cover - environment dependent
        raise ImportError(
            "Kronos source not importable. Clone https://github.com/shiyu-coder/Kronos "
            "and pass kronos_repo=/path/to/Kronos."
        ) from exc

    tokenizer = KronosTokenizer.from_pretrained(tokenizer_id)
    model = Kronos.from_pretrained(model_id)
    model.eval()
    tokenizer.eval()
    return KronosPredictor(model, tokenizer, device=device, max_context=max_context)
