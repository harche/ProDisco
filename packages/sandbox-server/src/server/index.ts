#!/usr/bin/env node
import * as grpc from '@grpc/grpc-js';
import { unlinkSync, existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { SandboxServiceService } from '../generated/sandbox.js';
import { createSandboxService } from './sandbox-service.js';

const DEFAULT_SOCKET_PATH = '/tmp/prodisco-sandbox.sock';
const DEFAULT_TCP_HOST = '0.0.0.0';
const DEFAULT_TCP_PORT = 50051;

/**
 * Transport security modes for gRPC communication.
 *
 * - `insecure`: No encryption (Unix socket or TCP, for local development)
 * - `tls`: Server-side TLS (client verifies server identity)
 * - `mtls`: Mutual TLS (both client and server authenticate each other)
 */
export type TransportMode = 'insecure' | 'tls' | 'mtls';

export interface TlsConfig {
  /** Path to the server certificate file */
  certPath: string;
  /** Path to the server private key file */
  keyPath: string;
  /** Path to the CA certificate for verifying client certs (required for mTLS) */
  caPath?: string;
}

export interface ServerConfig {
  /** Unix socket path for local connections */
  socketPath?: string;
  /** TCP host to bind to (e.g., '0.0.0.0', 'localhost') */
  tcpHost?: string;
  /** TCP port to bind to */
  tcpPort?: number;
  /** Use TCP transport instead of Unix socket (legacy, prefer transportMode) */
  useTcp?: boolean;
  /** Transport security mode */
  transportMode?: TransportMode;
  /** TLS configuration (required for 'tls' and 'mtls' modes) */
  tls?: TlsConfig;
  prometheusUrl?: string;
  cacheDir?: string;
}

/**
 * Clean up existing socket file if present.
 */
function cleanupSocket(socketPath: string): void {
  if (existsSync(socketPath)) {
    try {
      unlinkSync(socketPath);
    } catch (error) {
      // Ignore ENOENT, throw others
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
}

const VALID_TRANSPORT_MODES: TransportMode[] = ['insecure', 'tls', 'mtls'];

/**
 * Get the transport mode from config or environment.
 * Defaults to 'insecure' for backward compatibility.
 */
function getTransportMode(config: ServerConfig): TransportMode {
  // Config takes precedence
  if (config.transportMode) {
    return config.transportMode;
  }

  // Check environment variable
  const envMode = process.env.SANDBOX_TRANSPORT_MODE;
  if (envMode && VALID_TRANSPORT_MODES.includes(envMode as TransportMode)) {
    return envMode as TransportMode;
  }

  return 'insecure';
}

/**
 * Get TLS configuration from config or environment.
 */
function getTlsConfig(config: ServerConfig): TlsConfig | undefined {
  if (config.tls) {
    return config.tls;
  }

  const certPath = process.env.SANDBOX_TLS_CERT_PATH;
  const keyPath = process.env.SANDBOX_TLS_KEY_PATH;
  const caPath = process.env.SANDBOX_TLS_CA_PATH;

  if (certPath && keyPath) {
    return { certPath, keyPath, caPath };
  }

  return undefined;
}

/**
 * Create server credentials based on transport mode.
 */
function createServerCredentials(mode: TransportMode, tls?: TlsConfig): grpc.ServerCredentials {
  if (mode === 'insecure') {
    return grpc.ServerCredentials.createInsecure();
  }

  if (!tls) {
    throw new Error(`TLS configuration required for transport mode: ${mode}`);
  }

  const certChain = readFileSync(tls.certPath);
  const privateKey = readFileSync(tls.keyPath);

  // For mTLS, load CA to verify client certificates
  const rootCerts = mode === 'mtls' && tls.caPath ? readFileSync(tls.caPath) : null;

  return grpc.ServerCredentials.createSsl(
    rootCerts,
    [{ cert_chain: certChain, private_key: privateKey }],
    mode === 'mtls' // checkClientCertificate
  );
}

/**
 * Determine if Unix socket should be used based on config and environment.
 */
function shouldUseUnixSocket(config: ServerConfig): boolean {
  // Explicit useTcp takes precedence
  if (config.useTcp !== undefined) {
    return !config.useTcp;
  }

  // Check environment variable
  const envUseTcp = process.env.SANDBOX_USE_TCP;
  if (envUseTcp === 'true' || envUseTcp === '1') {
    return false;
  }

  // Check if TCP host or port is specified
  if (config.tcpHost || config.tcpPort || process.env.SANDBOX_TCP_HOST || process.env.SANDBOX_TCP_PORT) {
    return false;
  }

  // Check if socket path is specified
  if (config.socketPath || process.env.SANDBOX_SOCKET_PATH) {
    return true;
  }

  // Default to Unix socket for local development
  return true;
}

/**
 * Get the binding address based on configuration.
 */
function getBindAddress(config: ServerConfig): { address: string; isUnixSocket: boolean } {
  if (shouldUseUnixSocket(config)) {
    const socketPath = config.socketPath || process.env.SANDBOX_SOCKET_PATH || DEFAULT_SOCKET_PATH;
    return { address: `unix://${socketPath}`, isUnixSocket: true };
  }

  const host = config.tcpHost || process.env.SANDBOX_TCP_HOST || DEFAULT_TCP_HOST;
  const port = config.tcpPort || parseInt(process.env.SANDBOX_TCP_PORT || '', 10) || DEFAULT_TCP_PORT;
  return { address: `${host}:${port}`, isUnixSocket: false };
}

/**
 * Start the gRPC sandbox server.
 *
 * Supports Unix socket (default) or TCP transport, with configurable security modes.
 *
 * Unix socket (default, insecure):
 *   startServer({ socketPath: '/tmp/sandbox.sock' })
 *
 * TCP (insecure):
 *   startServer({ useTcp: true, tcpHost: '0.0.0.0', tcpPort: 50051 })
 *
 * TCP with TLS (server-side TLS):
 *   startServer({
 *     useTcp: true,
 *     transportMode: 'tls',
 *     tls: { certPath: '/path/to/tls.crt', keyPath: '/path/to/tls.key' }
 *   })
 *
 * TCP with mTLS (mutual TLS):
 *   startServer({
 *     useTcp: true,
 *     transportMode: 'mtls',
 *     tls: { certPath: '/path/to/tls.crt', keyPath: '/path/to/tls.key', caPath: '/path/to/ca.crt' }
 *   })
 */
export async function startServer(config: ServerConfig = {}): Promise<grpc.Server> {
  const transportMode = getTransportMode(config);
  const tlsConfig = getTlsConfig(config);
  const { address, isUnixSocket } = getBindAddress(config);

  // Clean up existing socket file if using Unix socket
  if (isUnixSocket) {
    const socketPath = address.replace('unix://', '');
    cleanupSocket(socketPath);
  }

  const server = new grpc.Server();

  // Create service with k8s/prometheus context
  const sandboxService = createSandboxService({
    prometheusUrl: config.prometheusUrl || process.env.PROMETHEUS_URL,
    cacheDir: config.cacheDir || process.env.SCRIPTS_CACHE_DIR,
  });

  server.addService(SandboxServiceService, sandboxService);

  // Create credentials based on transport mode
  const credentials = createServerCredentials(transportMode, tlsConfig);

  return new Promise((resolve, reject) => {
    server.bindAsync(address, credentials, (error) => {
      if (error) {
        reject(error);
        return;
      }
      const securityInfo =
        transportMode === 'insecure'
          ? '(insecure)'
          : transportMode === 'mtls'
            ? '(mTLS)'
            : '(TLS)';
      console.log(`Sandbox gRPC server listening on ${address} ${securityInfo}`);
      resolve(server);
    });
  });
}

/**
 * Graceful shutdown handler.
 */
function setupShutdown(server: grpc.Server, socketPath: string | null): void {
  const shutdown = (signal: string) => {
    console.log(`Received ${signal}, shutting down...`);

    server.tryShutdown((err) => {
      if (err) {
        console.error('Error during shutdown', err);
        server.forceShutdown();
      }

      // Clean up socket file (only for Unix socket)
      if (socketPath) {
        cleanupSocket(socketPath);
      }

      console.log('Server shut down');
      process.exit(0);
    });

    // Set a deadline for graceful shutdown
    setTimeout(() => {
      console.warn('Forced shutdown after timeout');
      server.forceShutdown();
      if (socketPath) {
        cleanupSocket(socketPath);
      }
      process.exit(1);
    }, 10000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

interface LibraryEntry {
  name: string;
  install?: string;
}

/**
 * Parse library entries from a config file.
 * Returns an array of { name, install? } objects.
 */
function parseLibrariesFromConfig(configPath: string): LibraryEntry[] {
  if (!existsSync(configPath)) {
    return [];
  }

  try {
    const content = readFileSync(configPath, 'utf-8');
    const config = parseYaml(content) as {
      libraries?: Array<{ name: string; install?: string }>;
    };

    if (config.libraries && Array.isArray(config.libraries)) {
      return config.libraries
        .filter(
          (lib): lib is { name: string; install?: string } =>
            lib != null &&
            typeof lib === 'object' &&
            typeof lib.name === 'string' &&
            lib.name.trim().length > 0,
        )
        .map((lib) => ({
          name: lib.name.trim(),
          install: typeof lib.install === 'string' ? lib.install.trim() : undefined,
        }));
    }
  } catch (error) {
    console.warn(`Failed to parse config from ${configPath}:`, error);
  }

  return [];
}

/**
 * Load allowed modules from a config file and set SANDBOX_ALLOWED_MODULES env var.
 * Config file format: { libraries: [{ name: string, ... }, ...] }
 */
function loadAllowedModulesFromConfig(configPath: string): void {
  const libraries = parseLibrariesFromConfig(configPath);
  if (libraries.length > 0) {
    const moduleNames = libraries.map((lib) => lib.name);
    process.env.SANDBOX_ALLOWED_MODULES = JSON.stringify(moduleNames);
    console.log(`Loaded allowed modules from config: ${moduleNames.join(', ')}`);
  }
}

/**
 * Ensure all libraries declared in the config are installed in node_modules.
 *
 * This acts as a safety net: if the Docker image was built with EXTRA_NPM_PACKAGES
 * (via build-images.ts), all libraries are already present and this is a no-op.
 * If any are missing (e.g. image built without the build arg), they get installed
 * on first startup so the config YAML is the single source of truth.
 */
function ensureLibrariesInstalled(configPath: string): void {
  const libraries = parseLibrariesFromConfig(configPath);
  if (libraries.length === 0) {
    return;
  }

  const localRequire = createRequire(import.meta.url);
  const missing: LibraryEntry[] = [];

  for (const lib of libraries) {
    try {
      localRequire.resolve(lib.name);
    } catch {
      missing.push(lib);
    }
  }

  if (missing.length === 0) {
    console.log('All configured libraries are already installed');
    return;
  }

  const installSpecs = missing.map((lib) => lib.install || lib.name);
  console.log(`Installing missing libraries: ${installSpecs.join(', ')}`);

  const result = spawnSync(
    'npm',
    ['install', '--no-save', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts', ...installSpecs],
    { stdio: 'inherit', cwd: process.cwd() },
  );

  if (result.status !== 0) {
    console.error(`Failed to install libraries (exit code ${result.status}). Some sandbox libraries may be unavailable.`);
  } else {
    console.log('Successfully installed missing libraries');
  }
}

/**
 * Read the Kubernetes service account token and set it as an environment variable.
 * This allows sandboxed scripts (which can't access the filesystem) to use the token.
 */
function loadServiceAccountToken(): void {
  const tokenPath = '/var/run/secrets/kubernetes.io/serviceaccount/token';
  if (process.env.K8S_SERVICE_ACCOUNT_TOKEN) {
    // Already set, don't override
    return;
  }
  if (existsSync(tokenPath)) {
    try {
      const token = readFileSync(tokenPath, 'utf-8').trim();
      process.env.K8S_SERVICE_ACCOUNT_TOKEN = token;
      console.log('Loaded Kubernetes service account token');
    } catch (error) {
      console.warn('Failed to read service account token:', error);
    }
  }
}

// CLI entry point
const isMainModule =
  process.argv[1] === fileURLToPath(import.meta.url) ||
  process.argv[1]?.endsWith('/sandbox-server/dist/server/index.js');

if (isMainModule) {
  // Check for --config argument or default config file path
  const configArgIndex = process.argv.indexOf('--config');
  const configPath = configArgIndex !== -1 && process.argv[configArgIndex + 1]
    ? process.argv[configArgIndex + 1]
    : '/app/.prodisco-config.yaml';

  // Load allowed modules from config file if present
  loadAllowedModulesFromConfig(configPath);

  // Install any missing libraries declared in config (safety net for images
  // built without EXTRA_NPM_PACKAGES). No-op when everything is already present.
  ensureLibrariesInstalled(configPath);

  // Load Kubernetes service account token for sandboxed scripts
  loadServiceAccountToken();

  const config: ServerConfig = {};
  const { address, isUnixSocket } = getBindAddress(config);
  const socketPath = isUnixSocket ? address.replace('unix://', '') : null;

  startServer(config)
    .then((server) => {
      setupShutdown(server, socketPath);
      console.log('Sandbox server started');
    })
    .catch((err) => {
      console.error('Failed to start sandbox server', err);
      process.exit(1);
    });
}
