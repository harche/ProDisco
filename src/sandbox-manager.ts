import { KubeConfig, CustomObjectsApi } from '@kubernetes/client-node';
import { SandboxClient } from '@prodisco/sandbox-server/client';
import { logger } from './util/logger.js';

export type SandboxMode = 'single' | 'multi';

export interface SandboxManagerConfig {
  mode: SandboxMode;
  /** Pre-created SandboxClient to use in single mode */
  singleClient?: SandboxClient;
  /** K8s namespace for Sandbox CRDs (default: 'prodisco') */
  namespace?: string;
  /** gRPC port on sandbox pods (default: 50051) */
  sandboxPort?: number;
  /** Container image for sandbox pods */
  sandboxImage?: string;
  /** Sandbox CRD pod template spec override (replaces the default template) */
  podTemplateSpec?: Record<string, unknown>;
  /** Timeout (ms) waiting for sandbox to become ready (default: 120000) */
  readyTimeoutMs?: number;
  /** Poll interval (ms) for checking sandbox status (default: 1000) */
  readyPollIntervalMs?: number;
  /** Idle timeout (ms) after which unused sessions are reaped (default: 600000 = 10 min) */
  sessionIdleTimeoutMs?: number;
  /** How often to check for idle sessions (ms) (default: 60000 = 1 min) */
  idleCheckIntervalMs?: number;
  /** Maximum number of concurrent sandboxes (default: 10) */
  maxSessions?: number;
}

interface SessionSandbox {
  sandboxName: string;
  client: SandboxClient;
  lastActivityMs: number;
}

const SANDBOX_GROUP = 'agents.x-k8s.io';
const SANDBOX_VERSION = 'v1alpha1';
const SANDBOX_PLURAL = 'sandboxes';

const MANAGED_BY_LABEL = 'prodisco.dev/managed-by';
const MANAGED_BY_VALUE = 'mcp-server';

function loadKubeApi(): CustomObjectsApi {
  const kc = new KubeConfig();
  kc.loadFromDefault();
  return kc.makeApiClient(CustomObjectsApi);
}

export class SandboxManager {
  private mode: SandboxMode;
  private namespace: string;
  private sandboxPort: number;
  private sandboxImage: string;
  private podTemplateSpec?: Record<string, unknown>;
  private readyTimeoutMs: number;
  private readyPollIntervalMs: number;
  private sessionIdleTimeoutMs: number;
  private maxSessions: number;

