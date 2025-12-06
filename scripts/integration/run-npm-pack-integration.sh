#!/usr/bin/env bash
#
# Integration test for npm package installation.
# Builds packages using `npm pack`, installs them in a clean directory,
# and verifies the MCP server and sandbox come up correctly.
#
# This test validates that the packages work correctly when installed from npm
# (simulating what happens with `npx -y @prodisco/k8s-mcp`).
#

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ARTIFACT_DIR="${ROOT_DIR}/artifacts/npm-pack-integration"
TEST_DIR="${ARTIFACT_DIR}/test-install"
SANDBOX_PORT="${SANDBOX_PORT:-50053}"

log() {
  echo "[npm-pack-integration] $*"
}

cleanup() {
  set +e
  log "Cleaning up..."

  # Kill any processes we started
  if [ -n "${SANDBOX_PID:-}" ]; then
    kill "$SANDBOX_PID" 2>/dev/null || true
  fi
  if [ -n "${MCP_PID:-}" ]; then
    kill "$MCP_PID" 2>/dev/null || true
  fi

  # Remove test directory
  if [ -d "$TEST_DIR" ]; then
    rm -rf "$TEST_DIR"
  fi
}

trap cleanup EXIT

# Step 1: Setup
log "Setting up test environment"
rm -rf "$ARTIFACT_DIR"
mkdir -p "$TEST_DIR"

# Step 2: Build packages
log "Building packages"
cd "$ROOT_DIR"
npm run build

# Step 3: Pack sandbox-server
log "Creating npm pack for @prodisco/sandbox-server"
cd "$ROOT_DIR/packages/sandbox-server"
SANDBOX_TARBALL=$(npm pack --pack-destination "$ARTIFACT_DIR" 2>/dev/null | tail -1)
log "Created: $SANDBOX_TARBALL"

# Step 4: Pack k8s-mcp
log "Creating npm pack for @prodisco/k8s-mcp"
cd "$ROOT_DIR"
MCP_TARBALL=$(npm pack --pack-destination "$ARTIFACT_DIR" 2>/dev/null | tail -1)
log "Created: $MCP_TARBALL"

# Step 5: Initialize test directory and install packages
log "Installing packages in clean test directory"
cd "$TEST_DIR"
npm init -y > /dev/null

# Install sandbox-server first (it's a dependency)
log "Installing sandbox-server from tarball"
npm install "$ARTIFACT_DIR/$SANDBOX_TARBALL" --save

# Install k8s-mcp
log "Installing k8s-mcp from tarball"
npm install "$ARTIFACT_DIR/$MCP_TARBALL" --save

# Step 6: Verify package contents
log "Verifying package contents"

# Check sandbox-server has the critical files
SANDBOX_PKG_DIR="$TEST_DIR/node_modules/@prodisco/sandbox-server"
if [ ! -f "$SANDBOX_PKG_DIR/dist/client/index.js" ]; then
  log "ERROR: sandbox-server missing dist/client/index.js"
  exit 1
fi
if [ ! -f "$SANDBOX_PKG_DIR/dist/server/index.js" ]; then
  log "ERROR: sandbox-server missing dist/server/index.js"
  exit 1
fi
if [ ! -f "$SANDBOX_PKG_DIR/dist/generated/sandbox.js" ]; then
  log "ERROR: sandbox-server missing dist/generated/sandbox.js"
  exit 1
fi
log "  ✓ sandbox-server package structure is correct"

# Check k8s-mcp has the critical files
MCP_PKG_DIR="$TEST_DIR/node_modules/@prodisco/k8s-mcp"
if [ ! -f "$MCP_PKG_DIR/dist/server.js" ]; then
  log "ERROR: k8s-mcp missing dist/server.js"
  exit 1
fi
log "  ✓ k8s-mcp package structure is correct"

# Step 7: Test sandbox-server can start (TCP mode)
log "Testing sandbox-server startup"
cd "$TEST_DIR"

# Start sandbox server in background with TCP mode
SANDBOX_SOCKET_PATH="/tmp/npm-pack-test-sandbox.sock" \
  node node_modules/@prodisco/sandbox-server/dist/server/index.js &
SANDBOX_PID=$!

# Wait for sandbox to be ready (check socket exists)
for i in {1..30}; do
  if [ -S "/tmp/npm-pack-test-sandbox.sock" ]; then
    log "  ✓ Sandbox server started (socket ready)"
    break
  fi
  if ! kill -0 $SANDBOX_PID 2>/dev/null; then
    log "ERROR: Sandbox server exited unexpectedly"
    wait $SANDBOX_PID || true
    exit 1
  fi
  sleep 0.5
done

if [ ! -S "/tmp/npm-pack-test-sandbox.sock" ]; then
  log "ERROR: Sandbox server socket not ready after 15 seconds"
  exit 1
fi

# Step 8: Test MCP server can start (with sandbox via socket)
log "Testing MCP server startup (with sandbox subprocess)"

# Kill the standalone sandbox first - MCP will spawn its own
kill $SANDBOX_PID 2>/dev/null || true
SANDBOX_PID=""
rm -f /tmp/npm-pack-test-sandbox.sock

