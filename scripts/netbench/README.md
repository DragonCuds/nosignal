# netbench — weak-network measurement

Headless Chromium (puppeteer-core + `/snap/bin/chromium`) against a production-like server, with CDP network emulation.
Profiles: `fast` (no throttle), `poor3g` (400/150 kbit/s, 400 ms RTT), `edge` (100/50 kbit/s, 800 ms RTT), `flaky` (poor3g + link lost for 8 s, twice, during the photo uploads).

## Run
1. Build a private copy so other builds are not touched: web with `npx vite build --outDir $RUN/app/apps/web/dist` (from `apps/web`), server with `tsc` into `$RUN/app/apps/server/dist` (copy `apps/server` there, symlink `node_modules`, `packages`). Default `RUN=/root/pb3-run`.
2. `./run-all.sh` (restarts the server on :3070 and runs all profiles) or `./run-all.sh poor3g`.
3. Results: `results-<profile>.json` here. Summary: `docs/WEAK-NET-RESULTS.md`.

Notes
- The server runs in production mode (TLS auto, self-signed) under the name `tel.bench.test` mapped to loopback, because the app skips its service worker on `localhost`. Chromium trusts only that cert's key (SPKI flag).
- Sign-up is rate limited (5 per 15 min per IP). A full run creates 5 accounts, so `run-all.sh` restarts the server first.
- Data goes to `data-test/pb3/data`; delete `data-test/pb3` and `$RUN` afterwards.
