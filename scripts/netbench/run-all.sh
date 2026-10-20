#!/bin/sh
# Restarts the server on :3070 and runs the benchmark (default: all four profiles). See README.md.
cd "$(dirname "$0")" || exit 1
RUN=${RUN:-/root/pb3-run}
# restart the server once: sign-up is rate limited (5 per 15 min per IP) and a full run needs exactly 5 accounts
for pid in $(ss -ltnp | grep ':3070 ' | grep -o 'pid=[0-9]*' | cut -d= -f2); do kill "$pid"; done
sleep 1
(setsid nohup ./start-server.sh > "$RUN/server.log" 2>&1 < /dev/null &)
for i in $(seq 1 40); do ss -ltn | grep -q ":3070 " && break; sleep 1; done; sleep 2
exec node bench.mjs "$@"
