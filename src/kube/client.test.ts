import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Store the mock function at module level so we can control it
const mockListNamespace = vi.fn();

// Mock the @kubernetes/client-node module before importing client
vi.mock('@kubernetes/client-node', () => {
  class MockKubeConfig {
    loadFromDefault = vi.fn();
    loadFromCluster = vi.fn();
    makeApiClient = vi.fn().mockReturnValue({
      listNamespace: mockListNamespace,
    });
  }

  class MockKubernetesObjectApi {
    static makeApiClient = vi.fn().mockReturnValue({});
  }

  return {
    KubeConfig: MockKubeConfig,
    CoreV1Api: class {},
    AppsV1Api: class {},
    CustomObjectsApi: class {},
    KubernetesObjectApi: MockKubernetesObjectApi,
  };
});

// Import after mocking
import { probeClusterConnectivity, resetKubeClients } from './client.js';

describe('probeClusterConnectivity', () => {
  beforeEach(() => {
    // Reset the cached clients before each test
    resetKubeClients();
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetKubeClients();
  });

  it('should succeed when cluster is reachable', async () => {
    mockListNamespace.mockResolvedValueOnce({ items: [] });

    await expect(probeClusterConnectivity()).resolves.toBeUndefined();
    expect(mockListNamespace).toHaveBeenCalledWith({ limit: 1 });
  });

  it('should throw when cluster is not reachable', async () => {
    const connectionError = new Error('connect ECONNREFUSED 127.0.0.1:6443');
    mockListNamespace.mockRejectedValueOnce(connectionError);

    await expect(probeClusterConnectivity()).rejects.toThrow('connect ECONNREFUSED 127.0.0.1:6443');
  });

  it('should throw when authentication fails', async () => {
    const authError = new Error('Unauthorized');
    mockListNamespace.mockRejectedValueOnce(authError);

    await expect(probeClusterConnectivity()).rejects.toThrow('Unauthorized');
  });

  it('should throw when cluster returns forbidden', async () => {
    const forbiddenError = new Error('Forbidden: User cannot list namespaces at the cluster scope');
    mockListNamespace.mockRejectedValueOnce(forbiddenError);

    await expect(probeClusterConnectivity()).rejects.toThrow('Forbidden');
  });
});
