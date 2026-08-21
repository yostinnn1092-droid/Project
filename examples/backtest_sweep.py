"""Sweep strategy parameters over the paper simulator.

    python examples/backtest_sweep.py

Shows how the trigger length and martingale depth change the shape of the
outcome distribution -- and how none of them change the sign of the mean.
"""

import asyncio
import statistics

from baccarat_bot.drivers.paper import PaperDriver
from baccarat_bot.engine import BotEngine
from baccarat_bot.risk import RiskConfig, RiskManager
from baccarat_bot.strategy import Direction, StreakMartingale, StrategyConfig

BALANCE = 1000.0
SESSIONS = 400
ROUNDS = 400


async def run_session(strategy_config, seed):
    driver = PaperDriver(balance=BALANCE, seed=seed)
    engine = BotEngine(
        driver=driver,
        strategy=StreakMartingale(strategy_config),
        risk=RiskManager(RiskConfig(max_rounds=ROUNDS), BALANCE),
        keep_records=False,
    )
    return await engine.run()


async def main():
    variants = {
        "streak 3, 1 step (your rules)": StrategyConfig(),
        "streak 3, no martingale": StrategyConfig(martingale_steps=0),
        "streak 3, 2 steps": StrategyConfig(martingale_steps=2),
        "streak 4, 1 step": StrategyConfig(streak_length=4),
        "streak 5, 1 step": StrategyConfig(streak_length=5),
        "streak 3, against": StrategyConfig(direction=Direction.AGAINST),
    }

    print(f"{'variant':<30} {'mean P&L':>10} {'median':>10} {'worst':>10} {'bust%':>7}")
    print("-" * 71)
    for label, config in variants.items():
        reports = [await run_session(config, seed) for seed in range(SESSIONS)]
        profits = [r.profit for r in reports]
        busts = sum(1 for r in reports if "stop-loss" in r.stop_reason)
        print(
            f"{label:<30} {statistics.mean(profits):>+10.2f} "
            f"{statistics.median(profits):>+10.2f} {min(profits):>+10.2f} "
            f"{busts / len(reports):>6.1%}"
        )


if __name__ == "__main__":
    asyncio.run(main())