  private kubeApi: CustomObjectsApi | null = null;
  private singleClient: SandboxClient | null = null;
  private sessions = new Map<string, SessionSandbox>();
  private pendingSessions = new Map<string, Promise<void>>();
  private idleReaperTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: SandboxManagerConfig) {
    this.mode = config.mode;
    this.namespace = config.namespace ?? 'prodisco';
    this.sandboxPort = config.sandboxPort ?? 50051;
    this.sandboxImage = config.sandboxImage ?? 'prodisco/sandbox-server:latest';
    this.podTemplateSpec = config.podTemplateSpec;
    this.readyTimeoutMs = config.readyTimeoutMs ?? 120_000;
    this.readyPollIntervalMs = config.readyPollIntervalMs ?? 1_000;
    this.sessionIdleTimeoutMs = config.sessionIdleTimeoutMs ?? 600_000;
    this.maxSessions = config.maxSessions ?? 10;

    if (config.mode === 'single' && config.singleClient) {
      this.singleClient = config.singleClient;
    }

    // Start idle reaper in multi mode
    if (config.mode === 'multi') {
      const interval = config.idleCheckIntervalMs ?? 60_000;
      this.idleReaperTimer = setInterval(() => {
        this.reapIdleSessions().catch((err) =>
          logger.error('Idle reaper error', err),
        );
      }, interval);
      this.idleReaperTimer.unref();
    }
  }

  private getKubeApi(): CustomObjectsApi {
    if (!this.kubeApi) {
      this.kubeApi = loadKubeApi();
    }
    return this.kubeApi;
  }

  /**
   * Get the SandboxClient for a given session.
   * In 'single' mode, returns the shared client.
   * In 'multi' mode, returns the session-specific client (waits if still initializing).
   * Also updates lastActivityMs for idle tracking.
   */
  async getClient(sessionId?: string): Promise<SandboxClient> {
    if (this.mode === 'single') {
      if (!this.singleClient) {
        throw new Error('SandboxManager: single-mode client not initialized');
      }
      return this.singleClient;
    }

    if (!sessionId) {
      throw new Error('SandboxManager: sessionId is required in multi mode');
    }

    // If the session is still initializing, wait for it
    const pending = this.pendingSessions.get(sessionId);
    if (pending) {
      await pending;
    }

    let session = this.sessions.get(sessionId);
    if (!session) {
      // Sandbox was reaped due to idle timeout — re-create it transparently
      logger.info(`Re-creating sandbox for session ${sessionId} (previously reaped)`);
      await this.onSessionInitialized(sessionId);
      session = this.sessions.get(sessionId);
      if (!session) {
        throw new Error(`SandboxManager: failed to re-create sandbox for session ${sessionId}`);
      }
    }

    session.lastActivityMs = Date.now();
    return session.client;
  }

  /**
   * Called when a new MCP session is initialized.
   * In 'multi' mode: creates a Sandbox CRD, waits for readiness, connects gRPC client.
   */
  async onSessionInitialized(sessionId: string): Promise<void> {
    if (this.mode === 'single') {
      return;
    }

    if (this.sessions.size >= this.maxSessions) {
      throw new Error(
        `SandboxManager: max concurrent sessions reached (${this.maxSessions}). ` +
        'Try again later or increase SANDBOX_MAX_SESSIONS.',
      );
    }

    const initPromise = this.initSession(sessionId);
    this.pendingSessions.set(sessionId, initPromise);

    try {
      await initPromise;
    } finally {
      this.pendingSessions.delete(sessionId);
    }
  }

  /**
   * Called when an MCP session is closed.
   * In 'multi' mode: closes the gRPC client and deletes the Sandbox CRD.
   */
  async onSessionClosed(sessionId: string): Promise<void> {
    if (this.mode === 'single') {
      return;
    }

    const session = this.sessions.get(sessionId);
    if (!session) {
      return; // Already cleaned up (e.g. both onsessionclosed and onclose fired)
    }

    this.sessions.delete(sessionId);
    session.client.close();

    try {
      await this.deleteSandboxCRD(session.sandboxName);
      logger.info(`Deleted sandbox CRD: ${session.sandboxName}`);
    } catch (error) {
      logger.error(`Failed to delete sandbox CRD ${session.sandboxName}`, error);
    }
  }

  /**
   * Cleanup all active sessions (called during server shutdown).
   */
  async shutdown(): Promise<void> {
    if (this.idleReaperTimer) {
      clearInterval(this.idleReaperTimer);
      this.idleReaperTimer = null;
    }

    if (this.mode === 'single') {
      return;
    }

    const sessionIds = [...this.sessions.keys()];
    await Promise.allSettled(
      sessionIds.map((sid) => this.onSessionClosed(sid)),
    );
  }

  /**
   * Delete orphaned Sandbox CRDs from previous server instances that didn't shut down cleanly.
   */
  async cleanupOrphanedSandboxes(): Promise<void> {
    if (this.mode === 'single') {
      return;
    }

    try {
      const result = await this.getKubeApi().listNamespacedCustomObject({
        group: SANDBOX_GROUP,
        version: SANDBOX_VERSION,
        namespace: this.namespace,
        plural: SANDBOX_PLURAL,
        labelSelector: `${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE}`,
      });

      const items = (result as { items?: Array<{ metadata?: { name?: string } }> })?.items ?? [];
      if (items.length === 0) {
        return;
      }

      logger.info(`Found ${items.length} orphaned sandbox(es), cleaning up...`);
      await Promise.allSettled(
        items.map((item) => {
          const name = item.metadata?.name;
          if (!name) return Promise.resolve();
          logger.info(`Deleting orphaned sandbox: ${name}`);
          return this.deleteSandboxCRD(name).catch((e) =>
            logger.warn(`Failed to delete orphaned sandbox ${name}: ${e}`),
          );
        }),
      );
    } catch (error) {
      logger.warn(`Failed to list orphaned sandboxes: ${error}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async reapIdleSessions(): Promise<void> {
    const now = Date.now();
    const idleSessionIds: string[] = [];

    for (const [sessionId, session] of this.sessions) {
      if (now - session.lastActivityMs > this.sessionIdleTimeoutMs) {
        idleSessionIds.push(sessionId);
      }
    }

    for (const sessionId of idleSessionIds) {
      logger.info(`Reaping idle session ${sessionId} (inactive for ${Math.round(this.sessionIdleTimeoutMs / 1000)}s)`);
      await this.onSessionClosed(sessionId).catch((err) =>
        logger.error(`Failed to reap idle session ${sessionId}`, err),
      );
    }
  }

  private async initSession(sessionId: string): Promise<void> {
    // Use a sanitized, truncated session ID for the CRD name (K8s names max 63 chars)
    const sanitized = sessionId.replace(/[^a-z0-9-]/gi, '').toLowerCase().slice(0, 40);
    const sandboxName = `sandbox-${sanitized}`;
    logger.info(`Creating sandbox CRD: ${sandboxName} for session ${sessionId}`);

    const manifest = this.buildSandboxManifest(sandboxName);

    await this.getKubeApi().createNamespacedCustomObject({
      group: SANDBOX_GROUP,
      version: SANDBOX_VERSION,
      namespace: this.namespace,
      plural: SANDBOX_PLURAL,
      body: manifest,
    });

    // Poll until status.serviceFQDN is populated
    let serviceFQDN: string;
    try {
      serviceFQDN = await this.waitForSandboxReady(sandboxName);
    } catch (error) {
      // Clean up the CRD if readiness times out
      logger.error(`Sandbox ${sandboxName} failed to become ready, cleaning up`, error);
      await this.deleteSandboxCRD(sandboxName).catch(() => {});
      throw error;
    }

    logger.info(`Sandbox ${sandboxName} ready at ${serviceFQDN}`);

    const client = new SandboxClient({
      useTcp: true,
      tcpHost: serviceFQDN,
      tcpPort: this.sandboxPort,
    });

    // Wait for gRPC health
    const healthy = await client.waitForHealthy(this.readyTimeoutMs);
    if (!healthy) {
      client.close();
      await this.deleteSandboxCRD(sandboxName).catch(() => {});
      throw new Error(`Sandbox ${sandboxName} gRPC server not healthy within timeout`);
    }

    this.sessions.set(sessionId, { sandboxName, client, lastActivityMs: Date.now() });
    logger.info(`Session ${sessionId} bound to sandbox ${sandboxName}`);
  }

  private buildSandboxManifest(name: string): Record<string, unknown> {
    const podTemplate = this.podTemplateSpec ?? {
      metadata: {
        labels: {
          app: 'sandbox-server',
          'prodisco.dev/sandbox': name,
        },
      },
      spec: {
        serviceAccountName: 'sandbox-server',
        containers: [
          {
            name: 'sandbox',
            image: this.sandboxImage,
            imagePullPolicy: 'IfNotPresent',
            ports: [
              {
                containerPort: this.sandboxPort,
                name: 'grpc',
                protocol: 'TCP',
              },
            ],
            env: [
              { name: 'SANDBOX_USE_TCP', value: 'true' },
              { name: 'SANDBOX_TCP_HOST', value: '0.0.0.0' },
              { name: 'SANDBOX_TCP_PORT', value: String(this.sandboxPort) },
              { name: 'SCRIPTS_CACHE_DIR', value: '/tmp/prodisco-scripts' },
              { name: 'SANDBOX_TRANSPORT_MODE', value: 'insecure' },
            ],
            resources: {
              requests: { memory: '128Mi', cpu: '100m' },
              limits: { memory: '512Mi', cpu: '500m' },
            },
            volumeMounts: [
              { name: 'scripts-cache', mountPath: '/tmp/prodisco-scripts' },
            ],
          },
        ],
        volumes: [{ name: 'scripts-cache', emptyDir: {} }],
      },
    };

    return {
      apiVersion: `${SANDBOX_GROUP}/${SANDBOX_VERSION}`,
      kind: 'Sandbox',
      metadata: {
        name,
        namespace: this.namespace,
        labels: {
          app: 'sandbox-server',
          [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
        },
      },
      spec: {
        podTemplate,
      },
    };
  }

  private async waitForSandboxReady(name: string): Promise<string> {
    const startMs = Date.now();

    while (Date.now() - startMs < this.readyTimeoutMs) {
      try {
        const resource = (await this.getKubeApi().getNamespacedCustomObject({
          group: SANDBOX_GROUP,
          version: SANDBOX_VERSION,
          namespace: this.namespace,
          plural: SANDBOX_PLURAL,
          name,
        })) as { status?: { serviceFQDN?: string } };

        if (resource.status?.serviceFQDN) {
          return resource.status.serviceFQDN;
        }
      } catch (error) {
        logger.warn(`Polling sandbox ${name} status: ${error instanceof Error ? error.message : String(error)}`);
      }

      await new Promise((r) => setTimeout(r, this.readyPollIntervalMs));
    }

    throw new Error(
      `Sandbox ${name} did not become ready within ${this.readyTimeoutMs}ms`,
    );
  }

  private async deleteSandboxCRD(name: string): Promise<void> {
    await this.getKubeApi().deleteNamespacedCustomObject({
      group: SANDBOX_GROUP,
      version: SANDBOX_VERSION,
      namespace: this.namespace,
      plural: SANDBOX_PLURAL,
      name,
    });
  }
}
