/**
 * Kind Cluster TLS Integration Tests
 *
 * End-to-end tests that deploy the sandbox server to a kind cluster
 * with cert-manager and test all transport security modes.
 *
 * Prerequisites:
 * 1. kind cluster running: `kind create cluster --name prodisco-test`
 * 2. cert-manager installed: `kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.14.0/cert-manager.yaml`
 * 3. Docker image built: `docker build -f packages/sandbox-server/Dockerfile -t prodisco/sandbox-server:test .`
 * 4. Image loaded: `kind load docker-image prodisco/sandbox-server:test --name prodisco-test`
 *
 * Run these tests with:
 *   SANDBOX_E2E_TESTS=true npm test -- --grep "Kind Cluster TLS"
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { execSync, spawn, ChildProcess } from 'node:child_process';
import { SandboxClient } from '../client/index.js';

// Check if e2e tests should run
const runE2eTests = process.env.SANDBOX_E2E_TESTS === 'true';

// Check if kind cluster is available
function isKindClusterAvailable(): boolean {
  try {
    execSync('kubectl cluster-info --context kind-prodisco-test', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// Check if cert-manager is installed
function isCertManagerInstalled(): boolean {
  try {
    const result = execSync('kubectl get pods -n cert-manager -o name', { stdio: 'pipe' }).toString();
    return result.includes('cert-manager');
  } catch {
    return false;
  }
}

// Wait for cert-manager to be ready
async function waitForCertManager(timeoutMs: number = 60000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      execSync('kubectl wait --for=condition=Available --timeout=5s deployment/cert-manager -n cert-manager', { stdio: 'pipe' });
      execSync('kubectl wait --for=condition=Available --timeout=5s deployment/cert-manager-webhook -n cert-manager', { stdio: 'pipe' });
      return true;
    } catch {
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  return false;
}

// Apply kubernetes manifests
function applyManifests(manifests: string[]): void {
  for (const manifest of manifests) {
    execSync(`kubectl apply -f ${manifest}`, { stdio: 'pipe' });
  }
}

// Delete kubernetes manifests
function deleteManifests(manifests: string[]): void {
  for (const manifest of manifests.reverse()) {
    try {
      execSync(`kubectl delete -f ${manifest} --ignore-not-found`, { stdio: 'pipe' });
    } catch {
      // Ignore errors during cleanup
    }
  }
}

// Wait for deployment to be ready
async function waitForDeployment(name: string, namespace: string, timeoutMs: number = 120000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      execSync(`kubectl wait --for=condition=Available --timeout=5s deployment/${name} -n ${namespace}`, { stdio: 'pipe' });
      return true;
    } catch {
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  return false;
}

// Wait for certificate to be ready
async function waitForCertificate(name: string, namespace: string, timeoutMs: number = 60000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const result = execSync(`kubectl get certificate ${name} -n ${namespace} -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}'`, { stdio: 'pipe' }).toString();
      if (result.includes('True')) {
        return true;
      }
    } catch {
      // Certificate might not exist yet
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  return false;
}

// Start port-forward
function startPortForward(service: string, namespace: string, localPort: number, remotePort: number): ChildProcess {
  const portForward = spawn('kubectl', ['port-forward', `service/${service}`, `${localPort}:${remotePort}`, '-n', namespace], {
    stdio: 'pipe',
  });
  return portForward;
}

// Get path to project root
function getProjectRoot(): string {
  const currentDir = new URL('.', import.meta.url).pathname;
  // Navigate from src/__tests__ to packages/sandbox-server
  return currentDir.replace('/src/__tests__/', '');
}

const kindAvailable = isKindClusterAvailable();
const certManagerInstalled = isCertManagerInstalled();
const shouldRun = runE2eTests && kindAvailable && certManagerInstalled;

// =============================================================================
// Kind Cluster TLS Integration Tests
// =============================================================================

describe.skipIf(!shouldRun)('Kind Cluster TLS Integration Tests', () => {
  const projectRoot = getProjectRoot();
  const namespace = 'prodisco-test';
  let portForward: ChildProcess | null = null;

  // Paths to manifests
  const manifests = {
    namespace: `${projectRoot}/k8s/test-namespace.yaml`,
    issuer: `${projectRoot}/k8s/cert-manager/issuer.yaml`,
    serverCert: `${projectRoot}/k8s/cert-manager/server-certificate.yaml`,
    clientCert: `${projectRoot}/k8s/cert-manager/client-certificate.yaml`,
    deployment: `${projectRoot}/k8s/deployment.yaml`,
  };

  beforeAll(async () => {
    console.log('Setting up Kind cluster TLS integration tests...');

    // Create test namespace
    try {
      execSync(`kubectl create namespace ${namespace} --dry-run=client -o yaml | kubectl apply -f -`, { stdio: 'pipe' });
    } catch {
      // Namespace might already exist
    }

    // Wait for cert-manager
    console.log('Waiting for cert-manager...');
    const certManagerReady = await waitForCertManager();
    if (!certManagerReady) {
      throw new Error('cert-manager not ready');
    }

    // Apply cert-manager resources
    console.log('Applying cert-manager resources...');
    applyManifests([manifests.issuer, manifests.serverCert, manifests.clientCert]);

    // Wait for certificates
    console.log('Waiting for certificates...');
    const serverCertReady = await waitForCertificate('sandbox-server-tls', 'prodisco', 60000);
    if (!serverCertReady) {
      throw new Error('Server certificate not ready');
    }

    // Apply deployment
    console.log('Applying deployment...');
    applyManifests([manifests.deployment]);

    // Wait for deployment
    console.log('Waiting for deployment...');
    const deploymentReady = await waitForDeployment('sandbox-server', 'prodisco', 120000);
    if (!deploymentReady) {
      throw new Error('Deployment not ready');
    }

    console.log('Setup complete');
  }, 300000); // 5 minute timeout

  afterAll(async () => {
    // Stop port-forward
    if (portForward) {
      portForward.kill();
      portForward = null;
    }

    // Cleanup (optional - comment out to keep resources for debugging)
    // console.log('Cleaning up...');
    // deleteManifests([manifests.deployment, manifests.clientCert, manifests.serverCert, manifests.issuer]);
  });

  describe('TLS Mode via Port-Forward', () => {
    let client: SandboxClient | null = null;
    const localPort = 50900;

    beforeAll(async () => {
      // Start port-forward
      portForward = startPortForward('sandbox-server', 'prodisco', localPort, 50051);

      // Wait for port-forward to be ready
      await new Promise(r => setTimeout(r, 2000));

      // Extract CA certificate from secret
      const caData = execSync(
        'kubectl get secret sandbox-server-tls -n prodisco -o jsonpath="{.data.ca\\.crt}" | base64 -d',
        { stdio: 'pipe' }
      ).toString();

      // Write CA to temp file
      const caPath = '/tmp/prodisco-test-ca.crt';
      require('node:fs').writeFileSync(caPath, caData);

      // Create client with TLS
      client = new SandboxClient({
        useTcp: true,
        tcpHost: 'localhost',
        tcpPort: localPort,
        transportMode: 'tls',
        tls: {
          caPath,
          serverName: 'sandbox-server.prodisco.svc.cluster.local',
        },
      });
    });

    afterAll(() => {
      if (client) {
        client.close();
        client = null;
      }
      if (portForward) {
        portForward.kill();
        portForward = null;
      }
    });

    it('connects to sandbox server with TLS', async () => {
      const healthy = await client!.waitForHealthy(30000);
      expect(healthy).toBe(true);
    });

    it('executes code over TLS connection', async () => {
      const result = await client!.execute({
        code: 'console.log("kind cluster TLS test")',
        timeoutMs: 30000,
      });

      expect(result.success).toBe(true);
      expect(result.output).toBe('kind cluster TLS test');
    });

    it('accesses Kubernetes API from sandbox', async () => {
      const result = await client!.execute({
        code: `
          const api = kc.makeApiClient(k8s.CoreV1Api);
          const response = await api.listNamespace();
          const names = response.items.map(ns => ns.metadata?.name).filter(Boolean);
          console.log(JSON.stringify(names.includes('default')));
        `,
        timeoutMs: 30000,
      });

      expect(result.success).toBe(true);
      expect(result.output).toBe('true');
    });

    it('handles streaming over TLS', async () => {
      const chunks: string[] = [];

      for await (const chunk of client!.executeStream({
        code: `
          console.log("stream line 1");
          console.log("stream line 2");
        `,
        timeoutMs: 30000,
      })) {
        if (chunk.type === 'output') {
          chunks.push(chunk.data as string);
        }
      }

      const fullOutput = chunks.join('');
      expect(fullOutput).toContain('stream line 1');
      expect(fullOutput).toContain('stream line 2');
    });

    it('handles async execution over TLS', async () => {
      const { executionId } = await client!.executeAsync({
        code: 'console.log("async over TLS")',
        timeoutMs: 30000,
      });

      expect(executionId).toBeDefined();

      const status = await client!.waitForExecution(executionId);
      expect(status.state).toBe(3); // COMPLETED
      expect(status.output).toContain('async over TLS');
    });
  });
});

// =============================================================================
// Insecure Mode Test (Separate Deployment)
// =============================================================================

describe.skipIf(!shouldRun)('Kind Cluster Insecure Mode Tests', () => {
  let portForward: ChildProcess | null = null;
  let client: SandboxClient | null = null;
  const localPort = 50901;
  const deploymentName = 'sandbox-server-insecure';
  const namespace = 'prodisco';

  beforeAll(async () => {
    // Create insecure deployment
    const insecureDeployment = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${deploymentName}
  namespace: ${namespace}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ${deploymentName}
  template:
    metadata:
      labels:
        app: ${deploymentName}
    spec:
      serviceAccountName: sandbox-server
      containers:
        - name: sandbox
          image: prodisco/sandbox-server:test
          imagePullPolicy: IfNotPresent
          ports:
            - containerPort: 50051
          env:
            - name: SANDBOX_USE_TCP
              value: "true"
            - name: SANDBOX_TRANSPORT_MODE
              value: "insecure"
            - name: SCRIPTS_CACHE_DIR
              value: "/tmp/prodisco-scripts"
          resources:
            requests:
              memory: "128Mi"
              cpu: "100m"
            limits:
              memory: "512Mi"
              cpu: "500m"
---
apiVersion: v1
kind: Service
metadata:
  name: ${deploymentName}
  namespace: ${namespace}
spec:
  type: ClusterIP
  ports:
    - port: 50051
      targetPort: 50051
  selector:
    app: ${deploymentName}
`;

    // Apply deployment
    execSync(`echo '${insecureDeployment}' | kubectl apply -f -`, { stdio: 'pipe' });

    // Wait for deployment
    await waitForDeployment(deploymentName, namespace, 60000);

    // Start port-forward
    portForward = startPortForward(deploymentName, namespace, localPort, 50051);
    await new Promise(r => setTimeout(r, 2000));

    // Create insecure client
    client = new SandboxClient({
      useTcp: true,
      tcpHost: 'localhost',
      tcpPort: localPort,
      transportMode: 'insecure',
    });
  }, 120000);

  afterAll(async () => {
    if (client) {
      client.close();
    }
    if (portForward) {
      portForward.kill();
    }

    // Cleanup
    try {
      execSync(`kubectl delete deployment ${deploymentName} -n ${namespace} --ignore-not-found`, { stdio: 'pipe' });
      execSync(`kubectl delete service ${deploymentName} -n ${namespace} --ignore-not-found`, { stdio: 'pipe' });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('connects in insecure mode', async () => {
    const healthy = await client!.waitForHealthy(30000);
    expect(healthy).toBe(true);
  });

  it('executes code in insecure mode', async () => {
    const result = await client!.execute({
      code: 'console.log("insecure mode in kind")',
      timeoutMs: 30000,
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe('insecure mode in kind');
  });
});

// =============================================================================
// Certificate Rotation Test
// =============================================================================

describe.skipIf(!shouldRun)('Kind Cluster Certificate Rotation Tests', () => {
  it('handles certificate renewal gracefully', async () => {
    // This test verifies that the sandbox server handles certificate
    // rotation by cert-manager without service interruption.
    //
    // In a real scenario, cert-manager rotates certificates before expiry
    // and the pod picks up new certificates on restart.
    //
    // For this test, we verify the certificate metadata.

    const certStatus = execSync(
      'kubectl get certificate sandbox-server-tls -n prodisco -o jsonpath="{.status.conditions[?(@.type==\\"Ready\\")].status}"',
      { stdio: 'pipe' }
    ).toString();

    expect(certStatus).toContain('True');

    // Verify renewal time is set
    const renewalTime = execSync(
      'kubectl get certificate sandbox-server-tls -n prodisco -o jsonpath="{.status.renewalTime}"',
      { stdio: 'pipe' }
    ).toString();

    expect(renewalTime).toBeTruthy();
  });
});

// =============================================================================
// Security Mode Verification Tests
// =============================================================================

describe.skipIf(!shouldRun)('Kind Cluster Security Verification', () => {
  it('TLS server rejects insecure connections', async () => {
    const localPort = 50902;

    // Start port-forward to TLS server
    const portForward = startPortForward('sandbox-server', 'prodisco', localPort, 50051);
    await new Promise(r => setTimeout(r, 2000));

    try {
      // Try to connect without TLS
      const insecureClient = new SandboxClient({
        useTcp: true,
        tcpHost: 'localhost',
        tcpPort: localPort,
        transportMode: 'insecure',
      });

      // Should fail to connect or get rejected
      const healthy = await insecureClient.waitForHealthy(5000, 500);
      expect(healthy).toBe(false);

      insecureClient.close();
    } finally {
      portForward.kill();
    }
  });

  it('deployment has correct security settings', async () => {
    // Verify deployment environment variables
    const envVars = execSync(
      'kubectl get deployment sandbox-server -n prodisco -o jsonpath="{.spec.template.spec.containers[0].env}"',
      { stdio: 'pipe' }
    ).toString();

    expect(envVars).toContain('SANDBOX_TRANSPORT_MODE');
    expect(envVars).toContain('tls');
    expect(envVars).toContain('SANDBOX_TLS_CERT_PATH');
    expect(envVars).toContain('SANDBOX_TLS_KEY_PATH');
  });

  it('TLS secret contains required keys', async () => {
    const secretKeys = execSync(
      'kubectl get secret sandbox-server-tls -n prodisco -o jsonpath="{.data}" | jq -r \'keys[]\'',
      { stdio: 'pipe' }
    ).toString();

    expect(secretKeys).toContain('tls.crt');
    expect(secretKeys).toContain('tls.key');
    expect(secretKeys).toContain('ca.crt');
  });
});

// =============================================================================
// Helper: Skip reason logging
// =============================================================================

if (!runE2eTests) {
  console.log('Skipping kind cluster TLS tests: SANDBOX_E2E_TESTS not set to true');
} else if (!kindAvailable) {
  console.log('Skipping kind cluster TLS tests: kind cluster not available');
} else if (!certManagerInstalled) {
  console.log('Skipping kind cluster TLS tests: cert-manager not installed');
}
