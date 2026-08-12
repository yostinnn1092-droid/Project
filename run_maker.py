#!/usr/bin/env python
"""
Can maker orders rescue the scalper?

    python run_maker.py

The scalper had a real +3.14bp gross edge and lost to a 12bp taker cost.
This tests whether resting limit orders — which earn a rebate instead of
paying a fee — flip it positive, and what that costs in fills you never get.
"""

from __future__ import annotations

from pathlib import Path

from tradingbot import Costs, load_csv, run
from tradingbot.maker import MakerCosts, run_maker
from tradingbot.scalping import ScalpConfig, Scalper, round_trip_cost

DATA = Path(__file__).parent / "data" / "sample_5min.csv"
CFG = ScalpConfig(lookback=20, entry_z=1.5, take_profit=0.003,
                  stop_loss=0.002, max_hold=3, allow_short=True)


def header(t: str) -> None:
    print(f"\n{'=' * 76}\n{t}\n{'=' * 76}")


def main() -> None:
    bars = load_csv(DATA)
    print(f"{len(bars):,} 5min bars  "
          f"({bars['timestamp'].iloc[0]} -> {bars['timestamp'].iloc[-1]})")

    # ---------------------------------------------------------------- 1
    header("1. BASELINE — the same scalper paying taker fees")
    taker = run(bars, Scalper(CFG), costs=Costs(0.0004, 0.0002), bar_freq="5min")
    print(f"  round-trip cost : {round_trip_cost(0.0004, 0.0002) * 1e4:.0f} bp")
    print(f"  return          : {taker.stats['total_return'].strip()}")
    print(f"  sharpe          : {taker.stats['sharpe'].strip()}")
    print(f"  trades          : {taker.stats['n_trades'].strip()}")
    print(f"  fees paid       : {taker.stats['fees_paid'].strip()}")

    # ---------------------------------------------------------------- 2
    header("2. MAKER ORDERS — rebate instead of fee, but fills are not free")
    print("  Limit resting 5bp away; price must trade THROUGH it to fill.\n")
    print(f"{'maker fee':>11}{'taker':>8}{'fills':>8}{'fill%':>8}"
          f"{'fees':>11}{'return':>10}{'sharpe':>9}")
    print("-" * 65)
    for mf in (-0.0001, 0.0, 0.0002, 0.0004):
        mc = MakerCosts(maker_fee=mf, taker_fee=0.0004, offset_bps=5.0)
        r = run_maker(bars, Scalper(CFG), costs=mc)
        d = r.diagnostics
        print(f"{mf * 1e4:>10.0f}bp{0.0004 * 1e4:>7.0f}bp"
              f"{d['orders_filled']:>8}{d['fill_rate']:>7.0%}"
              f"{r.stats['fees_paid'].strip():>11}"
              f"{r.stats['total_return'].strip():>10}"
              f"{r.stats['sharpe'].strip():>9}")

    # ---------------------------------------------------------------- 3
    header("3. THE REAL TRADE-OFF — how far out should the limit rest?")
    print("  Further out = better price when filled, but fewer fills, and\n"
          "  the ones you miss are disproportionately the winners.\n")
    print(f"{'offset':>8}{'attempted':>11}{'filled':>8}{'fill%':>8}"
          f"{'fwd move':>10}{'return':>10}{'sharpe':>9}")
    print("-" * 64)
    for off in (0.0, 2.0, 5.0, 10.0, 20.0):
        mc = MakerCosts(maker_fee=-0.0001, taker_fee=0.0004, offset_bps=off)
        r = run_maker(bars, Scalper(CFG), costs=mc)
        d = r.diagnostics
        print(f"{off:>7.0f}bp{d['orders_attempted']:>11}{d['orders_filled']:>8}"
              f"{d['fill_rate']:>7.0%}{d['mean_fwd_move_after_fill']:>9.3%}"
              f"{r.stats['total_return'].strip():>10}"
              f"{r.stats['sharpe'].strip():>9}")
    print(
        "\n  'fwd move' is the adverse-selection probe: average price move in\n"
        "  YOUR favour over the 3 bars after each fill. Negative means you are\n"
        "  systematically being picked off — filled precisely when the move is\n"
        "  about to continue against you."
    )

    # ---------------------------------------------------------------- 4
    header("4. WHAT IF UNFILLED ORDERS CHASE THE MARKET?")
    print("  Crossing the spread after N unfilled bars recovers the missed\n"
          "  trades — at taker cost, which is the thing we were escaping.\n")
    print(f"{'chase after':>12}{'fills':>8}{'maker%':>9}{'fees':>11}"
          f"{'return':>10}{'sharpe':>9}")
    print("-" * 59)
    for ch in (None, 1, 2, 5):
        mc = MakerCosts(maker_fee=-0.0001, taker_fee=0.0004,
                        offset_bps=5.0, chase_after=ch)
        r = run_maker(bars, Scalper(CFG), costs=mc)
        d = r.diagnostics
        label = "never" if ch is None else f"{ch} bar(s)"
        print(f"{label:>12}{d['orders_filled']:>8}{d['maker_share']:>8.0%}"
              f"{r.stats['fees_paid'].strip():>11}"
              f"{r.stats['total_return'].strip():>10}"
              f"{r.stats['sharpe'].strip():>9}")

    # ---------------------------------------------------------------- 5
    header("5. DECOMPOSITION — is this trading, or rebate farming?")
    print("  The headline says the scalper was rescued. Split the profit into\n"
          "  money made by TRADING and money received as REBATES.\n")
    mc = MakerCosts(maker_fee=-0.0001, taker_fee=0.0004, offset_bps=5.0)
    r = run_maker(bars, Scalper(CFG), costs=mc)
    f = r.fills
    rebate = -float(f["fee"].sum())
    profit = float(r.equity.iloc[-1]) - 10_000.0
    notional = float(f["notional"].sum())

    print(f"  total profit           : {profit:>12,.2f}")
    print(f"  rebate income          : {rebate:>12,.2f}")
    print(f"  trading P&L (residual) : {profit - rebate:>12,.2f}")
    print()
    print(f"  fills                  : {len(f):>12,}")
    print(f"  notional traded        : {notional:>12,.0f}")
    print(f"  turnover vs capital    : {notional / 10_000:>11,.0f}x")

    print(
        "\n  The trading P&L is NEGATIVE. Every dollar of profit is rebate,\n"
        "  and collecting it required turning over ~4,000x the account. That\n"
        "  is not a strategy that was rescued by better execution — it is a\n"
        "  rebate-farming scheme wearing the strategy as a costume.\n"
        "\n  Three independent reasons to reject this result:\n"
        "    1. At a 0bp maker fee (section 2) it LOSES. The signal never\n"
        "       became profitable; only the fee schedule changed.\n"
        "    2. Returns by offset are non-monotonic — -75%, -51%, +38%, -45%,\n"
        "       -17%. A real effect does not spike at one setting and collapse\n"
        "       on both sides of it. That shape means artifact.\n"
        "    3. An 83% fill rate on passive limit orders is not realistic.\n"
        "       This model fills whenever price trades through the level, with\n"
        "       no queue ahead of you and no competition for the fill.\n"
        "\n  Everything here also rests on the venue's actual maker/taker\n"
        "  schedule. The only way to test any of it is to post real orders and\n"
        "  compare the fills you get against what this predicted."
    )


if __name__ == "__main__":
    main()