# Create a test script that starts MCP and waits for it to be ready
cat > "$TEST_DIR/test-mcp-startup.js" << 'EOF'
const { spawn } = require('node:child_process');
const path = require('node:path');

const serverPath = path.join(__dirname, 'node_modules/@prodisco/k8s-mcp/dist/server.js');

console.log('Starting MCP server from:', serverPath);

const proc = spawn('node', [serverPath], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    SANDBOX_SOCKET_PATH: '/tmp/npm-pack-test-mcp-sandbox.sock',
  },
});

let stderr = '';
let foundReady = false;
let foundSandboxReady = false;

proc.stderr.on('data', (data) => {
  const text = data.toString();
  stderr += text;
  process.stderr.write(text);

  if (text.includes('Sandbox gRPC server is ready')) {
    foundSandboxReady = true;
  }
  if (text.includes('Kubernetes MCP server ready on stdio')) {
    foundReady = true;
  }
});

proc.stdout.on('data', (data) => {
  // MCP uses stdout for JSON-RPC, just drain it
});

// Set a timeout
const timeout = setTimeout(() => {
  console.log('\nTimeout waiting for server startup');
  console.log('Found sandbox ready:', foundSandboxReady);
  console.log('Found MCP ready:', foundReady);
  proc.kill('SIGTERM');
  process.exit(foundSandboxReady && foundReady ? 0 : 1);
}, 30000);

// Check periodically if both are ready
const check = setInterval(() => {
  if (foundSandboxReady && foundReady) {
    console.log('\n✓ Both sandbox and MCP server started successfully');
    clearTimeout(timeout);
    clearInterval(check);
    proc.kill('SIGTERM');
    process.exit(0);
  }
}, 100);

proc.on('error', (err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

proc.on('exit', (code) => {
  clearTimeout(timeout);
  clearInterval(check);
  if (code !== null && code !== 0 && !foundReady) {
    console.error('Server exited with code:', code);
    process.exit(1);
  }
});
EOF

node "$TEST_DIR/test-mcp-startup.js"
MCP_EXIT_CODE=$?

if [ $MCP_EXIT_CODE -ne 0 ]; then
  log "ERROR: MCP server startup test failed"
  exit 1
fi

log "  ✓ MCP server started successfully with sandbox subprocess"

# Step 9: Test TCP mode with remote sandbox
log "Testing MCP server in TCP mode (remote sandbox)"

# Start sandbox server first
SANDBOX_USE_TCP=true \
SANDBOX_TCP_PORT="$SANDBOX_PORT" \
  node "$TEST_DIR/node_modules/@prodisco/sandbox-server/dist/server/index.js" &
SANDBOX_PID=$!

# Wait for TCP sandbox to be ready
sleep 2
if ! kill -0 $SANDBOX_PID 2>/dev/null; then
  log "ERROR: TCP sandbox server failed to start"
  exit 1
fi

# Create TCP mode test script
cat > "$TEST_DIR/test-mcp-tcp.js" << EOF
const { spawn } = require('node:child_process');
const path = require('node:path');

const serverPath = path.join(__dirname, 'node_modules/@prodisco/k8s-mcp/dist/server.js');

console.log('Starting MCP server in TCP mode...');

const proc = spawn('node', [serverPath], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    SANDBOX_USE_TCP: 'true',
    SANDBOX_TCP_HOST: 'localhost',
    SANDBOX_TCP_PORT: '${SANDBOX_PORT}',
  },
});

let stderr = '';
let foundRemoteConnect = false;
let foundMcpReady = false;

proc.stderr.on('data', (data) => {
  const text = data.toString();
  stderr += text;
  process.stderr.write(text);

  if (text.includes('Connecting to remote sandbox server')) {
    foundRemoteConnect = true;
  }
  if (text.includes('Remote sandbox server is ready')) {
    foundRemoteConnect = true;
  }
  if (text.includes('Kubernetes MCP server ready on stdio')) {
    foundMcpReady = true;
  }
});

const timeout = setTimeout(() => {
  console.log('\\nTimeout waiting for TCP mode startup');
  proc.kill('SIGTERM');
  process.exit(1);
}, 15000);

const check = setInterval(() => {
  if (foundRemoteConnect && foundMcpReady) {
    console.log('\\n✓ MCP server connected to remote sandbox via TCP');
    clearTimeout(timeout);
    clearInterval(check);
    proc.kill('SIGTERM');
    process.exit(0);
  }
}, 100);

proc.on('error', (err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});

proc.on('exit', (code) => {
  clearTimeout(timeout);
  clearInterval(check);
  if (!foundMcpReady) {
    process.exit(1);
  }
});
EOF

node "$TEST_DIR/test-mcp-tcp.js"
TCP_EXIT_CODE=$?

# Cleanup TCP sandbox
kill $SANDBOX_PID 2>/dev/null || true
SANDBOX_PID=""

if [ $TCP_EXIT_CODE -ne 0 ]; then
  log "ERROR: MCP TCP mode test failed"
  exit 1
fi

log "  ✓ MCP server TCP mode works correctly"

log ""
log "========================================="
log "  All npm pack integration tests passed!"
log "========================================="
