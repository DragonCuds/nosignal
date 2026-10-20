# netsim — weak-network TCP proxy

Dependency-free Node TCP proxy that makes a local server behave like a bad mobile link. Plain TCP, so HTTP, WebSocket upgrades and SSE pass through unchanged.

```
node tools/netsim/proxy.mjs --listen 4201 --target 127.0.0.1:3050 --profile 3g|edge|flaky|cut
```

Listens on `127.0.0.1` only. Use ports >= 4100 for tests. Stop with Ctrl+C.

## Profiles
Latency and jitter are one way (so RTT is about 2x). Bandwidth is per direction, bytes/s.

| profile | latency +- jitter | down / up | resets | stalls | cut |
|---|---|---|---|---|---|
| `3g` | 120 +- 60 ms | 100 / 50 KB/s | none | none | none |
| `edge` | 350 +- 200 ms | 20 / 10 KB/s | none | ~every 40 s, ~4 s | none |
| `flaky` | 100 +- 100 ms | 120 / 60 KB/s | connection killed after ~15 s (exponential) | ~every 20 s, ~5 s | none |
| `cut` | 30 +- 10 ms | unlimited | none | none | every 60 s, 10 s long |

- reset: the connection is destroyed (both sides) at a random time, mean `resetMean`.
- stall: no bytes pass in that direction for a random time (exponential, mean `stallLen`, capped at 3x), then the queue is released.
- cut: at the start of each window (60 s, 120 s, ... after proxy start) every open connection is destroyed and new connections are refused until the window ends.

## Overrides
Any profile value can be changed: `--latency ms --jitter ms --down B/s --up B/s --reset-mean s --stall-every s --stall-len s --cut-every s --cut-len s` (0 turns a feature off). `--seed N` makes the random choices repeatable.

Example, fast link that resets every ~5 s: `--profile 3g --reset-mean 5 --down 0 --up 0`.

## Log
One line per event on stdout: `open`, `RESET`, `STALL`, `CUT start`, `refused new connection`.
