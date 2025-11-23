#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLUSTER_NAME="${CLUSTER_NAME:-mcp-int}"
KIND_BIN="${KIND_BIN:-kind}"
KUBECTL_BIN="${KUBECTL_BIN:-kubectl}"
ARTIFACT_DIR="${ROOT_DIR}/artifacts/integration"
KUBECONFIG_PATH="${ARTIFACT_DIR}/kubeconfig"
OUTPUT_PATH="${ARTIFACT_DIR}/claude-output.json"

log() {
  echo "[integration] $*"
}

ensure_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required command '$1' not found in PATH" >&2
    exit 1
  fi
}

cleanup() {
  set +e
  log "Cleaning up KIND cluster ${CLUSTER_NAME}"
  "$KIND_BIN" delete cluster --name "$CLUSTER_NAME" >/dev/null 2>&1
}

ensure_command "$KIND_BIN"
ensure_command "$KUBECTL_BIN"
ensure_command docker
ensure_command npm
ensure_command npx

mkdir -p "$ARTIFACT_DIR"
trap cleanup EXIT

log "Creating KIND cluster ${CLUSTER_NAME}"
"$KIND_BIN" delete cluster --name "$CLUSTER_NAME" >/dev/null 2>&1 || true
"$KIND_BIN" create cluster --name "$CLUSTER_NAME" --wait 180s

log "Writing kubeconfig to ${KUBECONFIG_PATH}"
"$KIND_BIN" get kubeconfig --name "$CLUSTER_NAME" >"$KUBECONFIG_PATH"

export KUBECONFIG="$KUBECONFIG_PATH"

log "Applying sample workload"
"$KUBECTL_BIN" apply -f "$ROOT_DIR/tests/fixtures/sample-workload.yaml"
"$KUBECTL_BIN" wait --namespace demo-int --for=condition=ready pod -l app=demo-nginx --timeout=180s

log "Building server artifacts"
cd "$ROOT_DIR"
npm run build
npm run codegen

log "Running Claude Agent SDK driver"
rm -f "$OUTPUT_PATH"
npx tsx "$ROOT_DIR/scripts/integration/claude-driver.ts" \
  --kubeconfig "$KUBECONFIG_PATH" \
  --output "$OUTPUT_PATH"

log "Verifying structured output"
npx tsx "$ROOT_DIR/scripts/integration/verify-claude-output.ts" \
  --input "$OUTPUT_PATH"

log "Integration test completed successfully. Results: $OUTPUT_PATH"

