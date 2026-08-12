#!/usr/bin/env python
"""
Does Kronos actually forecast better than doing nothing?

    python verify_kronos_forecast.py --kronos-repo /path/to/Kronos
    python verify_kronos_forecast.py --kronos-repo ... --model NeoQuasar/Kronos-base

Compares Kronos against the naive baseline ("assume price does not change")
over N random windows. The windows are chosen ONCE and reused across every
model and setting, so results are directly comparable — an earlier version of
this script varied the windows between runs and produced two numbers that
could not be compared at all.

Two things are measured:

  * mean absolute error, as a fraction of price — how close the forecast is
  * direction accuracy — whether it gets up-vs-down right, which is the only
    part a trader can actually monetise

Direction accuracy is reported against the coin-flip band for the given
sample size. Anything inside that band is indistinguishable from luck, no
matter how good the headline percentage looks.
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

DATA = Path(__file__).parent / "data" / "sample_5min.csv"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--kronos-repo", required=True)
    ap.add_argument("--model", default="NeoQuasar/Kronos-small")
    ap.add_argument("--tokenizer", default="NeoQuasar/Kronos-Tokenizer-base")
    ap.add_argument("--lookback", type=int, default=256)
    ap.add_argument("--horizon", type=int, default=12)
    ap.add_argument("--windows", type=int, default=40)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument(
        "--configs",
        default="0.7:8,1.0:8,1.0:1",
        help="comma-separated temperature:draws pairs",
    )
    args = ap.parse_args()

    sys.path.insert(0, args.kronos_repo)
    from model import Kronos, KronosPredictor, KronosTokenizer

    tok = KronosTokenizer.from_pretrained(args.tokenizer)
    mdl = Kronos.from_pretrained(args.model)
    tok.eval()
    mdl.eval()
    predictor = KronosPredictor(mdl, tok, device="cpu", max_context=512)
    print(f"model:  {args.model}")
    print(f"params: {sum(p.numel() for p in mdl.parameters()):,}")

    df = pd.read_csv(DATA)
    df["timestamp"] = pd.to_datetime(df["timestamp"])

    # Fixed windows, shared by every config. Seed is explicit so a different
    # model can be evaluated later on exactly the same slices of history.
    rng = np.random.default_rng(args.seed)
    starts = sorted(
        rng.choice(
            range(args.lookback, len(df) - args.horizon - 1),
            args.windows,
            replace=False,
        )
    )

    # The naive baseline depends only on the windows, so compute it once.
    naive, truths, lasts = [], [], []
    for s in starts:
        last = float(df["close"].iloc[s - 1])
        truth = df["close"].iloc[s : s + args.horizon].to_numpy(dtype=float)
        naive.append(np.mean(np.abs(last - truth)) / last)
        truths.append(truth)
        lasts.append(last)
    naive_mae = float(np.mean(naive))

    print(f"windows: {args.windows}  lookback: {args.lookback}  "
          f"horizon: {args.horizon}  seed: {args.seed}")
    print(f"NAIVE mean abs error: {naive_mae:.4%} of price  (fixed reference)\n")

    se = np.sqrt(0.25 / args.windows)
    print(f"{'T':>5}{'draws':>7}{'MAE':>10}{'vs naive':>11}{'dir acc':>10}{'sec/fc':>9}")
    print("-" * 52)

    for spec in args.configs.split(","):
        T, draws = spec.split(":")
        T, draws = float(T), int(draws)
        errs, hits = [], []
        t0 = time.time()

        for j, s in enumerate(starts):
            w = df.iloc[s - args.lookback : s]
            x = w[["open", "high", "low", "close", "volume"]].copy()
            x["amount"] = w["volume"].to_numpy() * w["close"].to_numpy()
            step = w["timestamp"].diff().median()
            y_ts = pd.Series(
                [w["timestamp"].iloc[-1] + step * (i + 1) for i in range(args.horizon)]
            )
            p = predictor.predict(
                df=x,
                x_timestamp=pd.Series(w["timestamp"].to_numpy()),
                y_timestamp=y_ts,
                pred_len=args.horizon,
                T=T,
                top_p=0.9,
                sample_count=draws,
                verbose=False,
            )
            fc = p["close"].to_numpy(dtype=float)
            errs.append(np.mean(np.abs(fc - truths[j])) / lasts[j])
            hits.append((fc[-1] - lasts[j]) * (truths[j][-1] - lasts[j]) > 0)

        mae, acc = float(np.mean(errs)), float(np.mean(hits))
        dt = (time.time() - t0) / args.windows
        flag = "" if abs(acc - 0.5) <= 1.96 * se else "  *"
        print(f"{T:>5.1f}{draws:>7}{mae:>10.4%}{mae / naive_mae - 1:>+10.1%}"
              f"{acc:>9.1%}{flag}{dt:>9.2f}")

    print(f"\ncoin-flip 95% band for direction: "
          f"{50 - 196 * se:.1f}% - {50 + 196 * se:.1f}%")
    print("* = outside that band (nothing marked = indistinguishable from luck)")


if __name__ == "__main__":
    main()
