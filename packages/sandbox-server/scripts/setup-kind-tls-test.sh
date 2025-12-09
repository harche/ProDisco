#!/bin/bash
#
# Setup script for kind cluster TLS integration tests
#
# This script:
# 1. Creates a kind cluster (if not exists)
# 2. Installs cert-manager
# 3. Builds and loads the sandbox-server Docker image
# 4. Applies cert-manager resources (CA, server/client certificates)
# 5. Deploys the sandbox-server with TLS enabled
#
# Usage:
#   ./scripts/setup-kind-tls-test.sh
#
# Prerequisites:
#   - kind installed: https://kind.sigs.k8s.io/docs/user/quick-start/#installation
#   - kubectl installed
#   - docker installed
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${PROJECT_ROOT}/../.." && pwd)"

CLUSTER_NAME="${CLUSTER_NAME:-prodisco-test}"
CERT_MANAGER_VERSION="${CERT_MANAGER_VERSION:-v1.14.0}"
IMAGE_TAG="${IMAGE_TAG:-test}"

echo "=== Setting up kind cluster TLS integration test environment ==="
echo "Cluster name: ${CLUSTER_NAME}"
echo "Project root: ${PROJECT_ROOT}"
echo "Repository root: ${REPO_ROOT}"

# Check prerequisites
check_command() {
    if ! command -v "$1" &> /dev/null; then
        echo "Error: $1 is not installed"
        exit 1
    fi
}

check_command kind
check_command kubectl
check_command docker

# Create kind cluster if not exists
echo ""
echo "=== Step 1: Creating kind cluster ==="
if kind get clusters 2>/dev/null | grep -q "^${CLUSTER_NAME}$"; then
    echo "Cluster ${CLUSTER_NAME} already exists"
else
    echo "Creating cluster ${CLUSTER_NAME}..."
    kind create cluster --name "${CLUSTER_NAME}" --wait 60s
fi

# Set kubectl context
kubectl config use-context "kind-${CLUSTER_NAME}"

# Wait for cluster to be ready
echo "Waiting for cluster to be ready..."
kubectl wait --for=condition=Ready nodes --all --timeout=60s

# Install cert-manager
echo ""
echo "=== Step 2: Installing cert-manager ==="
if kubectl get namespace cert-manager &>/dev/null; then
    echo "cert-manager namespace exists, checking if deployed..."
    if kubectl get deployment cert-manager -n cert-manager &>/dev/null; then
        echo "cert-manager already installed"
    else
        echo "Installing cert-manager ${CERT_MANAGER_VERSION}..."
        kubectl apply -f "https://github.com/cert-manager/cert-manager/releases/download/${CERT_MANAGER_VERSION}/cert-manager.yaml"
    fi
else
    echo "Installing cert-manager ${CERT_MANAGER_VERSION}..."
    kubectl apply -f "https://github.com/cert-manager/cert-manager/releases/download/${CERT_MANAGER_VERSION}/cert-manager.yaml"
fi

# Wait for cert-manager to be ready
echo "Waiting for cert-manager to be ready..."
kubectl wait --for=condition=Available --timeout=120s deployment/cert-manager -n cert-manager
kubectl wait --for=condition=Available --timeout=120s deployment/cert-manager-webhook -n cert-manager
kubectl wait --for=condition=Available --timeout=120s deployment/cert-manager-cainjector -n cert-manager

# Build Docker image
echo ""
echo "=== Step 3: Building sandbox-server Docker image ==="
cd "${REPO_ROOT}"

# Build the image
echo "Building image prodisco/sandbox-server:${IMAGE_TAG}..."
docker build -f packages/sandbox-server/Dockerfile -t "prodisco/sandbox-server:${IMAGE_TAG}" .

# Load image into kind
echo "Loading image into kind cluster..."
kind load docker-image "prodisco/sandbox-server:${IMAGE_TAG}" --name "${CLUSTER_NAME}"

# Create namespace
echo ""
echo "=== Step 4: Creating namespace ==="
kubectl create namespace prodisco --dry-run=client -o yaml | kubectl apply -f -

# Apply cert-manager resources
echo ""
echo "=== Step 5: Applying cert-manager resources ==="
cd "${PROJECT_ROOT}"

echo "Applying issuer..."
kubectl apply -f k8s/cert-manager/issuer.yaml

