"""Is Kronos-base's 1.8% MAE win over naive real, or noise? Paired test, same windows."""
import sys, time
import numpy as np, pandas as pd
sys.path.insert(0, "/workspace/shiyu-coder/kronos")
from model import Kronos, KronosTokenizer, KronosPredictor

LOOKBACK, HORIZON, N = 256, 12, 40
tok = KronosTokenizer.from_pretrained("NeoQuasar/Kronos-Tokenizer-base")
mdl = Kronos.from_pretrained("NeoQuasar/Kronos-base")
tok.eval(); mdl.eval()
pr = KronosPredictor(mdl, tok, device="cpu", max_context=512)

df = pd.read_csv("/home/user/Project/data/sample_5min.csv")
df["timestamp"] = pd.to_datetime(df["timestamp"])
rng = np.random.default_rng(0)
starts = sorted(rng.choice(range(LOOKBACK, len(df) - HORIZON - 1), N, replace=False))

k_err, n_err = [], []
t0 = time.time()
for s in starts:
    w = df.iloc[s - LOOKBACK:s]
    last = float(df["close"].iloc[s - 1])
    truth = df["close"].iloc[s:s + HORIZON].to_numpy(dtype=float)
    x = w[["open", "high", "low", "close", "volume"]].copy()
    x["amount"] = w["volume"].to_numpy() * w["close"].to_numpy()
    step = w["timestamp"].diff().median()
    y_ts = pd.Series([w["timestamp"].iloc[-1] + step * (i + 1) for i in range(HORIZON)])
    p = pr.predict(df=x, x_timestamp=pd.Series(w["timestamp"].to_numpy()),
                   y_timestamp=y_ts, pred_len=HORIZON, T=0.7, top_p=0.9,
                   sample_count=8, verbose=False)
    fc = p["close"].to_numpy(dtype=float)
    k_err.append(np.mean(np.abs(fc - truth)) / last)
    n_err.append(np.mean(np.abs(last - truth)) / last)

k, n = np.array(k_err), np.array(n_err)
d = n - k  # positive = Kronos better on that window
print(f"Kronos-base MAE : {k.mean():.4%}")
print(f"Naive       MAE : {n.mean():.4%}")
print(f"relative        : {k.mean()/n.mean()-1:+.1%}")
print(f"\nper-window paired difference (naive - kronos), n={N}")
print(f"  mean   : {d.mean():+.5%}")
print(f"  std    : {d.std(ddof=1):.5%}")
print(f"  wins   : {(d>0).sum()}/{N} windows")

# Paired bootstrap: resample windows, how often does Kronos come out ahead?
bs = np.array([np.mean(rng.choice(d, N, replace=True)) for _ in range(20000)])
lo, hi = np.percentile(bs, [2.5, 97.5])
print(f"\n95% CI for mean difference: [{lo:+.5%}, {hi:+.5%}]")
print(f"P(Kronos better)          : {(bs>0).mean():.1%}")
print(f"\nverdict: {'REAL (CI excludes zero)' if lo > 0 else 'NOT SIGNIFICANT (CI spans zero)'}")
print(f"elapsed {time.time()-t0:.0f}s")
