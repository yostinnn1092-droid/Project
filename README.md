# Baccarat Streak Bot

A baccarat bot that watches for runs of three and backs them with a single
martingale step, built on top of the
[StakeAPI](https://github.com/brokechubb/StakeAPI) wrapper.

It ships with a full punto banco simulator, so you can paper-trade and
backtest the strategy without an account, a token, or a stake.

## The strategy

1. Watch coups and track consecutive Player / Banker results.
   **Ties are transparent** — they neither extend nor break a run, so
   `P P T P` counts as three players in a row.
2. When either side hits **3 in a row**, bet **1% of the bankroll** on the
   next coup.
3. **Win** → stand down and wait for the next qualifying run.
4. **Tie** → the bet pushes. The stake comes back and is re-placed at the
   same stage; a push does not burn the martingale step.
5. **Loss** → **double the stake once**, same side, on the very next coup.
   Win or push resolves as above; a second loss stands down and waits for
   the next run.

Two details the request left open, both configurable:

| Question | Default | Flag |
| --- | --- | --- |
| Bet *with* the streak or against it? | with (`follow`) | `--direction against` |
| Does `P P P P P` trigger twice? | no — a spent run must be replaced by a new one | `BOT_RETRIGGER=every_n` |

## Install

```bash
pip install -e .          # bot only, paper + backtest
pip install -e '.[live]'  # adds the stakeapi wrapper for live play
```

## Use

```bash
# One simulated session, 500 coups, $1000 bankroll
baccarat-bot paper --rounds 500 --balance 1000 --seed 7

# 2000 simulated sessions, aggregate statistics
baccarat-bot backtest --sessions 2000 --rounds 500 --balance 1000

# Live (read the warnings below first)
baccarat-bot live --live-fire
```

Useful flags: `--stake-pct`, `--streak`, `--direction`, `--martingale-steps`,
`--stop-loss`, `--take-profit`, `--delay`, `--seed`, `-v`.

## What the backtest says

2000 sessions, 500 coups each, $1000 bankroll, 20% stop-loss:

| Variant | Profitable sessions | Stop-loss hit | Mean ROI |
| --- | --- | --- | --- |
| follow, 1 martingale step (default) | 44.6% | 11.2% | **−1.39%** |
| against, 1 step | 45.9% | 11.0% | −0.78% |
| follow, no martingale | 42.7% | 0.7% | −1.05% |
| follow, 3 steps | 37.3% | **49.8%** | −2.44% |

Read this honestly: **every variant loses**, at roughly the house edge
(1.06% on banker, 1.24% on player). Streak triggers do not change the odds
of the next coup — each one is independent, so no entry rule moves the
edge. The martingale does not fix that either; it trades a lot of small
wins for rare large losses, which is why three steps busts half of all
sessions. The bot is built to execute your rules faithfully and to stop
before things get out of hand, not to beat the game.

## Risk guards

Every stake is vetted before it reaches a table, and the session ends the
moment a limit trips.

| Setting | Default | Meaning |
| --- | --- | --- |
| `BOT_STOP_LOSS_PCT` | 0.20 | stop after losing 20% of the starting balance |
| `BOT_TAKE_PROFIT_PCT` | 0 (off) | stop after a given gain |
| `BOT_MAX_STAKE_PCT` | 0.10 | never stake more than 10% of the balance |
| `BOT_MAX_ROUNDS` / `BOT_MAX_BETS` | 0 (off) | hard session caps |
| `BOT_MIN_STAKE` | 0 | table minimum; smaller stakes are refused, never rounded up |

Stakes always round **down**, so rounding can never push a bet above a limit.

## Going live — two things to fix first

The `live` mode refuses to run until you pass `--live-fire`, because two
things in this repo are unverified. Both are documented at the top of
`baccarat_bot/drivers/stake.py`.

**1. The baccarat mutation is a guess.** StakeAPI ships no baccarat
support — its only verified wagering mutations are `blackjackBet` and
`blackjackNext`. `BACCARAT_BET_MUTATION` is modelled on the blackjack one
and on Stake's usual Originals bet shape, but the field names and the
`state` selection have not been checked against the live API. Capture the
real operation from DevTools (Network → filter `/_api/graphql` → play one
hand) and paste it in. That is the only edit the file should need.

**2. Watching a coup costs money.** Stake's baccarat is an *Originals*
game: a coup only exists because you bet on it. There is no shared shoe to
observe, so the streak the strategy depends on cannot be read passively.
When the strategy wants to sit a coup out, the live driver places a probe
bet of `BOT_OBSERVE_STAKE` just to reveal the result. Those probes carry
the normal house edge, and the backtest above does **not** price them in —
at roughly 80% of coups sat out, they will dominate your losses. Set
`BOT_OBSERVE_STAKE` to the table minimum and budget for it.

If you want passive observation, you need a live-dealer baccarat table
with a shared shoe. That is a different API surface, and neither this repo
nor StakeAPI covers it.

## Configuration

Copy `.env.example` to `.env`. stake.us needs only an access token;
stake.com additionally needs a `cf_clearance` cookie and the exact
User-Agent that obtained it.

## Layout

```
baccarat_bot/
  shoe.py       punto banco rules engine (drawing rules, 8-deck shoe)
  strategy.py   streak tracker + martingale state machine
  risk.py       stake vetting and session limits
  engine.py     the session loop
  config.py     env / .env loading
  cli.py        paper | backtest | live
  drivers/
    base.py     the driver protocol
    paper.py    local simulated table
    stake.py    live table via StakeAPI  <- unverified, read the warnings
tests/          80 tests
```

## Tests

```bash
python -m pytest tests/ -q
```

## Disclaimer

Unofficial, unaffiliated with Stake. Gambling risks real money and the
house edge is not beatable by bet sizing. Automated play may violate
Stake's terms of service — that is your call to make, and the consequences
(including account closure) are yours. Check that online gambling is legal
where you are. Use at your own risk.
