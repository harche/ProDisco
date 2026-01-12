#!/usr/bin/env node
// Test: Auto-generate re-exports to make all library symbols searchable

import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

const WORKSPACE = '/Users/harpatil/Projects/interface-mcp/prodisco/.cache/deps';
const LSP_WORKSPACE = path.join(WORKSPACE, '.prodisco-lsp');
const LSP_SERVER = '/Users/harpatil/Projects/interface-mcp/prodisco/node_modules/.bin/typescript-language-server';

// Extract exported symbol names - fixed version
function extractExports(filePath, allExports, visited) {
  if (!filePath || visited.has(filePath) || !fs.existsSync(filePath)) return;
  visited.add(filePath);

  const content = fs.readFileSync(filePath, 'utf-8');

  // Extract direct exports from this file (interface/type/class/function/const/enum)
  const directExportMatch = content.matchAll(/export\s+(?:declare\s+)?(?:interface|type|class|function|const|let|var|enum)\s+(\w+)/g);
  for (const match of directExportMatch) {
    allExports.add(match[1]);
  }

  // Extract named re-exports: export { name } from './path' - the names are the public API
  const namedReExportMatch = content.matchAll(/export\s+(?:type\s+)?\{\s*([^}]+)\s*\}\s+from\s+['"]([^'"]+)['"]/g);
  for (const match of namedReExportMatch) {
    const names = match[1].split(',').map(n => {
      const trimmed = n.trim();
      const asMatch = trimmed.match(/(\w+)\s+as\s+(\w+)/);
      return asMatch ? asMatch[2] : trimmed.split(/\s+/)[0];
    });
    names.forEach(n => n && allExports.add(n));
    // Don't follow these paths - we already have the named exports
  }

  // Only follow 'export * from' patterns
  const starExports = content.matchAll(/export\s+\*\s+from\s+['"]([^'"]+)['"]/g);
  for (const match of starExports) {
    const refPath = match[1];
    if (refPath.startsWith('.')) {
      const resolvedPath = resolveModulePath(path.dirname(filePath), refPath);
      if (resolvedPath) {
        extractExports(resolvedPath, allExports, visited);
      }
    }
  }
}

// Resolve a module path to actual file path
function resolveModulePath(basePath, modulePath) {
  let resolved = path.resolve(basePath, modulePath);

  // Try as-is with .d.ts extension
  if (fs.existsSync(resolved + '.d.ts')) {
    return resolved + '.d.ts';
  }

  // Try as directory with index.d.ts
  if (fs.existsSync(path.join(resolved, 'index.d.ts'))) {
    return path.join(resolved, 'index.d.ts');
  }

  // Try as-is (already has extension)
  if (fs.existsSync(resolved)) {
    return resolved;
  }

  return null;
}

// Recursively find and extract all exports from a library
function getAllLibraryExports(libPath) {
  const allExports = new Set();
  const visited = new Set();
  const indexPath = path.join(libPath, 'index.d.ts');
  extractExports(indexPath, allExports, visited);
  return [...allExports];
}

function setupLspWorkspace() {
  if (fs.existsSync(LSP_WORKSPACE)) fs.rmSync(LSP_WORKSPACE, { recursive: true });
  fs.mkdirSync(LSP_WORKSPACE, { recursive: true });

  const tsconfig = {
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      esModuleInterop: true,
      strict: false,
      skipLibCheck: true,
      noEmit: true,
      baseUrl: '..',
      paths: { '*': ['node_modules/*'] },
    },
    include: ['./*.ts'],
    exclude: [],
  };
  fs.writeFileSync(path.join(LSP_WORKSPACE, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2), 'utf-8');

  // Extract all exports from pg-mem
  const pgMemPath = path.join(WORKSPACE, 'node_modules', 'pg-mem');
  const exports = getAllLibraryExports(pgMemPath);
  console.log(`Found ${exports.length} exports from pg-mem`);
  console.log('Sample exports:', exports.slice(0, 15).join(', '));

  // Generate re-export file
  const reexportFile = `// Auto-generated re-exports for pg-mem
export { ${exports.join(', ')} } from 'pg-mem';
`;
  fs.writeFileSync(path.join(LSP_WORKSPACE, 'pg-mem-exports.ts'), reexportFile, 'utf-8');

  return exports;
}

