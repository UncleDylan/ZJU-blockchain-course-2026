#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="${1:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$PROJECT_ROOT"
command -v node >/dev/null || { echo 'Node.js is missing from PATH.' >&2; exit 1; }
command -v npm >/dev/null || { echo 'npm is missing from PATH.' >&2; exit 1; }
for dir in contracts frontend; do
  [[ -d "$dir/node_modules" ]] || {
    echo "Missing $dir/node_modules. Run: node tools/install-shared.mjs" >&2
    exit 1
  }
done

port_in_use() { ss -H -ltn "sport = :$1" | grep -q .; }
wait_ready() {
  for ((attempt = 0; attempt < 30; attempt++)); do
    if node tools/check-dev.cjs "$1" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "$1 did not become ready. Check /tmp/blockchain-hw2-*.log in Ubuntu." >&2
  return 1
}

echo '[1/3] Checking local blockchain...'
if node tools/check-dev.cjs rpc >/dev/null 2>&1; then
  echo 'Local chain is already running; preserving its state.'
else
  if port_in_use 8545; then
    echo 'Port 8545 is occupied but the expected RPC is unavailable. No process was stopped.' >&2
    exit 1
  fi
  (cd contracts && nohup npm run node > /tmp/blockchain-hw2-node.log 2>&1 < /dev/null &)
  wait_ready rpc
fi

echo '[2/3] Checking deployment...'
if node tools/check-dev.cjs deployment; then
  echo 'Deployment is valid; keeping existing contracts.'
else
  check_status=$?
  if [[ "$check_status" != 1 ]]; then
    echo 'RPC check failed. Deployment was not changed.' >&2
    exit 1
  fi
  echo 'Missing contracts or configuration. Deploying tokens, two DEXes and arbitrage contract...'
  (cd contracts && npm run deploy)
  node tools/check-dev.cjs deployment
fi

echo '[3/3] Checking frontend...'
if node tools/check-dev.cjs web >/dev/null 2>&1; then
  echo 'Frontend is already running.'
else
  if port_in_use 3000; then
    echo 'Port 3000 is occupied but MiniDEX is unavailable. No process was stopped.' >&2
    exit 1
  fi
  (cd frontend && nohup npm start -- --host 0.0.0.0 --strictPort > /tmp/blockchain-hw2-frontend.log 2>&1 < /dev/null &)
  wait_ready web
fi
echo 'Ubuntu services ready. No faucet, liquidity, swap or arbitrage transactions were sent.'
