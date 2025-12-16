#!/bin/bash
# HTTP Transport Integration Test
# Tests the MCP server running in a Kubernetes pod with HTTP transport

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Cleanup function
cleanup() {
    log_info "Cleaning up..."
    # Kill port-forward if running
    if [ -n "${PORT_FORWARD_PID:-}" ]; then
        kill "$PORT_FORWARD_PID" 2>/dev/null || true
    fi
    # Delete namespace (optional - comment out to keep for debugging)
    # kubectl delete namespace prodisco --ignore-not-found=true
}

trap cleanup EXIT

# Create artifacts directory
ARTIFACTS_DIR="${PROJECT_ROOT}/artifacts/http-integration"
mkdir -p "$ARTIFACTS_DIR"

log_info "Starting HTTP transport integration tests..."

# Check if kind cluster exists
if ! kind get clusters | grep -q "http-int"; then
    log_info "Creating Kind cluster 'http-int'..."
    kind create cluster --name http-int --wait 120s
fi

# Use the cluster
kubectl cluster-info --context kind-http-int

# Build Docker image from config (keeps image contents in sync with runtime library config)
# Default to the shipped Kubernetes example config since this integration test queries k8s APIs.
LIBRARIES_CONFIG_PATH="${LIBRARIES_CONFIG_PATH:-${PROJECT_ROOT}/examples/prodisco.kubernetes.yaml}"
IMAGE_TAG="${IMAGE_TAG:-test}"

log_info "Building MCP server Docker image from config (${LIBRARIES_CONFIG_PATH})..."
(
  cd "${PROJECT_ROOT}"
  npm run docker:build:config -- \
    --config "${LIBRARIES_CONFIG_PATH}" \
    --tag "${IMAGE_TAG}" \
    --mcp-image prodisco/mcp-server \
    --skip-sandbox
)

# Load image into Kind
log_info "Loading image into Kind cluster..."
kind load docker-image "prodisco/mcp-server:${IMAGE_TAG}" --name http-int

# Apply Kubernetes manifests
log_info "Deploying MCP server..."
kubectl apply -f "${PROJECT_ROOT}/k8s/mcp-server.yaml"

# Wait for deployment
log_info "Waiting for deployment to be ready..."
kubectl wait --for=condition=Available --timeout=180s deployment/mcp-server -n prodisco

# Check pod status
log_info "Checking pod status..."
kubectl get pods -n prodisco -l app=mcp-server

# Wait for pod to be ready
log_info "Waiting for pod to be ready..."
kubectl wait --for=condition=Ready --timeout=60s pod -l app=mcp-server -n prodisco

# Start port-forward
log_info "Starting port-forward..."
kubectl port-forward -n prodisco svc/mcp-server 3000:3000 &
PORT_FORWARD_PID=$!
sleep 5

# Test health endpoint
log_info "Testing health endpoint..."
HEALTH_RESPONSE=$(curl -s http://localhost:3000/health)
echo "Health response: $HEALTH_RESPONSE"

if echo "$HEALTH_RESPONSE" | grep -q '"status":"ok"'; then
    log_info "Health check passed!"
else
    log_error "Health check failed!"
    kubectl logs -n prodisco -l app=mcp-server --tail=100 > "$ARTIFACTS_DIR/mcp-server.log" 2>&1 || true
    exit 1
fi

# Test MCP initialize
log_info "Testing MCP initialize..."
INIT_RESPONSE=$(curl -s -i -X POST http://localhost:3000/mcp \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"integration-test","version":"1.0.0"}}}')

echo "Initialize response headers:"
echo "$INIT_RESPONSE" | head -20

# Extract session ID
SESSION_ID=$(echo "$INIT_RESPONSE" | grep -i "mcp-session-id:" | cut -d' ' -f2 | tr -d '\r')
echo "Session ID: $SESSION_ID"

if [ -z "$SESSION_ID" ]; then
    log_error "Failed to get session ID!"
    kubectl logs -n prodisco -l app=mcp-server --tail=100 > "$ARTIFACTS_DIR/mcp-server.log" 2>&1 || true
    exit 1
fi

log_info "Got session ID: $SESSION_ID"

# Test tools/list with session
log_info "Testing tools/list..."
TOOLS_RESPONSE=$(curl -s -X POST http://localhost:3000/mcp \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "mcp-session-id: $SESSION_ID" \
    -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}')

echo "Tools list response:"
echo "$TOOLS_RESPONSE" | head -50

# Verify tools are present
if echo "$TOOLS_RESPONSE" | grep -q "prodisco.searchTools"; then
    log_info "prodisco.searchTools found!"
else
    log_error "prodisco.searchTools not found in response!"
    exit 1
fi

if echo "$TOOLS_RESPONSE" | grep -q "prodisco.runSandbox"; then
    log_info "prodisco.runSandbox found!"
else
    log_error "prodisco.runSandbox not found in response!"
    exit 1
fi

# Test tool call - searchTools (current schema: methodName, documentType, library, category)
log_info "Testing prodisco.searchTools..."
SEARCH_RESPONSE=$(curl -s -X POST http://localhost:3000/mcp \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "mcp-session-id: $SESSION_ID" \
    -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"prodisco.searchTools","arguments":{"methodName":"listNamespace","documentType":"method","library":"@kubernetes/client-node","category":"list","limit":5}}}')

echo "Search tools response:"
echo "$SEARCH_RESPONSE" | head -30

if echo "$SEARCH_RESPONSE" | grep -q "result"; then
    log_info "searchTools call succeeded!"
else
    log_error "searchTools call failed!"
    echo "Full response: $SEARCH_RESPONSE"
    exit 1
fi

# Collect logs
log_info "Collecting logs..."
kubectl logs -n prodisco -l app=mcp-server --tail=100 > "$ARTIFACTS_DIR/mcp-server.log" 2>&1 || true
kubectl get pods -n prodisco -o wide > "$ARTIFACTS_DIR/pods.txt" 2>&1 || true
kubectl describe pod -n prodisco -l app=mcp-server > "$ARTIFACTS_DIR/pod-describe.txt" 2>&1 || true

log_info "All HTTP transport integration tests passed!"
