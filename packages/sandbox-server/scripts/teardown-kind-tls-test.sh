#!/bin/bash
#
# Teardown script for kind cluster TLS integration tests
#
# This script:
# 1. Deletes the sandbox-server deployment
# 2. Deletes cert-manager resources
# 3. Optionally deletes the kind cluster
#
# Usage:
#   ./scripts/teardown-kind-tls-test.sh           # Keep cluster
#   ./scripts/teardown-kind-tls-test.sh --full    # Delete cluster too
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

CLUSTER_NAME="${CLUSTER_NAME:-prodisco-test}"
DELETE_CLUSTER=false

# Parse arguments
for arg in "$@"; do
    case $arg in
        --full)
            DELETE_CLUSTER=true
            shift
            ;;
    esac
done

echo "=== Tearing down kind cluster TLS integration test environment ==="
echo "Cluster name: ${CLUSTER_NAME}"
echo "Delete cluster: ${DELETE_CLUSTER}"

# Check if cluster exists
if ! kind get clusters 2>/dev/null | grep -q "^${CLUSTER_NAME}$"; then
    echo "Cluster ${CLUSTER_NAME} does not exist"
    exit 0
fi

# Set kubectl context
kubectl config use-context "kind-${CLUSTER_NAME}" 2>/dev/null || true

# Delete sandbox-server resources
echo ""
echo "=== Deleting sandbox-server resources ==="
cd "${PROJECT_ROOT}"

echo "Deleting deployment..."
kubectl delete -f k8s/deployment.yaml --ignore-not-found 2>/dev/null || true

echo "Deleting insecure test deployment if exists..."
kubectl delete deployment sandbox-server-insecure -n prodisco --ignore-not-found 2>/dev/null || true
kubectl delete service sandbox-server-insecure -n prodisco --ignore-not-found 2>/dev/null || true

# Delete cert-manager resources
echo ""
echo "=== Deleting cert-manager resources ==="
echo "Deleting certificates..."
kubectl delete -f k8s/cert-manager/client-certificate.yaml --ignore-not-found 2>/dev/null || true
kubectl delete -f k8s/cert-manager/server-certificate.yaml --ignore-not-found 2>/dev/null || true

echo "Deleting issuer..."
kubectl delete -f k8s/cert-manager/issuer.yaml --ignore-not-found 2>/dev/null || true

# Delete namespace
echo ""
echo "=== Deleting namespace ==="
kubectl delete namespace prodisco --ignore-not-found 2>/dev/null || true

# Optionally delete the cluster
if [ "$DELETE_CLUSTER" = true ]; then
    echo ""
    echo "=== Deleting kind cluster ==="
    kind delete cluster --name "${CLUSTER_NAME}"
fi

echo ""
echo "=== Teardown complete ==="

if [ "$DELETE_CLUSTER" = false ]; then
    echo ""
    echo "Note: The kind cluster '${CLUSTER_NAME}' is still running."
    echo "To delete it completely, run:"
    echo "  kind delete cluster --name ${CLUSTER_NAME}"
    echo ""
    echo "Or use:"
    echo "  ./scripts/teardown-kind-tls-test.sh --full"
fi