echo "Waiting for CA certificate..."
for i in {1..30}; do
    if kubectl get secret sandbox-ca-secret -n prodisco &>/dev/null; then
        echo "CA secret created"
        break
    fi
    echo "Waiting for CA secret... (${i}/30)"
    sleep 2
done

echo "Applying server certificate..."
kubectl apply -f k8s/cert-manager/server-certificate.yaml

echo "Applying client certificate..."
kubectl apply -f k8s/cert-manager/client-certificate.yaml

# Wait for certificates
echo "Waiting for server certificate to be ready..."
for i in {1..30}; do
    STATUS=$(kubectl get certificate sandbox-server-tls -n prodisco -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || echo "")
    if [ "$STATUS" = "True" ]; then
        echo "Server certificate ready"
        break
    fi
    echo "Waiting for server certificate... (${i}/30)"
    sleep 2
done

echo "Waiting for client certificate to be ready..."
for i in {1..30}; do
    STATUS=$(kubectl get certificate sandbox-client-tls -n prodisco -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || echo "")
    if [ "$STATUS" = "True" ]; then
        echo "Client certificate ready"
        break
    fi
    echo "Waiting for client certificate... (${i}/30)"
    sleep 2
done

# Update deployment to use test image
echo ""
echo "=== Step 6: Deploying sandbox-server ==="

# Create a temporary deployment with the test image
cat <<EOF | kubectl apply -f -
apiVersion: apps/v1
kind: Deployment
metadata:
  name: sandbox-server
  namespace: prodisco
  labels:
    app: sandbox-server
spec:
  replicas: 1
  selector:
    matchLabels:
      app: sandbox-server
  template:
    metadata:
      labels:
        app: sandbox-server
    spec:
      serviceAccountName: sandbox-server
      containers:
        - name: sandbox
          image: prodisco/sandbox-server:${IMAGE_TAG}
          imagePullPolicy: IfNotPresent
          ports:
            - containerPort: 50051
              name: grpc
              protocol: TCP
          env:
            - name: SANDBOX_USE_TCP
              value: "true"
            - name: SANDBOX_TCP_HOST
              value: "0.0.0.0"
            - name: SANDBOX_TCP_PORT
              value: "50051"
            - name: SCRIPTS_CACHE_DIR
              value: "/tmp/prodisco-scripts"
            - name: SANDBOX_TRANSPORT_MODE
              value: "tls"
            - name: SANDBOX_TLS_CERT_PATH
              value: "/etc/sandbox-tls/tls.crt"
            - name: SANDBOX_TLS_KEY_PATH
              value: "/etc/sandbox-tls/tls.key"
            - name: SANDBOX_TLS_CA_PATH
              value: "/etc/sandbox-tls/ca.crt"
          resources:
            requests:
              memory: "128Mi"
              cpu: "100m"
            limits:
              memory: "512Mi"
              cpu: "500m"
          readinessProbe:
            grpc:
              port: 50051
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            grpc:
              port: 50051
            initialDelaySeconds: 10
            periodSeconds: 30
          volumeMounts:
            - name: scripts-cache
              mountPath: /tmp/prodisco-scripts
            - name: tls-certs
              mountPath: /etc/sandbox-tls
              readOnly: true
      volumes:
        - name: scripts-cache
          emptyDir: {}
        - name: tls-certs
          secret:
            secretName: sandbox-server-tls
EOF

# Apply service and RBAC from deployment.yaml
kubectl apply -f k8s/deployment.yaml

# Wait for deployment
echo "Waiting for sandbox-server deployment to be ready..."
kubectl wait --for=condition=Available --timeout=120s deployment/sandbox-server -n prodisco

echo ""
echo "=== Setup complete ==="
echo ""
echo "To run the tests:"
echo "  cd ${PROJECT_ROOT}"
echo "  SANDBOX_E2E_TESTS=true npm test -- --grep 'Kind Cluster'"
echo ""
echo "To connect manually:"
echo "  kubectl port-forward service/sandbox-server -n prodisco 50051:50051"
echo ""
echo "To view logs:"
echo "  kubectl logs -f deployment/sandbox-server -n prodisco"
echo ""
echo "To teardown:"
echo "  ./scripts/teardown-kind-tls-test.sh"
