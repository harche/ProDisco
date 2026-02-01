import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as net from 'node:net';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

function repoRoot(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  return path.resolve(__dirname, '..', '..');
}

async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close(() => reject(new Error('Failed to allocate an ephemeral TCP port')));
        return;
      }
      const port = addr.port;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function parseSseJsonRpcEvents(bodyText: string): JsonRpcResponse[] {
  const events: JsonRpcResponse[] = [];
  const lines = bodyText.split('\n');
  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    const json = line.slice('data: '.length).trim();
    if (!json) continue;
    events.push(JSON.parse(json) as JsonRpcResponse);
  }
  return events;
}

async function waitForHealth(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) {
        const json = await res.json().catch(() => null);
        if (json && typeof json === 'object' && (json as { status?: unknown }).status === 'ok') {
          return;
        }
      }
    } catch {
      // ignore and retry
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for /health on port ${port}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function mcpRequest(options: {
  port: number;
  sessionId?: string;
  id: number;
  method: string;
  params?: unknown;
}): Promise<JsonRpcResponse> {
  const res = await fetch(`http://127.0.0.1:${options.port}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Required by StreamableHTTPServerTransport
      Accept: 'application/json, text/event-stream',
      ...(options.sessionId ? { 'mcp-session-id': options.sessionId } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: options.id,
      method: options.method,
      params: options.params ?? {},
    }),
  });

  const text = await res.text();
  const events = parseSseJsonRpcEvents(text);
  if (events.length === 0) {
    throw new Error(`No SSE JSON-RPC events returned for ${options.method}. HTTP ${res.status}. Body:\n${text}`);
  }
  const last = events[events.length - 1]!;
  if (last.error) {
    throw new Error(`JSON-RPC error for ${options.method}: ${last.error.message}`);
  }
  return last;
}

async function mcpInitialize(port: number): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'examples-smoke', version: '1.0.0' },
      },
    }),
  });

  const sessionId = res.headers.get('mcp-session-id');
  const body = await res.text();
  if (!res.ok || !sessionId) {
    throw new Error(`Failed to initialize MCP session. HTTP ${res.status}. sessionId=${sessionId}\n${body}`);
  }
  // Also sanity-check the JSON-RPC response exists.
  const events = parseSseJsonRpcEvents(body);
  if (events.length === 0 || events[0]?.error) {
    throw new Error(`Initialize returned no/invalid JSON-RPC SSE event. Body:\n${body}`);
  }
  return sessionId;
}

async function assertToolsList(port: number, sessionId: string): Promise<void> {
  const resp = await mcpRequest({
    port,
    sessionId,
    id: 2,
    method: 'tools/list',
    params: {},
  });

  const result = resp.result as { tools?: Array<{ name?: unknown }> } | undefined;
  const tools = result?.tools ?? [];
  const names = tools.map((t) => String(t.name));

  const required = ['prodisco.searchTools', 'prodisco.runSandbox'];
  for (const name of required) {
    if (!names.includes(name)) {
      throw new Error(`tools/list missing "${name}". Got: ${names.join(', ')}`);
    }
  }
}

async function assertSearchWorks(port: number, sessionId: string, args: Record<string, unknown>, expectNameContains: string): Promise<void> {
  const resp = await mcpRequest({
    port,
    sessionId,
    id: 3,
    method: 'tools/call',
    params: { name: 'prodisco.searchTools', arguments: args },
  });

  const result = resp.result as { structuredContent?: unknown } | undefined;
  const structured = result?.structuredContent as { results?: Array<{ name?: string }> } | undefined;
  const names = (structured?.results ?? []).map((r) => r.name ?? '');

  if (names.length === 0) {
    throw new Error(`searchTools returned 0 results for args=${JSON.stringify(args)}`);
  }
  const hit = names.some((n) => n.toLowerCase().includes(expectNameContains.toLowerCase()));
  if (!hit) {
    throw new Error(`searchTools results did not include "${expectNameContains}". Got: ${names.join(', ')}`);
  }
}

async function assertRunSandboxWorks(port: number, sessionId: string, code: string, expectOutputContains: string): Promise<void> {
  const resp = await mcpRequest({
    port,
    sessionId,
    id: 4,
    method: 'tools/call',
    params: { name: 'prodisco.runSandbox', arguments: { code } },
  });

  const result = resp.result as { structuredContent?: unknown } | undefined;
  const structured = result?.structuredContent as { success?: boolean; output?: string; error?: string } | undefined;

  if (!structured || structured.success !== true) {
    throw new Error(`runSandbox failed. error=${structured?.error ?? 'unknown'}`);
  }
  const output = structured.output ?? '';
  if (!output.includes(expectOutputContains)) {
    throw new Error(`runSandbox output did not include "${expectOutputContains}". Output:\n${output}`);
  }
}

type ServerHandle = {
  port: number;
  proc: ChildProcessWithoutNullStreams;
  logs: string[];
};

async function startServerWithConfig(options: {
  configPath: string;
  startupTimeoutMs: number;
}): Promise<ServerHandle> {
  const root = repoRoot();
  const port = await getFreePort();

  const socketPath = `/tmp/prodisco-ci-sandbox-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`;
  const scriptsDir = `/tmp/prodisco-ci-scripts-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  await fs.mkdir(scriptsDir, { recursive: true });

  const args: string[] = [
    path.join(root, 'dist', 'server.js'),
    '--transport', 'http',
    '--host', '127.0.0.1',
    '--port', String(port),
    '--config', options.configPath,
  ];

  const proc = spawn('node', args, {
    cwd: root,
    env: {
      ...process.env,
      SANDBOX_SOCKET_PATH: socketPath,
      SCRIPTS_CACHE_DIR: scriptsDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logs: string[] = [];
  const pushLog = (line: string) => {
    logs.push(line);
    if (logs.length > 5000) logs.shift();
  };

  proc.stdout.on('data', (d) => pushLog(d.toString()));
  proc.stderr.on('data', (d) => pushLog(d.toString()));

  await waitForHealth(port, options.startupTimeoutMs);

  return { port, proc, logs };
}

async function stopServer(handle: ServerHandle): Promise<void> {
  if (handle.proc.exitCode !== null) return;
  handle.proc.kill('SIGTERM');

  const start = Date.now();
  while (handle.proc.exitCode === null) {
    if (Date.now() - start > 5000) {
      handle.proc.kill('SIGKILL');
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function runScenario(label: string, configRelPath: string, options: {
  installMissing?: boolean;
  startupTimeoutMs: number;
}): Promise<void> {
  const root = repoRoot();
  const configPath = path.join(root, configRelPath);

  const server = await startServerWithConfig({
    configPath,
    installMissing: options.installMissing,
    startupTimeoutMs: options.startupTimeoutMs,
  });

  try {
    const sessionId = await mcpInitialize(server.port);
    await assertToolsList(server.port, sessionId);

    if (label === 'kubernetes') {
      await assertSearchWorks(server.port, sessionId, {
        methodName: 'listNamespace',
        documentType: 'method',
        library: '@kubernetes/client-node',
        limit: 5,
      }, 'listNamespace');

      await assertRunSandboxWorks(
        server.port,
        sessionId,
        `
          const k8s = require("@kubernetes/client-node");
          const kc = new k8s.KubeConfig();
          kc.loadFromOptions({
            clusters: [{ name: "cluster", server: "https://example.invalid" }],
            users: [{ name: "user" }],
            contexts: [{ name: "context", user: "user", cluster: "cluster" }],
            currentContext: "context",
          });
          const api = kc.makeApiClient(k8s.CoreV1Api);
          console.log("CoreV1Api:", typeof api.listNamespace);
        `,
        'CoreV1Api: function',
      );
    } else if (label === 'pg-mem') {
      await assertSearchWorks(server.port, sessionId, {
        methodName: 'newDb',
        library: 'pg-mem',
        limit: 5,
      }, 'newDb');

      await assertRunSandboxWorks(
        server.port,
        sessionId,
        `
          const { newDb } = require("pg-mem");
          const db = newDb();
          db.public.none("create table users(id int primary key, name text);");
          db.public.none("insert into users values (1, 'ada'), (2, 'grace');");
          const rows = db.public.many("select * from users order by id;");
          console.log(JSON.stringify(rows));
        `,
        '"name":"ada"',
      );
    } else {
      throw new Error(`Unknown scenario label: ${label}`);
    }
  } catch (err) {
    // Print captured logs to aid debugging in CI
    // eslint-disable-next-line no-console
    console.error(`\n[examples-smoke] Scenario "${label}" failed. Last logs:\n${server.logs.slice(-200).join('')}\n`);
    throw err;
  } finally {
    await stopServer(server);
  }
}

async function main(): Promise<void> {
  // Kubernetes config - dependency is already in the repo.
  await runScenario('kubernetes', 'examples/prodisco.kubernetes.yaml', {
    startupTimeoutMs: 120_000,
  });

  // pg-mem is not a repo dependency; auto-install will fetch it.
  await runScenario('pg-mem', 'examples/prodisco.postgres.yaml', {
    startupTimeoutMs: 300_000,
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});


