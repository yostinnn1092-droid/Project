"""Fair comparison: identical windows across every config. Real Kronos weights."""
import sys, time
import numpy as np, pandas as pd
sys.path.insert(0, "/workspace/shiyu-coder/kronos")
from model import Kronos, KronosTokenizer, KronosPredictor

LOOKBACK = 256
HORIZON = 12
N_WINDOWS = 40
CONFIGS = [("greedy-ish", 0.7, 8), ("default", 1.0, 8), ("single-draw", 1.0, 1)]

tok = KronosTokenizer.from_pretrained("NeoQuasar/Kronos-Tokenizer-base")
mdl = Kronos.from_pretrained("NeoQuasar/Kronos-small")
tok.eval(); mdl.eval()
pred = KronosPredictor(mdl, tok, device="cpu", max_context=512)
print(f"params: {sum(p.numel() for p in mdl.parameters()):,}")

df = pd.read_csv("/home/user/Project/data/sample_5min.csv")
df["timestamp"] = pd.to_datetime(df["timestamp"])

# Windows chosen ONCE and reused by every config. This is the whole point.
rng = np.random.default_rng(0)
starts = sorted(rng.choice(range(LOOKBACK, len(df) - HORIZON - 1),
                           N_WINDOWS, replace=False))

# Naive baseline depends only on the windows, so compute it once.
naive, truths, lasts = [], [], []
for s in starts:
    last = float(df["close"].iloc[s - 1])
    truth = df["close"].iloc[s:s + HORIZON].to_numpy(dtype=float)
    naive.append(np.mean(np.abs(last - truth)) / last)
    truths.append(truth); lasts.append(last)
naive_mae = float(np.mean(naive))
print(f"windows: {N_WINDOWS}  lookback: {LOOKBACK}  horizon: {HORIZON}")
print(f"NAIVE mean abs error: {naive_mae:.4%} of price  (fixed reference)\n")

se = np.sqrt(0.25 / N_WINDOWS)
print(f"{'config':<14}{'T':>5}{'draws':>7}{'MAE':>10}{'vs naive':>11}{'dir acc':>10}{'sec/fc':>9}")
print("-" * 66)

for name, T, sc in CONFIGS:
    errs, hits = [], []
    t0 = time.time()
    for j, s in enumerate(starts):
        w = df.iloc[s - LOOKBACK:s]
        x = w[["open", "high", "low", "close", "volume"]].copy()
        x["amount"] = w["volume"].to_numpy() * w["close"].to_numpy()
        step = w["timestamp"].diff().median()
        y_ts = pd.Series([w["timestamp"].iloc[-1] + step * (i + 1) for i in range(HORIZON)])
        p = pred.predict(df=x, x_timestamp=pd.Series(w["timestamp"].to_numpy()),
                         y_timestamp=y_ts, pred_len=HORIZON, T=T, top_p=0.9,
                         sample_count=sc, verbose=False)
        fc = p["close"].to_numpy(dtype=float)
        errs.append(np.mean(np.abs(fc - truths[j])) / lasts[j])
        hits.append((fc[-1] - lasts[j]) * (truths[j][-1] - lasts[j]) > 0)

    mae, acc = float(np.mean(errs)), float(np.mean(hits))
    dt = (time.time() - t0) / N_WINDOWS
    flag = "" if abs(acc - 0.5) <= 1.96 * se else "  *"
    print(f"{name:<14}{T:>5.1f}{sc:>7}{mae:>10.4%}{mae/naive_mae-1:>+10.1%}"
          f"{acc:>9.1%}{flag}{dt:>9.2f}")

print(f"\ncoin-flip 95% band for direction: {50-196*se:.1f}% - {50+196*se:.1f}%")
print("* = outside that band (nothing marked = indistinguishable from a coin flip)")