class LspClient {
  constructor() {
    this.messageId = 0;
    this.pendingRequests = new Map();
    this.buffer = '';
    this.contentLength = -1;
  }

  start() {
    this.process = spawn(LSP_SERVER, ['--stdio'], {
      cwd: LSP_WORKSPACE,
      env: { ...process.env, NODE_PATH: path.join(WORKSPACE, 'node_modules') },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.process.stdout.on('data', (data) => this.handleData(data.toString('utf-8')));
    this.process.stderr.on('data', (data) => console.error('[LSP stderr]', data.toString('utf-8')));
  }

  handleData(data) {
    this.buffer += data;
    while (true) {
      if (this.contentLength === -1) {
        const headerEnd = this.buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) break;
        const match = this.buffer.slice(0, headerEnd).match(/Content-Length: (\d+)/);
        if (match) this.contentLength = parseInt(match[1], 10);
        this.buffer = this.buffer.slice(headerEnd + 4);
      }
      if (this.contentLength > 0 && this.buffer.length >= this.contentLength) {
        const content = this.buffer.slice(0, this.contentLength);
        this.buffer = this.buffer.slice(this.contentLength);
        this.contentLength = -1;
        try {
          const message = JSON.parse(content);
          if (message.id !== undefined && this.pendingRequests.has(message.id)) {
            const { resolve } = this.pendingRequests.get(message.id);
            this.pendingRequests.delete(message.id);
            resolve(message.result);
          }
        } catch (e) {}
      } else break;
    }
  }

  sendRequest(method, params) {
    return new Promise((resolve) => {
      const id = ++this.messageId;
      this.pendingRequests.set(id, { resolve });
      const content = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      this.process.stdin.write(`Content-Length: ${Buffer.byteLength(content)}\r\n\r\n${content}`);
    });
  }

  sendNotification(method, params) {
    const content = JSON.stringify({ jsonrpc: '2.0', method, params });
    this.process.stdin.write(`Content-Length: ${Buffer.byteLength(content)}\r\n\r\n${content}`);
  }
}

async function main() {
  const allExports = setupLspWorkspace();

  const client = new LspClient();
  client.start();

  console.log('\nInitializing LSP...');
  await client.sendRequest('initialize', {
    processId: process.pid,
    rootUri: `file://${LSP_WORKSPACE}`,
    capabilities: { workspace: { symbol: { dynamicRegistration: false } } },
    workspaceFolders: [{ uri: `file://${LSP_WORKSPACE}`, name: 'workspace' }],
  });
  client.sendNotification('initialized', {});

  const reexportPath = path.join(LSP_WORKSPACE, 'pg-mem-exports.ts');
  const content = fs.readFileSync(reexportPath, 'utf-8');
  client.sendNotification('textDocument/didOpen', {
    textDocument: { uri: `file://${reexportPath}`, languageId: 'typescript', version: 1, text: content },
  });

  console.log('Waiting for TypeScript to process...');
  await new Promise(r => setTimeout(r, 2000));

  // Test workspace/symbol with various queries
  console.log('\n--- workspace/symbol queries ---');
  for (const query of ['newDb', 'IMemoryDb', 'ISchema', 'DataType', 'QueryResult', 'IBackup']) {
    const result = await client.sendRequest('workspace/symbol', { query });
    console.log(`"${query}": ${result?.length || 0} symbols`);
  }

  // Try empty query to see total
  const all = await client.sendRequest('workspace/symbol', { query: '' });
  console.log(`\nEmpty query: ${all?.length || 0} total symbols found via workspace/symbol`);

  await client.sendRequest('shutdown');
  client.sendNotification('exit');
  process.exit(0);
}

main().catch(console.error);
