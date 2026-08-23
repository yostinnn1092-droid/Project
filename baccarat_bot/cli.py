"""Command line entry point."""

from __future__ import annotations

import argparse
import asyncio
import logging
import statistics
import sys
from typing import List, Optional

from .config import BotConfig
from .drivers.paper import PaperDriver
from .drivers.stake import StakeDriver
from .engine import BotEngine, SessionReport
from .risk import RiskManager
from .strategy import Direction, StreakMartingale


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="baccarat-bot",
        description="Streak-triggered baccarat bot with a single martingale step.",
    )
    parser.add_argument(
        "mode",
        choices=("paper", "backtest", "live"),
        help="paper: one simulated session; backtest: many sessions; "
        "live: real money via StakeAPI",
    )
    parser.add_argument("--rounds", type=int, default=500, help="max coups per session")
    parser.add_argument("--sessions", type=int, default=1000, help="backtest sessions")
    parser.add_argument("--balance", type=float, help="starting balance (paper only)")
    parser.add_argument("--stake-pct", type=float, help="base stake fraction")
    parser.add_argument("--streak", type=int, help="run length that triggers a bet")
    parser.add_argument(
        "--direction",
        choices=[d.value for d in Direction],
        help="bet with the streak (follow) or against it",
    )
    parser.add_argument("--martingale-steps", type=int, help="doubling steps after a loss")
    parser.add_argument("--stop-loss", type=float, help="stop-loss fraction")
    parser.add_argument("--take-profit", type=float, help="take-profit fraction")
    parser.add_argument("--seed", type=int, help="RNG seed for reproducible runs")
    parser.add_argument("--delay", type=float, help="seconds between coups")
    parser.add_argument(
        "--live-fire",
        action="store_true",
        help="live mode only: actually place bets (default is a refusal)",
    )
    parser.add_argument("-v", "--verbose", action="store_true")
    return parser


def _apply_overrides(config: BotConfig, args: argparse.Namespace) -> BotConfig:
    if args.stake_pct is not None:
        config.strategy.stake_pct = args.stake_pct
    if args.streak is not None:
        config.strategy.streak_length = args.streak
    if args.direction is not None:
        config.strategy.direction = Direction(args.direction)
    if args.martingale_steps is not None:
        config.strategy.martingale_steps = args.martingale_steps
    if args.stop_loss is not None:
        config.risk.stop_loss_pct = args.stop_loss
    if args.take_profit is not None:
        config.risk.take_profit_pct = args.take_profit
    if args.balance is not None:
        config.paper_balance = args.balance
    if args.delay is not None:
        config.delay = args.delay
    if args.rounds is not None:
        config.risk.max_rounds = args.rounds
    # Re-run validation now that overrides are in.
    config.strategy.__post_init__()
    config.risk.__post_init__()
    return config


async def _run_paper(config: BotConfig, seed: Optional[int], delay: float) -> SessionReport:
    driver = PaperDriver(balance=config.paper_balance, seed=seed)
    engine = BotEngine(
        driver=driver,
        strategy=StreakMartingale(config.strategy),
        risk=RiskManager(config.risk, config.paper_balance),
        delay=delay,
    )
    try:
        return await engine.run()
    finally:
        await driver.close()


async def _run_backtest(config: BotConfig, sessions: int, seed: Optional[int]) -> int:
    results: List[SessionReport] = []
    base = seed if seed is not None else 0
    for i in range(sessions):
        results.append(await _run_paper(config, seed=base + i, delay=0.0))

    profits = [r.profit for r in results]
    rois = [r.roi for r in results]
    winners = sum(1 for p in profits if p > 0)
    busts = sum(1 for r in results if "stop-loss" in r.stop_reason)
    bets = [r.bets for r in results]

    print(f"sessions            : {len(results)}")
    print(f"starting balance    : {config.paper_balance:.2f}")
    print(f"bets per session    : mean {statistics.mean(bets):.1f}")
    print(f"profitable sessions : {winners} ({winners / len(results):.1%})")
    print(f"stop-loss hit       : {busts} ({busts / len(results):.1%})")
    print(f"mean P&L            : {statistics.mean(profits):+.2f}")
    print(f"median P&L          : {statistics.median(profits):+.2f}")
    print(f"mean ROI            : {statistics.mean(rois):+.2%}")
    if len(profits) > 1:
        print(f"P&L std dev         : {statistics.stdev(profits):.2f}")
    print(f"best / worst        : {max(profits):+.2f} / {min(profits):+.2f}")
    return 0


async def _run_live(config: BotConfig, args: argparse.Namespace) -> int:
    try:
        from stakeapi import StakeAPI
    except ImportError:
        print(
            "The 'stakeapi' package is not installed. Install it with:\n"
            "  pip install stakeapi",
            file=sys.stderr,
        )
        return 2

    if not args.live_fire:
        print(
            "Refusing to bet real money without --live-fire.\n"
            "Before you use it, read the warning at the top of "
            "baccarat_bot/drivers/stake.py: the baccarat mutation in this "
            "repo is an unverified guess, and observation coups cost money.",
            file=sys.stderr,
        )
        return 2

    creds = config.credentials
    creds.validate()

    # The PyPI build of stakeapi predates Cloudflare support and silently
    # lacks these parameters, which makes stake.com unreachable. Fail with
    # an actionable message rather than a bare TypeError.
    import inspect

    params = inspect.signature(StakeAPI.__init__).parameters
    if "cf_clearance" not in params:
        print(
            "The installed 'stakeapi' has no cf_clearance support, so it "
            "cannot authenticate against stake.com. Reinstall from source:\n"
            "  pip install 'stakeapi @ "
            "git+https://github.com/brokechubb/StakeAPI.git'",
            file=sys.stderr,
        )
        return 2

    client = StakeAPI(
        access_token=creds.access_token,
        cf_clearance=creds.cf_clearance,
        user_agent=creds.user_agent,
        base_url=creds.base_url,
    )
    driver = StakeDriver(
        client=client,
        currency=creds.currency,
        observe_stake=config.observe_stake,
        dry_run=False,
    )
    async with client:
        balance = await driver.get_balance()
        if balance <= 0:
            print(f"no {creds.currency} balance available", file=sys.stderr)
            return 1
        print(f"live session starting on {creds.base_url} "
              f"with {balance:.8f} {creds.currency}")
        engine = BotEngine(
            driver=driver,
            strategy=StreakMartingale(config.strategy),
            risk=RiskManager(config.risk, balance),
            delay=config.delay,
        )
        report = await engine.run()
    print(report.summary())
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    args = _build_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s",
        datefmt="%H:%M:%S",
    )

    config = _apply_overrides(BotConfig.from_env(), args)

    if args.mode == "paper":
        report = asyncio.run(
            _run_paper(config, args.seed, args.delay if args.delay is not None else 0.0)
        )
        print(report.summary())
        return 0
    if args.mode == "backtest":
        logging.getLogger("baccarat_bot").setLevel(logging.WARNING)
        return asyncio.run(_run_backtest(config, args.sessions, args.seed))
    return asyncio.run(_run_live(config, args))


if __name__ == "__main__":
    raise SystemExit(main())
