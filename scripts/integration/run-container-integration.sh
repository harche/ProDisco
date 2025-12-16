#!/usr/bin/env bash
#
# Integration test for the containerized sandbox-server.
# Creates a kind cluster, builds and loads the Docker image, deploys, and tests.
#

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLUSTER_NAME="${CLUSTER_NAME:-sandbox-int}"
KIND_BIN="${KIND_BIN:-kind}"
KUBECTL_BIN="${KUBECTL_BIN:-kubectl}"
ARTIFACT_DIR="${ROOT_DIR}/artifacts/container-integration"
KUBECONFIG_PATH="${ARTIFACT_DIR}/kubeconfig"
IMAGE_NAME="prodisco/sandbox-server:test"
NAMESPACE="prodisco"
LOCAL_PORT="${LOCAL_PORT:-50052}"  # Use different port to avoid conflicts

log() {
  echo "[container-integration] $*"
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

# Check required commands
ensure_command "$KIND_BIN"
ensure_command "$KUBECTL_BIN"
ensure_command docker
ensure_command npm
ensure_command node

mkdir -p "$ARTIFACT_DIR"
trap cleanup EXIT

# Step 1: Create KIND cluster
log "Creating KIND cluster ${CLUSTER_NAME}"
"$KIND_BIN" delete cluster --name "$CLUSTER_NAME" >/dev/null 2>&1 || true
"$KIND_BIN" create cluster --name "$CLUSTER_NAME" --wait 180s

log "Writing kubeconfig to ${KUBECONFIG_PATH}"
"$KIND_BIN" get kubeconfig --name "$CLUSTER_NAME" >"$KUBECONFIG_PATH"
export KUBECONFIG="$KUBECONFIG_PATH"

# Step 2: Build the packages (skip if already built)
cd "$ROOT_DIR"
if [ -d "packages/sandbox-server/dist" ] && [ -f "packages/sandbox-server/dist/server/index.js" ]; then
  log "sandbox-server already built, skipping build step"
else
  log "Building packages"
  npm run build -w @prodisco/search-libs
  npm run build -w @prodisco/prometheus-client
  npm run build -w @prodisco/loki-client
  npm run proto:generate -w @prodisco/sandbox-server
  npm run build -w @prodisco/sandbox-server
fi

# Step 3: Build Docker image from config (keeps image contents in sync with runtime library config)
# Default to the shipped Kubernetes example config since these tests exec k8s client code in-cluster.
LIBRARIES_CONFIG_PATH="${LIBRARIES_CONFIG_PATH:-${ROOT_DIR}/examples/prodisco.kubernetes.yaml}"
IMAGE_TAG="${IMAGE_TAG:-test}"

log "Building sandbox-server Docker image from config (${LIBRARIES_CONFIG_PATH})"
npm run docker:build:config -- \
  --config "${LIBRARIES_CONFIG_PATH}" \
  --tag "${IMAGE_TAG}" \
  --sandbox-image prodisco/sandbox-server \
  --skip-mcp

# Step 4: Load image into kind
log "Loading image into kind cluster"
"$KIND_BIN" load docker-image "$IMAGE_NAME" --name "$CLUSTER_NAME"

# Step 5: Deploy sandbox-server (update image in manifest)
log "Deploying sandbox-server to cluster"

# Create a temporary manifest with the test image
TEMP_MANIFEST="${ARTIFACT_DIR}/deployment.yaml"
sed "s|prodisco/sandbox-server:latest|${IMAGE_NAME}|g" \
  "$ROOT_DIR/packages/sandbox-server/k8s/deployment.yaml" > "$TEMP_MANIFEST"

"$KUBECTL_BIN" apply -f "$TEMP_MANIFEST"

# Step 6: Wait for deployment to be ready
log "Waiting for sandbox-server deployment to be ready"
if ! "$KUBECTL_BIN" -n "$NAMESPACE" wait --for=condition=available deployment/sandbox-server --timeout=120s; then
  log "ERROR: Deployment failed to become ready. Collecting diagnostics..."
  "$KUBECTL_BIN" -n "$NAMESPACE" get pods -o wide
  "$KUBECTL_BIN" -n "$NAMESPACE" describe deployment/sandbox-server
  "$KUBECTL_BIN" -n "$NAMESPACE" describe pods -l app=sandbox-server
  "$KUBECTL_BIN" -n "$NAMESPACE" logs -l app=sandbox-server --tail=50 || true
  exit 1
fi

# Verify pod is running
"$KUBECTL_BIN" -n "$NAMESPACE" get pods -l app=sandbox-server

# Check logs
log "Sandbox server logs:"
"$KUBECTL_BIN" -n "$NAMESPACE" logs deployment/sandbox-server

# Step 7: Port-forward and run tests
log "Setting up port-forward on local port ${LOCAL_PORT}"
"$KUBECTL_BIN" -n "$NAMESPACE" port-forward service/sandbox-server "${LOCAL_PORT}:50051" &
PORT_FORWARD_PID=$!

# Wait for port-forward to be ready
sleep 3

# Verify port-forward is running
if ! kill -0 $PORT_FORWARD_PID 2>/dev/null; then
  log "ERROR: Port-forward failed to start"
  exit 1
fi

log "Running integration tests"
SANDBOX_PORT="$LOCAL_PORT" npx tsx "$ROOT_DIR/scripts/integration/container-tests.ts"

# Cleanup port-forward
kill $PORT_FORWARD_PID 2>/dev/null || true

log "Container integration tests completed successfully!"
