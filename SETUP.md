# Running the bot on a Bitget demo account

Fake money, real order flow, real timing. Nothing here can lose you anything.

## What you will be running

| | |
|---|---|
| Strategy | `SmaCrossover(40, 100)` |
| Symbol | `SBTCSUSDT` (simulated BTC perpetual) |
| Timeframe | 4h |
| Product | `SUSDT-FUTURES` (Bitget demo) |
| Costs | 6bp taker per side, 12bp round trip |

**Why this strategy.** Thirteen candidates were tested on 5,000 4h bars of
this exact instrument, split chronologically. SMA 40/100 was the only one
positive in *both* halves (+43.9% over 1.5yr train, +8.1% over 0.8yr test). It also independently
won the 20-strategy search across forex and stocks in `run_search.py`. Two
unrelated datasets, same winner.

**Why that is weaker evidence than it sounds.** The test half was a BTC
downtrend — buy-and-hold lost 43% over those 9.5 months — and in a downtrend anything that sits in
cash "beats the benchmark". Twelve of thirteen strategies did. That number
means nothing. Being positive in both halves is the only part that survives,
and it rests on 20 trades.

| period | span | buy & hold | SMA 40/100 | strategy max DD |
|---|---|---|---|---|
| Train | 1.48 yr | +94.0% | +43.9% | −20.4% |
| Test | 0.80 yr | −43.0% | +8.1% | −12.0% |
| **Full** | 2.28 yr | +10.7% | **+43.9%** | −21.9% |

Over the full 2.28 years the strategy returned four times buy-and-hold with a
−21.9% worst drawdown against −53.5%. That is the strongest result in this
repo. It also covers one instrument over a period containing a bubble and a
crash — the exact shape of data that flatters trend-following, since riding
the up and sitting out the down *is* the thesis. BTC peaked at 125,363 on
2025-10-06 and the test half starts nineteen days later, so the split landed
almost exactly on the top by coincidence. A different two years would likely
look much worse.

**No gold on demo.** Bitget demo carries three symbols: BTC, ETH, XRP. The
XAUUSD work in this repo cannot be demo-traded here.

## 1. Get a VPS

The bot must stay connected continuously, so it cannot run on a phone. Any of
these are fine; the bot needs almost nothing.

- Hetzner CX22 — about €4/month, cheapest reliable option
- DigitalOcean Basic — $6/month
- Vultr Cloud Compute — $5/month

Pick **Ubuntu 24.04**, the smallest instance. 1 vCPU and 1GB RAM is plenty.

## 2. Install

```bash
sudo apt update && sudo apt install -y python3 python3-venv git tmux
git clone https://github.com/yostinnn1092-droid/Project.git
cd Project
git checkout claude/install-free-claude-code-c3xvuc
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

Check it works — this needs no keys and touches no account:

```bash
.venv/bin/python run_bitget.py
```

## 3. Read what the tests actually found

```bash
.venv/bin/python bitget_bot.py --why-not-yet
```

Do this before step 4, not after.

## 4. Paper first, for weeks

```bash
tmux new -s bot
.venv/bin/python -u bitget_bot.py --demo
```

Detach with `Ctrl-B` then `D`. Reattach with `tmux attach -t bot`.

This places no orders anywhere. It reads the real Bitget feed, decides on
closed 4h bars, simulates fills, and prints both curves:

```
2026-08-13 00:00  63,629.50  w=+1.00  TRADE
    bot  1,014.20 (+1.42%)   hold  1,031.60 (+3.16%)   BEHIND  -17.40
```

`EXCESS` is the only number that matters. Everything else in this repo
reduces to that one comparison.

## 5. Only then, demo orders

Real order flow against Bitget's simulator. Still fake money.

Get demo API keys: log into Bitget, switch to **Demo Trading**, then API Key
Management *from inside demo mode*. Give the key trade permission and leave
withdrawals disabled.

```bash
export BITGET_API_KEY=...
export BITGET_API_SECRET=...
export BITGET_API_PASSPHRASE=...
export BITGET_LIVE_CONFIRM="I ACCEPT LIVE TRADING RISK"

.venv/bin/python -u bitget_bot.py --demo --live
```

`--live` here means "send orders", not "real money" — `--demo` keeps it on
the simulator.

**Unverified.** The demo order path could not be tested without credentials.
The code sends the `paptrading: 1` header with the S-prefixed symbols, which
is what Bitget's documentation describes, but its docs disagree with each
other about whether demo accepts a live API key. If orders come back
rejected, regenerate the key from inside Demo mode. `www.bitget.com` is
blocked from the environment this was built in, so this could not be checked
directly.

## 6. What to watch for

| Sign | Meaning |
|---|---|
| `EXCESS` negative and drifting down | Working as expected. Costs. |
| `EXCESS` positive after 4+ weeks | Interesting. Not yet evidence. |
| `STALE` lines | Feed stalled. Bot correctly held. |
| `REFUSING TO START` | A gate did its job. Read it. |
| Many `TRADE` lines per day | Wrong timeframe — costs will eat it. |

Never restart the bot to "reset" a bad run. The journal anchors the benchmark
on the first decision precisely so that restarts cannot flatter the result.

## 7. Before ever using real money

Every gate exists because skipping it costs money:

1. Paper for weeks. Compare `EXCESS` against buy-and-hold.
2. Demo orders for weeks. Confirms fills, rejections, reconnects.
3. Live at a size where total loss is tuition.
4. Live properly — only if 3 matched 2.

Going live requires `--live` **without** `--demo`, plus the confirmation
phrase, plus keys. Three deliberate acts. Nothing in this repo has earned
step 3.

## The honest summary

About twenty strategies were tested across stocks, forex, gold, crypto and
indices. **Zero beat buy-and-hold.** Every profitable backtest here was
eventually traced to a bug — a frozen benchmark, a 24/7 annualisation on a
market open 5.5h/day, a null distribution centred wrongly, a strategy that
took zero trades while reporting 0.00%.

The most likely outcome of running this is that `EXCESS` stays negative and
you learn that for free. That is a good trade.
