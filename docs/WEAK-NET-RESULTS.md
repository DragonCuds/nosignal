# Weak-network results (measured 2026-10-20)

Real runs of `scripts/netbench/bench.mjs`: headless Chromium against a production build of this version, with Chrome DevTools network throttling. Times are seconds, one run per profile on a loaded 4-core box, so treat them as orders of magnitude, not as a benchmark.

Profiles: **Fast** = no throttling. **Poor 3G** = about 400 kbit/s down, 150 kbit/s up, 400 ms round trip. **Edge** = about 100 kbit/s, 800 ms round trip. The fourth profile (flaky: connection dropped twice) was stopped before it finished and is **not measured**.

| Step | Fast | Poor 3G | Edge |
|---|---|---|---|
| Open the app, first time ever (empty cache) | 1.7 | 12.1 | 37.2 |
| Open the app after clearing the cache | 1.3 | 8.0 | 27.1 |
| Open the app again (cached) | 0.5 | 2.4 | 2.6 |
| Sign up until the chat list shows | 1.0 | 18.3 | 5.6 |
| Reopen while logged in until the chat list shows | 1.2 | 2.8 | 3.0 |
| Open a chat until old messages show | 0.7 | 1.5 | 3.2 |
| Send a text, arrival at the other person | 0.3 | 0.6 | 0.4 |
| Send a ~300 KB photo, arrival at the other person | 1.1 | 6.6 | 17.9 |
| Text typed offline: delivery after the link returns | 0.6 | 0.8 | 0.9 |

## What the numbers say

- **Sending is fast once the app is open:** a text arrives in well under a second even on Edge. A ~300 KB photo is compressed to about 75 KB before upload (6 s on Poor 3G, 15 to 18 s on Edge).
- **Offline queue works:** a text typed offline shows as pending, is delivered within about a second after the link returns (also after the app was closed and reopened), and is not lost or duplicated.
- **The first visit on a very slow link is the weak spot:** about 280 KB must download first (27 to 37 s on Edge, 8 to 12 s on Poor 3G). After that the app opens from cache in 2 to 3 s.
- **Gap:** reloading the page while fully offline did not show the chat list in this test (the page stayed empty); opening a new tab offline showed something usable after 3 to 4 s.

## Improvements worth doing

1. Make a page reload with no connection show the cached app and chat list (offline reload gap above).
2. Shrink the first load: split the 820 KB main script into route chunks and load the sticker/emoji code lazily.
3. Re-run the flaky profile (two dropped connections) and a Poor 3G run on a real phone.
