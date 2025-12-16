#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

cd "$ROOT_DIR"

echo "[examples-smoke] Building..."
npm run build

echo "[examples-smoke] Running examples smoke test (k8s config then pg-mem config)..."
npx --yes tsx scripts/ci/examples-smoke.ts

echo "[examples-smoke] OK"


