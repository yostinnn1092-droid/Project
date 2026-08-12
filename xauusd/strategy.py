"""
The XAUUSD H1 trend-pullback strategy.

Flow, evaluated once per CLOSED H1 bar:

    H4 regime  ->  H1 trend agreement  ->  pullback into the EMA zone
                ->  rejection + candle confirmation  ->  optional RSI
                ->  structure headroom  ->  stop from ATR vs swing
                ->  risk-based size  ->  order

Any step may veto, and the reason is journalled. Most bars produce
`no_trade`, which is the intended behaviour of a trend-pullback system: the
setup is specific, and forcing trades when it is absent is how a filter
becomes a random entry generator.

POSITION SIZE IS EQUITY-INDEPENDENT BY CONSTRUCTION
---------------------------------------------------
The strategy returns a target weight (fraction of equity), derived from the
risk budget and the stop distance:

    weight = (risk_pct / 100) x entry_price / stop_distance

A move of `stop_distance` against a position of that weight loses exactly
`risk_pct` of equity, whatever the equity happens to be. The same number
converts to lots against the broker's spec in live trading, so backtest and
live size identically.

Position size NEVER increases after a loss. There is no averaging down, no
grid, no recovery multiplier. Size depends only on the current stop distance
and the fixed risk percentage.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from tradingbot.strategy import Strategy

from .config import BotConfig
from .indicators import adx, atr, body_fraction, ema, resample_closed, rsi
from .journal import Decision, Journal
from .structure import (
    build_zones,
    find_swings,
    headroom_ok,
    recent_swing_high,
    recent_swing_low,
)


@dataclass
class OpenTrade:
    direction: int          # +1 long, -1 short
    entry: float
    stop: float
    tp1: float
    tp2: float
    initial_weight: float
    weight: float
    bars_held: int = 0
    tp1_filled: bool = False
    entry_bar: int = 0
    r_distance: float = 0.0


@dataclass
class TradeRecord:
    entry_time: pd.Timestamp
    exit_time: pd.Timestamp
    direction: int
    entry: float
    exit: float
    r_multiple: float
    reason: str
    bars_held: int
    tp1_filled: bool


class TrendPullbackStrategy(Strategy):
    """Rules-based H4-regime / H1-pullback system for XAUUSD."""

    def __init__(self, config: BotConfig | None = None,
                 journal: Journal | None = None):
        self.cfg = config or BotConfig()
        problems = self.cfg.validate()
        if problems:
            raise ValueError("invalid config: " + "; ".join(problems))

        self.journal = journal
        c = self.cfg
        self.warmup = max(
            c.entry.ema_trend,
            c.structure.lookback_bars,
            c.regime.ema_slow * 4,   # H4 EMA200 needs ~800 H1 bars
        ) + 10

        self.trade: OpenTrade | None = None
        self.trades: list[TradeRecord] = []
        self._bar = 0
        self._h4_cache: tuple[pd.Timestamp, str, dict] | None = None

    # ------------------------------------------------------------------
    def sync_position(self, actual_weight: float) -> None:
        """Reconcile with reality before deciding (see Strategy.sync_position)."""
        if actual_weight == 0.0 and self.trade is not None:
            self.trade = None
        elif actual_weight != 0.0 and self.trade is not None:
            self.trade.weight = abs(actual_weight)

    # ------------------------------------------------------------------
    def on_bar(self, history: pd.DataFrame) -> float:
        self._bar = len(history) - 1
        if len(history) < self.warmup:
            return 0.0

        ctx = self._context(history)
        if ctx is None:
            return self._log_no_trade(history, "indicators not warm")

        if self.trade is not None:
            return self._manage(history, ctx)
        return self._look_for_entry(history, ctx)

    # ------------------------------------------------------------------
    def _context(self, h: pd.DataFrame) -> dict | None:
        """Indicator snapshot for the current bar. None while warming up."""
        c = self.cfg
        # Bounded tail: every lookback is finite, and rescanning full history
        # each bar is what makes a backtest take hours instead of seconds.
        need = max(self.warmup, c.regime.ema_slow * 5)
        h = h.iloc[-need:] if len(h) > need else h

        close = h["close"]
        a = atr(h, c.risk.atr_period)
        e_trend = ema(close, c.entry.ema_trend)
        e_fast = ema(close, c.entry.ema_fast)
        e_slow = ema(close, c.entry.ema_slow)
        r = rsi(close, c.entry.rsi_period)
        bf = body_fraction(h)

        if any(pd.isna(x.iloc[-1]) for x in (a, e_trend, e_fast, e_slow)):
            return None

        regime, rdata = self._regime(h)

        return {
            "h": h,
            "price": float(close.iloc[-1]),
            "open": float(h["open"].iloc[-1]),
            "high": float(h["high"].iloc[-1]),
            "low": float(h["low"].iloc[-1]),
            "atr": float(a.iloc[-1]),
            "ema_trend": float(e_trend.iloc[-1]),
            "ema_fast": float(e_fast.iloc[-1]),
            "ema_slow": float(e_slow.iloc[-1]),
            "rsi": float(r.iloc[-1]) if not pd.isna(r.iloc[-1]) else np.nan,
            "rsi_prev": float(r.iloc[-2]) if len(r) > 1 and not pd.isna(r.iloc[-2]) else np.nan,
            "body_frac": float(bf.iloc[-1]),
            "regime": regime,
            "regime_data": rdata,
            "timestamp": h["timestamp"].iloc[-1],
        }

    def _regime(self, h: pd.DataFrame) -> tuple[str, dict]:
        """H4 regime from CLOSED H4 bars only.

        Recomputed only when a new H4 bar closes — the resample is the
        expensive part and its answer cannot change until then.
        """
        c = self.cfg.regime
        now = pd.Timestamp(h["timestamp"].iloc[-1])

        if self._h4_cache is not None:
            cached_at, regime, data = self._h4_cache
            if now < cached_at + pd.Timedelta(hours=4):
                return regime, data

        h4 = resample_closed(h, "4h", now)
        if len(h4) < c.ema_slow + c.adx_period + 5:
            out = ("unknown", {"reason": "insufficient H4 history"})
            self._h4_cache = (now, *out)
            return out

        ef = ema(h4["close"], c.ema_fast)
        es = ema(h4["close"], c.ema_slow)
        ax = adx(h4, c.adx_period)

        if pd.isna(es.iloc[-1]) or pd.isna(ax["adx"].iloc[-1]):
            out = ("unknown", {"reason": "H4 indicators not warm"})
            self._h4_cache = (now, *out)
            return out

        price = float(h4["close"].iloc[-1])
        fast, slow = float(ef.iloc[-1]), float(es.iloc[-1])
        adx_v = float(ax["adx"].iloc[-1])

        data = {"h4_close": price, "h4_ema_fast": fast, "h4_ema_slow": slow,
                "h4_adx": adx_v, "h4_bar": str(h4["timestamp"].iloc[-1])}

        strong = adx_v >= c.adx_min and (c.adx_max is None or adx_v <= c.adx_max)
        if not strong:
            regime = "range"
            data["reason"] = (f"ADX {adx_v:.1f} outside "
                              f"[{c.adx_min}, {c.adx_max}]")
        elif price > slow and fast > slow:
            regime = "bull"
        elif price < slow and fast < slow:
            regime = "bear"
        else:
            regime = "range"
            data["reason"] = "H4 EMA stack not aligned with price"

        self._h4_cache = (now, regime, data)
        return regime, data

    # ------------------------------------------------------------------
    def _look_for_entry(self, hist: pd.DataFrame, ctx: dict) -> float:
        c = self.cfg
        regime = ctx["regime"]
        price, a = ctx["price"], ctx["atr"]
        rejections: list[str] = []

        if regime not in ("bull", "bear"):
            return self._log_no_trade(
                hist, f"regime={regime}: "
                      f"{ctx['regime_data'].get('reason', 'not trending')}", ctx)

        direction = 1 if regime == "bull" else -1

        # 1. H1 must agree with H4.
        if direction > 0 and price <= ctx["ema_trend"]:
            return self._log_no_trade(hist, "H1 price below EMA200 in bull regime", ctx)
        if direction < 0 and price >= ctx["ema_trend"]:
            return self._log_no_trade(hist, "H1 price above EMA200 in bear regime", ctx)

        # 2. Pullback: price must have REACHED the EMA zone recently. A touch
        #    alone is not a signal — it is a precondition.
        zone_hi = max(ctx["ema_fast"], ctx["ema_slow"])
        zone_lo = min(ctx["ema_fast"], ctx["ema_slow"])
        tol = a * c.entry.zone_atr_mult
        window = hist.iloc[-c.entry.pullback_max_bars:]
        if direction > 0:
            touched = (window["low"] <= zone_hi + tol).any()
        else:
            touched = (window["high"] >= zone_lo - tol).any()
        if not touched:
            return self._log_no_trade(hist, "no pullback into EMA zone", ctx)

        # 3. Rejection: the bar must close back OUT of the zone in the trend
        #    direction, having traded into it. This is the difference between
        #    "price touched an EMA" and "price was rejected from it".
        #    The pullback and the rejection need not be the SAME candle. A
        #    single bar that both dips into the zone and closes back outside
        #    it is one specific (and rare) shape; requiring it took this
        #    system to 1 trade in 10,640 bars. The standard reading is that
        #    price visited the zone over the last few bars and the current
        #    bar closes back out of it with conviction.
        recent = hist.iloc[-c.entry.rejection_window:]
        if direction > 0:
            visited = (recent["low"] <= zone_hi + tol).any()
            closed_out = ctx["price"] > zone_hi
            bullish = ctx["price"] > ctx["open"]
            if not (visited and closed_out and bullish):
                rejections.append("no bullish rejection from zone")
        else:
            visited = (recent["high"] >= zone_lo - tol).any()
            closed_out = ctx["price"] < zone_lo
            bearish = ctx["price"] < ctx["open"]
            if not (visited and closed_out and bearish):
                rejections.append("no bearish rejection from zone")

        # 4. Candle conviction.
        if ctx["body_frac"] < c.entry.min_body_fraction:
            rejections.append(
                f"weak candle body {ctx['body_frac']:.2f} < {c.entry.min_body_fraction}")

        # 5. Optional RSI: in band AND turning back toward the trend.
        if c.entry.use_rsi_filter and not np.isnan(ctx["rsi"]):
            r, rp = ctx["rsi"], ctx["rsi_prev"]
            if direction > 0:
                if not (c.entry.rsi_long_min <= r <= c.entry.rsi_long_max):
                    rejections.append(f"RSI {r:.1f} outside long band")
                elif not np.isnan(rp) and r <= rp:
                    rejections.append("RSI not recovering")
            else:
                if not (c.entry.rsi_short_min <= r <= c.entry.rsi_short_max):
                    rejections.append(f"RSI {r:.1f} outside short band")
                elif not np.isnan(rp) and r >= rp:
                    rejections.append("RSI not rolling over")

        if rejections:
            return self._log_no_trade(hist, rejections[0], ctx, rejections)

        # 6. Stop: ATR vs structure, whichever is more defensible, capped.
        stop, stop_src = self._stop_price(hist, ctx, direction)
        if stop is None:
            return self._log_no_trade(hist, "no valid stop placement", ctx)

        risk = abs(price - stop)
        if risk <= 0:
            return self._log_no_trade(hist, "non-positive risk distance", ctx)

        # 7. Structure headroom — do not buy into a wall.
        swings = find_swings(hist, c.structure.swing_lookback)
        zones = build_zones(
            swings, "resistance" if direction > 0 else "support",
            a, c.structure.zone_merge_atr)
        ok, why = headroom_ok(price, stop, direction, zones,
                              c.structure.min_headroom_r)
        if not ok:
            return self._log_no_trade(hist, f"insufficient headroom: {why}", ctx)

        # 8. Size, equity-independent (see module docstring).
        wanted = (c.risk.risk_per_trade_pct / 100.0) * price / risk
        weight = min(wanted, c.risk.max_total_exposure)
        # A binding exposure cap means the position carries LESS risk than
        # the config states. That is the safe direction, but a silent gap
        # between configured and actual risk is still a gap, so it is named
        # in the journal rather than left for someone to discover.
        capped = wanted > c.risk.max_total_exposure
        actual_risk_pct = 100.0 * weight * risk / price

        tp1 = price + direction * risk * c.risk.take_profit_1_r
        tp2 = price + direction * risk * c.risk.take_profit_2_r

        self.trade = OpenTrade(
            direction=direction, entry=price, stop=stop, tp1=tp1, tp2=tp2,
            initial_weight=weight, weight=weight, entry_bar=self._bar,
            r_distance=risk,
        )

        note = (f"{stop_src}; {why}"
                + (f"; EXPOSURE CAP BINDING: wanted {wanted:.2f}x equity for "
                   f"{c.risk.risk_per_trade_pct}% risk, capped to "
                   f"{weight:.2f}x -> actual risk {actual_risk_pct:.3f}%"
                   if capped else ""))
        self._log(hist, "enter_long" if direction > 0 else "enter_short",
                  note, ctx, stop=stop, tp1=tp1, tp2=tp2, weight=weight,
                  actual_risk=actual_risk_pct)
        return direction * weight

    # ------------------------------------------------------------------
    def _stop_price(self, hist: pd.DataFrame, ctx: dict,
                    direction: int) -> tuple[float | None, str]:
        """ATR stop vs structural stop; take the more defensible, then cap.

        "More defensible" means further from entry — a stop inside the recent
        swing gets hit by ordinary noise, and being stopped by noise is not
        being wrong. The cap prevents a wide swing from turning one trade into
        an outsized risk; when structure demands more room than the cap
        allows, the correct response is to skip, not to widen.
        """
        c = self.cfg.risk
        price, a = ctx["price"], ctx["atr"]
        atr_stop = price - direction * a * c.atr_stop_mult

        swings = find_swings(hist, self.cfg.structure.swing_lookback)
        buf = a * c.swing_buffer_atr
        # Search NEAR structure only. Over a 120-bar window the "recent"
        # swing can sit far enough away that every resulting stop breaches
        # the ATR cap — measured as 619 "no valid stop placement" rejections.
        # The stop should anchor to the structure being traded, not the
        # widest point in memory.
        win = self.cfg.structure.stop_swing_window
        if direction > 0:
            lvl = recent_swing_low(swings, self._bar, win)
            struct_stop = (lvl - buf) if lvl is not None else None
        else:
            lvl = recent_swing_high(swings, self._bar, win)
            struct_stop = (lvl + buf) if lvl is not None else None

        if struct_stop is None:
            chosen, src = atr_stop, f"ATR stop ({c.atr_stop_mult}x ATR)"
        elif direction > 0:
            chosen = min(atr_stop, struct_stop)
            src = "structural stop below swing low" if struct_stop < atr_stop else "ATR stop"
        else:
            chosen = max(atr_stop, struct_stop)
            src = "structural stop above swing high" if struct_stop > atr_stop else "ATR stop"

        if abs(price - chosen) > a * c.max_stop_atr_mult:
            return None, f"stop wider than cap ({c.max_stop_atr_mult}x ATR)"
        if (direction > 0 and chosen >= price) or (direction < 0 and chosen <= price):
            return None, "stop on wrong side of entry"
        return chosen, src

    # ------------------------------------------------------------------
    def _manage(self, hist: pd.DataFrame, ctx: dict) -> float:
        """Manage an open trade. Stops only ever move toward safety."""
        t = self.trade
        assert t is not None
        c = self.cfg.risk
        t.bars_held += 1
        hi, lo = ctx["high"], ctx["low"]
        d = t.direction

        # Stop first: on a bar that spans both stop and target, assume the
        # worse fill. The alternative flatters every ambiguous bar.
        if (d > 0 and lo <= t.stop) or (d < 0 and hi >= t.stop):
            return self._close(hist, ctx, t.stop, "stop hit")

        if not t.tp1_filled and ((d > 0 and hi >= t.tp1) or (d < 0 and lo <= t.tp1)):
            t.tp1_filled = True
            t.weight = t.initial_weight * (1.0 - c.tp1_close_fraction)
            if c.breakeven_after_tp1:
                t.stop = t.entry + d * t.r_distance * c.breakeven_offset_r
            self._log(hist, "scale_out",
                      f"TP1 hit at {t.tp1:.2f}; closed "
                      f"{c.tp1_close_fraction:.0%}, stop -> {t.stop:.2f}",
                      ctx, stop=t.stop, tp1=t.tp1, tp2=t.tp2, weight=t.weight)
            return d * t.weight

        if (d > 0 and hi >= t.tp2) or (d < 0 and lo <= t.tp2):
            return self._close(hist, ctx, t.tp2, "TP2 hit")

        if t.bars_held >= c.max_hold_bars:
            return self._close(hist, ctx, ctx["price"], "max hold reached")

        return d * t.weight

    def _close(self, hist: pd.DataFrame, ctx: dict, price: float,
               reason: str) -> float:
        t = self.trade
        assert t is not None
        r_mult = ((price - t.entry) * t.direction) / t.r_distance if t.r_distance else 0.0
        self.trades.append(TradeRecord(
            entry_time=hist["timestamp"].iloc[t.entry_bar] if t.entry_bar < len(hist)
            else ctx["timestamp"],
            exit_time=ctx["timestamp"], direction=t.direction, entry=t.entry,
            exit=price, r_multiple=r_mult, reason=reason,
            bars_held=t.bars_held, tp1_filled=t.tp1_filled,
        ))
        self._log(hist, "exit", f"{reason} ({r_mult:+.2f}R)", ctx, stop=t.stop)
        self.trade = None
        return 0.0

    # ------------------------------------------------------------------
    def _log_no_trade(self, hist, reason: str, ctx: dict | None = None,
                      rejections: list[str] | None = None) -> float:
        self._log(hist, "no_trade", reason, ctx, rejections=rejections)
        return 0.0 if self.trade is None else self.trade.direction * self.trade.weight

    def _log(self, hist, action: str, reason: str, ctx: dict | None,
             stop=None, tp1=None, tp2=None, weight=None,
             rejections: list[str] | None = None,
             actual_risk: float | None = None) -> None:
        if self.journal is None:
            return
        self.journal.record(Decision(
            timestamp=pd.Timestamp.utcnow().isoformat(),
            bar_time=str(hist["timestamp"].iloc[-1]),
            symbol=self.cfg.execution.symbol,
            action=action, reason=reason,
            config_fingerprint=self.cfg.fingerprint(),
            price=ctx["price"] if ctx else None,
            regime=ctx["regime"] if ctx else None,
            stop=stop, tp1=tp1, tp2=tp2,
            risk_pct_intended=self.cfg.risk.risk_per_trade_pct,
            risk_pct_actual=actual_risk,
            indicators={
                k: round(ctx[k], 4) for k in
                ("atr", "ema_trend", "ema_fast", "ema_slow", "rsi", "body_frac")
                if ctx and k in ctx and ctx[k] is not None and not pd.isna(ctx[k])
            } if ctx else {},
            rejections=rejections or [],
        ))

    # ------------------------------------------------------------------
    def performance(self) -> dict:
        """Trade statistics computed from EVERY trade. Nothing is filtered."""
        if not self.trades:
            return {"n_trades": 0}
        df = pd.DataFrame([vars(t) for t in self.trades])
        r = df["r_multiple"]
        wins, losses = r[r > 0], r[r <= 0]
        gross_win = float(wins.sum()) if len(wins) else 0.0
        gross_loss = float(-losses.sum()) if len(losses) else 0.0
        return {
            "n_trades": len(df),
            "win_rate": float((r > 0).mean()),
            "expectancy_r": float(r.mean()),
            "total_r": float(r.sum()),
            "avg_win_r": float(wins.mean()) if len(wins) else 0.0,
            "avg_loss_r": float(losses.mean()) if len(losses) else 0.0,
            "profit_factor": (gross_win / gross_loss) if gross_loss > 0 else float("inf"),
            "best_r": float(r.max()),
            "worst_r": float(r.min()),
            "avg_bars_held": float(df["bars_held"].mean()),
            "tp1_hit_rate": float(df["tp1_filled"].mean()),
            "exit_reasons": df["reason"].value_counts().to_dict(),
        }
