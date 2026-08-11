#!/usr/bin/env python
"""
Backtest the Kronos signal.

    python run_kronos.py --kronos-repo /path/to/Kronos          # real weights
    python run_kronos.py --kronos-repo /path/to/Kronos --smoke  # wiring only

WITHOUT `--smoke` this requires the pretrained checkpoints from Hugging Face
(NeoQuasar/Kronos-small + NeoQuasar/Kronos-Tokenizer-base) and will fail
loudly if they cannot be fetched. That failure is deliberate: see below.

`--smoke` builds Kronos with RANDOM weights to prove the plumbing works. It
prints no performance table, because performance from an untrained model is
noise and printing it would invite exactly the mistake this whole repo is
about. An untrained Kronos emits well-formed candles and produces a tidy
equity curve that means nothing whatsoever.
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

from tradingbot import BuyAndHold, Costs, RiskLimits, RiskManager, load_csv, run
from tradingbot.kronos_signal import KronosSignal, load_kronos

DATA = Path(__file__).parent / "data" / "sample_5min.csv"
FREQ = "5min"


def build_smoke_predictor(kronos_repo: str):
    """Kronos-small's real architecture, random weights. Wiring test only."""
    sys.path.insert(0, kronos_repo)
    import torch
    from model import Kronos, KronosPredictor, KronosTokenizer

    torch.manual_seed(0)
    # Hyperparameters are the published Kronos-small config.json.
    tokenizer = KronosTokenizer(
        d_in=6, d_model=256, n_heads=4, ff_dim=512,
        n_enc_layers=2, n_dec_layers=2,
        ffn_dropout_p=0.0, attn_dropout_p=0.0, resid_dropout_p=0.0,
        s1_bits=10, s2_bits=10,
        beta=0.25, gamma0=1.0, gamma=1.0, zeta=1.0, group_size=2,
    )
    model = Kronos(
        s1_bits=10, s2_bits=10, n_layers=8, d_model=512, n_heads=8, ff_dim=1024,
        ffn_dropout_p=0.0, attn_dropout_p=0.0, resid_dropout_p=0.0,
        token_dropout_p=0.0, learn_te=True,
    )
    tokenizer.eval()
    model.eval()
    return KronosPredictor(model, tokenizer, device="cpu", max_context=512)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--kronos-repo", required=True, help="path to cloned Kronos")
    ap.add_argument("--smoke", action="store_true", help="random weights, no metrics")
    ap.add_argument("--bars", type=int, default=2_000)
    ap.add_argument("--lookback", type=int, default=256)
    ap.add_argument("--horizon", type=int, default=12)
    ap.add_argument("--paths", type=int, default=8)
    ap.add_argument("--every", type=int, default=12)
    args = ap.parse_args()

    bars = load_csv(DATA).tail(args.bars).reset_index(drop=True)
    print(f"Bars: {len(bars):,}  {bars['timestamp'].iloc[0]} -> {bars['timestamp'].iloc[-1]}")

    if args.smoke:
        print("\n*** SMOKE TEST — RANDOM WEIGHTS — NUMBERS ARE MEANINGLESS ***\n")
        predictor = build_smoke_predictor(args.kronos_repo)
    else:
        predictor = load_kronos(kronos_repo=args.kronos_repo)

    signal = KronosSignal(
        predictor,
        lookback=args.lookback,
        horizon=args.horizon,
        n_paths=args.paths,
        predict_every=args.every,
        entry_threshold=0.002,
        uncertainty_scaling=True,
        allow_short=False,
    )

    n_forecasts = max(0, (len(bars) - signal.warmup)) // args.every
    print(f"Forecasts to run: ~{n_forecasts}  "
          f"({args.paths} paths x {args.horizon} steps each)")

    t0 = time.time()
    result = run(
        bars,
        signal,
        costs=Costs(commission=0.0004, slippage=0.0002),
        risk=RiskManager(RiskLimits(max_position=1.0, max_drawdown=0.20)),
        bar_freq=FREQ,
    )
    elapsed = time.time() - t0

    diag = signal.diagnostics_frame()
    print(f"\nCompleted in {elapsed:.1f}s "
          f"({elapsed / max(len(diag), 1):.2f}s per forecast)")

    if diag.empty:
        print("No forecasts produced — every sampling attempt failed.")
        return

    # Signal-quality diagnostics are meaningful even in smoke mode: they
    # describe what the model SAID, not whether it made money.
    print("\nSignal diagnostics")
    print(f"  forecasts:             {len(diag)}")
    print(f"  mean |expected move|:  {diag['expected_return'].abs().mean():.4%}")
    print(f"  mean path dispersion:  {diag['dispersion'].mean():.4%}")
    print(f"  mean direction agree:  {diag['agreement'].mean():.2%}")
    print(f"  bars with a position:  {(diag['target_weight'] != 0).mean():.1%}")

    if args.smoke:
        print(
            "\nWiring verified. Performance intentionally NOT reported:\n"
            "  an untrained model's equity curve is noise, and reporting it\n"
            "  is how people talk themselves into trading noise.\n"
            "  Re-run without --smoke once the checkpoints are reachable."
        )
        return

    bh = run(bars, BuyAndHold(), costs=Costs(0.0004, 0.0002), bar_freq=FREQ)
    print("\nPerformance vs buy-and-hold")
    keys = list(result.stats)
    width = max(len(k) for k in keys) + 2
    print(f"{'':<{width}}{'Kronos':>16}{'BuyAndHold':>16}")
    for k in keys:
        print(f"{k:<{width}}{result.stats[k]:>16}{bh.stats[k]:>16}")
    if result.halt_reason:
        print(f"\n  HALTED: {result.halt_reason}")
    print(
        "\n  One backtest on one instrument is a hypothesis, not a result.\n"
        "  Before believing it: walk-forward across multiple periods, test on\n"
        "  instruments you did not tune on, and check the edge survives a\n"
        "  doubling of your assumed costs."
    )


if __name__ == "__main__":
    main()
