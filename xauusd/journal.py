"""
Decision journal.

Every decision is recorded, including the decision NOT to trade and the
reason for it. That is deliberate: a log containing only entries answers
"what did it do?" but not "why didn't it?", and the second question is the
one you need when a strategy stops trading, or trades something you did not
expect.

Each record carries the config fingerprint, so any line can be traced back to
the exact parameter set that produced it.

Two sinks, both append-only:
  * JSONL — machine-readable, one object per line, for analysis
  * human log — readable at a glance while watching it run

Nothing here filters losing trades. The statistics are computed from the full
record or not at all.
"""

from __future__ import annotations

import json
import logging
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


@dataclass
class Decision:
    """One evaluation of one bar."""

    timestamp: str
    bar_time: str
    symbol: str
    action: str                     # "enter_long" | "enter_short" | "no_trade"
                                    # | "scale_out" | "exit" | "halt"
    reason: str
    config_fingerprint: str
    price: float | None = None
    regime: str | None = None
    stop: float | None = None
    tp1: float | None = None
    tp2: float | None = None
    lots: float | None = None
    risk_pct_intended: float | None = None
    risk_pct_actual: float | None = None
    equity: float | None = None
    spread: float | None = None
    indicators: dict[str, Any] = field(default_factory=dict)
    rejections: list[str] = field(default_factory=list)


class Journal:
    def __init__(self, path: str | Path = "journal", fingerprint: str = "",
                 echo: bool = True):
        self.dir = Path(path)
        self.dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        self.jsonl = self.dir / f"decisions_{stamp}.jsonl"
        self.fingerprint = fingerprint
        self.records: list[Decision] = []

        self.log = logging.getLogger("xauusd")
        if echo and not self.log.handlers:
            self.log.setLevel(logging.INFO)
            h = logging.StreamHandler()
            h.setFormatter(logging.Formatter("%(asctime)s %(levelname)-7s %(message)s"))
            self.log.addHandler(h)
            fh = logging.FileHandler(self.dir / f"run_{stamp}.log", encoding="utf-8")
            fh.setFormatter(logging.Formatter("%(asctime)s %(levelname)-7s %(message)s"))
            self.log.addHandler(fh)

    def record(self, d: Decision) -> None:
        d.config_fingerprint = d.config_fingerprint or self.fingerprint
        self.records.append(d)
        with self.jsonl.open("a", encoding="utf-8") as f:
            f.write(json.dumps(asdict(d), default=str) + "\n")

        if d.action == "no_trade":
            self.log.debug("%s no_trade: %s", d.bar_time, d.reason)
        else:
            self.log.info(
                "%s %s @ %s | SL %s TP1 %s TP2 %s | lots %s (%.3f%% risk) | %s",
                d.bar_time, d.action.upper(), d.price, d.stop, d.tp1, d.tp2,
                d.lots, d.risk_pct_actual or 0.0, d.reason)

    # ------------------------------------------------------------------
    def summary(self) -> dict:
        """Counts by action and the most common rejection reasons.

        Rejection reasons are the useful half: they show whether the bot is
        idle because conditions are absent or because a filter is misconfigured
        and rejecting everything.
        """
        from collections import Counter

        actions = Counter(r.action for r in self.records)
        rejects = Counter(
            reason for r in self.records if r.action == "no_trade"
            for reason in ([r.reason] if r.reason else [])
        )
        return {
            "total_decisions": len(self.records),
            "by_action": dict(actions),
            "top_no_trade_reasons": rejects.most_common(10),
            "config_fingerprint": self.fingerprint,
            "journal_file": str(self.jsonl),
        }
