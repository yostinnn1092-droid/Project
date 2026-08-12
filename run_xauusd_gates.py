#!/usr/bin/env python
"""
The two gates the XAUUSD system must clear before paper trading.

    python run_xauusd_gates.py

GATE 1 — WALK-FORWARD. Re-tune on the past, trade the next stretch blind,
roll forward. A single backtest says "these settings fit this history". This
asks whether a procedure you could actually have followed live produces
anything, and whether the chosen parameters are stable or thrash from window
to window (thrashing means the tuner is fitting noise).

GATE 2 — SEARCH NOISE. Compare against random entries carrying identical
stops and targets. Any fixed-R system has a characteristic win/loss shape;
this isolates whether the SETUP contributes, or whether the risk management
is producing the curve on its own.

Neither gate can prove a strategy works. Both can show it does not, which is
the cheaper and more common outcome, and the one worth finding before money
is involved.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

from tradingbot import BuyAndHold, Costs, load_csv, run
from tradingbot.ict import ICTConfig, RandomEntry
from tradingbot.walkforward import walk_forward
from xauusd import BotConfig, TrendPullbackStrategy

DATA = Path(__file__).parent / "data" / "gold_h1" / "GC.csv"
COSTS = Costs(commission=0.0, slippage=0.0001)

# Deliberately small. Every extra combination inflates the winner by search
# alone, so a wide grid would need a correspondingly harsher noise threshold.
GRID = {"atr_stop_mult": [1.5, 2.5], "tp2_r": [2.0, 3.0], "adx_min": [15.0, 25.0]}
TRAIN, TEST = 1500, 500


def header(t: str) -> None:
    print(f"\n{'=' * 78}\n{t}\n{'=' * 78}")


def boot(x: np.ndarray) -> tuple[float, float, float]:
    rng = np.random.default_rng(0)
    bs = np.array([rng.choice(x, len(x), replace=True).mean() for _ in range(20_000)])
    lo, hi = np.percentile(bs, [2.5, 97.5])
    return lo, hi, float((bs > 0).mean())


def verdict(lo: float, hi: float) -> str:
    if lo > 0:
        return "SIGNIFICANTLY POSITIVE"
    if hi < 0:
        return "SIGNIFICANTLY NEGATIVE"
    return "INCONCLUSIVE — CI includes zero"


def make(atr_stop_mult: float, tp2_r: float, adx_min: float):
    cfg = BotConfig()
    cfg.execution.mode = "backtest"
    cfg.risk.atr_stop_mult = atr_stop_mult
    cfg.risk.take_profit_2_r = tp2_r
    cfg.risk.take_profit_1_r = min(cfg.risk.take_profit_1_r, tp2_r - 0.5)
    cfg.regime.adx_min = adx_min
    return TrendPullbackStrategy(cfg)


def main() -> None:
    if not DATA.exists():
        print("No data. Run: python fetch_stocks.py --gold")
        return
    bars = load_csv(DATA)
    print(f"XAUUSD proxy: {len(bars):,} H1 bars  "
          f"{bars['timestamp'].iloc[0]:%Y-%m-%d} -> {bars['timestamp'].iloc[-1]:%Y-%m-%d}")
    print(f"grid: {GRID}  ({np.prod([len(v) for v in GRID.values()]):.0f} combos)")
    print(f"train {TRAIN} / test {TEST} bars per window")

    # ---------------------------------------------------------------- 1
    header("GATE 1 — WALK-FORWARD")
    res = walk_forward(
        bars,
        strategy_factory=make,
        param_grid=GRID,
        train_size=TRAIN,
        test_size=TEST,
        warmup=850,          # H4 EMA200 needs ~800 H1 bars
        costs=COSTS,
        bar_freq="1h",
        benchmark_factory=BuyAndHold,
    )
    df = res.frame()
    if df.empty:
        print("  No complete windows — not enough data for these sizes.")
        return

    print(f"{'#':>3}{'test period':>26}{'params':>22}{'return':>10}"
          f"{'B&H':>10}{'excess':>10}")
    print("-" * 82)
    for w in res.windows:
        p = (f"{w.params['atr_stop_mult']}/{w.params['tp2_r']}/"
             f"{w.params['adx_min']:.0f}")
        period = f"{w.test_start:%Y-%m-%d} - {w.test_end:%Y-%m-%d}"
        ex = w.test_return - w.benchmark_return
        print(f"{w.index:>3}{period:>26}{p:>22}{w.test_return:>10.2%}"
              f"{w.benchmark_return:>10.2%}{ex:>10.2%}")

    r = df["test_return"].to_numpy()
    b = df["benchmark_return"].to_numpy()
    e = r - b
    s = res.summary()
    lo, hi, p = boot(e)

    print(f"\n  windows                : {len(r)}")
    print(f"  profitable             : {int((r > 0).sum())}/{len(r)}")
    print(f"  beat buy-and-hold      : {int((e > 0).sum())}/{len(r)}")
    print(f"  mean return            : {r.mean():>8.2%}")
    print(f"  mean excess over B&H   : {e.mean():>8.2%}")
    print(f"  distinct param sets    : {s['distinct_param_sets']}/{len(r)}")
    print(f"  95% CI (excess)        : [{lo:.2%}, {hi:.2%}]")
    print(f"  P(excess > 0)          : {p:>8.1%}")
    print(f"\n  VERDICT: {verdict(lo, hi)}")
    if s["distinct_param_sets"] > len(r) * 0.6:
        print("  Parameters change nearly every window — the tuner is fitting\n"
              "  noise, so 'learning from the last window' carries nothing.")

    # ---------------------------------------------------------------- 2
    header("GATE 2 — SEARCH NOISE: strategy vs random entries")
    base = TrendPullbackStrategy(BotConfig())
    base_run = run(bars, base, costs=COSTS, bar_freq="1h")
    base_ret = float(base_run.stats["total_return"].strip().rstrip("%")) / 100
    n_trades = base.performance().get("n_trades", 0)

    rnd = []
    for seed in range(20):
        rs = RandomEntry(
            ICTConfig(killzone_only=False, risk_reward=2.5, max_hold=72),
            entry_prob=max(n_trades / max(len(bars), 1), 1e-4), seed=seed)
        rr = run(bars, rs, costs=COSTS, bar_freq="1h")
        rnd.append(float(rr.stats["total_return"].strip().rstrip("%")) / 100)
    rnd = np.array(rnd)

    print(f"  strategy                 : {base_ret:>8.2%}  ({n_trades} trades)")
    print(f"  random mean / best / worst: {rnd.mean():>7.2%} / "
          f"{rnd.max():.2%} / {rnd.min():.2%}")
    print(f"  beat random on           : {int((base_ret > rnd).sum())}/20 seeds")
    print(f"  beat the BEST random     : {'YES' if base_ret > rnd.max() else 'NO'}")

    header("DECISION")
    passed_wf = lo > 0
    passed_noise = base_ret > rnd.max()
    print(f"  Gate 1 (walk-forward)  : {'PASS' if passed_wf else 'FAIL'}")
    print(f"  Gate 2 (beats noise)   : {'PASS' if passed_noise else 'FAIL'}")
    if passed_wf and passed_noise:
        print("\n  Both gates cleared. That justifies PAPER TRADING — weeks of it,\n"
              "  comparing real fills against what the backtest predicted. It\n"
              "  does not justify live capital.")
    else:
        print("\n  A gate failed, so the strategy does not proceed to paper\n"
              "  trading in its current form. That is the system working: it\n"
              "  cost an afternoon instead of an account.")


if __name__ == "__main__":
    main()
