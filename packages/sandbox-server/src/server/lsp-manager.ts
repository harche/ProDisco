/**
 * LSP Manager
 *
 * Manages the TypeScript language server lifecycle and provides
 * LSP operations for code intelligence.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LspProtocol } from './lsp-protocol.js';

// ES module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import type {
  InitializeParams,
  InitializeResult,
  SymbolInformation,
  Hover,
  Location,
  DocumentSymbol,
  Position,
  WorkspaceSymbolParams,
  HoverParams,
  DefinitionParams,
  ReferenceParams,
  DocumentSymbolParams,
  DidOpenTextDocumentParams,
} from 'vscode-languageserver-protocol';

/**
 * Configuration for LspManager
 */
export interface LspManagerConfig {
  /** Base path containing node_modules */
  basePath: string;
  /** Directory containing cached scripts */
  scriptsCacheDir?: string;
  /** Request timeout in milliseconds */
  requestTimeout?: number;
  /** Log level */
  logLevel?: 'error' | 'warn' | 'info' | 'debug';
}

/**
 * Symbol kind enum matching LSP specification
 */
export const SymbolKind = {
  File: 1,
  Module: 2,
  Namespace: 3,
  Package: 4,
  Class: 5,
  Method: 6,
  Property: 7,
  Field: 8,
  Constructor: 9,
  Enum: 10,
  Interface: 11,
  Function: 12,
  Variable: 13,
  Constant: 14,
  String: 15,
  Number: 16,
  Boolean: 17,
  Array: 18,
  Object: 19,
  Key: 20,
  Null: 21,
  EnumMember: 22,
  Struct: 23,
  Event: 24,
  Operator: 25,
  TypeParameter: 26,
} as const;

/**
 * Extract library name from a file path
 */
function extractLibraryFromPath(filePath: string): string {
  // Look for node_modules in the path
  const nodeModulesIndex = filePath.indexOf('node_modules');
  if (nodeModulesIndex === -1) {
    return 'local';
  }

  const afterNodeModules = filePath.slice(nodeModulesIndex + 'node_modules/'.length);

  // Handle scoped packages (@org/package)
  if (afterNodeModules.startsWith('@')) {
    const parts = afterNodeModules.split('/');
    if (parts.length >= 2) {
      return `${parts[0]}/${parts[1]}`;
    }
  }

  // Regular package
  const firstSlash = afterNodeModules.indexOf('/');
  if (firstSlash !== -1) {
    return afterNodeModules.slice(0, firstSlash);
  }

  return afterNodeModules;
}

/**
 * Convert a file path to a file URI
 */
function pathToUri(filePath: string): string {
  // Ensure absolute path
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
  return `file://${absolutePath}`;
}

/**
 * Convert a file URI to a file path
 */
function uriToPath(uri: string): string {
  if (uri.startsWith('file://')) {
    return uri.slice(7);
  }
  return uri;
}

/**
 * Resolve a module path to actual file path
 */
function resolveModulePath(basePath: string, modulePath: string): string | null {
  const resolved = path.resolve(basePath, modulePath);

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

/**
 * Find the types entry point for a library by reading package.json
 */
function findTypesEntryPoint(libPath: string): string | null {
  const packageJsonPath = path.join(libPath, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    return null;
  }

  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));

    // Check for types/typings field (can be relative path)
    const typesField = packageJson.types || packageJson.typings;
    if (typesField) {
      const typesPath = path.join(libPath, typesField);
      if (fs.existsSync(typesPath)) {
        return typesPath;
      }
    }

    // Fall back to index.d.ts in root
    const indexPath = path.join(libPath, 'index.d.ts');
    if (fs.existsSync(indexPath)) {
      return indexPath;
    }

    // Try dist/index.d.ts
    const distIndexPath = path.join(libPath, 'dist', 'index.d.ts');
    if (fs.existsSync(distIndexPath)) {
      return distIndexPath;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Recursively extract all exports from a library by following export chains
 */
function getAllLibraryExports(libPath: string): string[] {
  const allExports = new Set<string>();
  const visited = new Set<string>();

  function processFile(filePath: string | null): void {
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
        // Handle 'name as alias' - take the alias as the exported name
        const asMatch = trimmed.match(/(\w+)\s+as\s+(\w+)/);
        return asMatch ? asMatch[2] : trimmed.split(/\s+/)[0];
      });
      names.forEach(n => n && allExports.add(n));
      // Don't follow these paths - we already have the named exports
    }

    // Only follow 'export * from' patterns - these re-export everything from the target
    const starExports = content.matchAll(/export\s+\*\s+from\s+['"]([^'"]+)['"]/g);
    for (const match of starExports) {
      const refPath = match[1];
      if (refPath.startsWith('.')) {
        const resolvedPath = resolveModulePath(path.dirname(filePath), refPath);
        if (resolvedPath) {
          processFile(resolvedPath);
        }
      }
    }
  }

  // Find the types entry point from package.json
  const entryPoint = findTypesEntryPoint(libPath);
  if (entryPoint) {
    processFile(entryPoint);
  }

  // Filter out reserved keywords and invalid identifiers
  const reservedKeywords = new Set([
    'type', 'interface', 'class', 'function', 'const', 'let', 'var', 'enum',
    'export', 'import', 'default', 'from', 'as', 'if', 'else', 'for', 'while',
    'do', 'switch', 'case', 'break', 'continue', 'return', 'throw', 'try',
    'catch', 'finally', 'new', 'delete', 'typeof', 'instanceof', 'void',
    'this', 'super', 'null', 'undefined', 'true', 'false', 'in', 'of',
  ]);

  return [...allExports].filter(name =>
    !reservedKeywords.has(name) && /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name)
  );
}

/**
 * LspManager manages the TypeScript language server and provides LSP operations.
 */
export class LspManager {
  private process: ChildProcess | null = null;
  private protocol: LspProtocol;
  private initialized = false;
  private config: LspManagerConfig;
  private workspaceFolder: string;
  private openDocuments = new Set<string>();
  private lspTsconfigPath: string | null = null;
  private lspWorkspaceDir: string | null = null;

  // Promise that resolves when LSP is ready
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;

  constructor(config: LspManagerConfig) {
    this.config = config;
    this.workspaceFolder = config.basePath;
    this.protocol = new LspProtocol({
      requestTimeout: config.requestTimeout ?? 30000,
      onNotification: this.handleNotification.bind(this),
      onError: this.handleError.bind(this),
    });
  }

  /**
   * Start the language server
   */
  async start(): Promise<void> {
    if (this.process) {
      throw new Error('LSP server already running');
    }

    // Set up ready promise before starting
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    this.log('info', `Starting TypeScript language server for workspace: ${this.workspaceFolder}`);

    try {
      // Create a temporary tsconfig.json if needed
      await this.ensureWorkspaceConfig();

      // Find and log the server path for debugging
      const serverPath = this.findServerPath();
      this.log('info', `Using typescript-language-server at: ${serverPath}`);

      // Use LSP workspace if available (has our custom tsconfig)
      const effectiveWorkspace = this.lspWorkspaceDir ?? this.workspaceFolder;
      this.log('info', `LSP workspace directory: ${effectiveWorkspace}`);

      // Spawn the language server
      this.process = spawn(serverPath, ['--stdio'], {
        cwd: effectiveWorkspace,
        env: {
          ...process.env,
          // Ensure TypeScript can be found
          NODE_PATH: path.join(this.workspaceFolder, 'node_modules'),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.process.on('error', (error) => {
        this.log('error', `LSP process error: ${error.message}`);
      });

      this.process.on('exit', (code, signal) => {
        this.log('info', `LSP process exited (code: ${code}, signal: ${signal})`);
        this.process = null;
        this.initialized = false;
      });

      // Attach protocol handler
      this.protocol.attach(this.process);

      // Initialize the language server
      await this.initialize();

      // Open a bootstrap file to trigger project loading
      // TypeScript server needs at least one open file to have a "project"
      await this.openBootstrapFile();

      this.log('info', 'TypeScript language server initialized');

      // Resolve the ready promise
      if (this.readyResolve) {
        this.readyResolve();
      }
    } catch (error) {
      // Reject the ready promise on error
      if (this.readyReject) {
        this.readyReject(error instanceof Error ? error : new Error(String(error)));
      }
      throw error;
    }
  }

  /**
   * Open bootstrap/re-export files to make library symbols searchable via workspace/symbol.
   * TypeScript LSP's workspace/symbol only searches project source files, not node_modules.
   * By generating explicit re-exports like `export { Symbol1, Symbol2 } from 'library'`,
   * we make all library symbols appear in the project and thus searchable.
   */
  private async openBootstrapFile(): Promise<void> {
    if (!this.lspWorkspaceDir) {
      this.log('warn', 'LSP workspace directory not set, skipping bootstrap');
      return;
    }

    // Get configured libraries from environment
    const allowedModulesRaw = process.env.SANDBOX_ALLOWED_MODULES;
    let libraryNames: string[] = [];
    if (allowedModulesRaw) {
      try {
        libraryNames = JSON.parse(allowedModulesRaw);
      } catch {
        this.log('warn', 'Failed to parse SANDBOX_ALLOWED_MODULES');
      }
    }

    if (libraryNames.length === 0) {
      this.log('warn', 'No libraries configured, skipping bootstrap');
      return;
    }

    this.log('info', `Generating re-export files for libraries: ${libraryNames.join(', ')}`);

    // Generate re-export file for each library
    for (const libName of libraryNames) {
      const libPath = path.join(this.workspaceFolder, 'node_modules', libName);

      if (!fs.existsSync(libPath)) {
        this.log('warn', `Library not found: ${libPath}`);
        continue;
      }

      // Extract all exports from the library
      const exports = getAllLibraryExports(libPath);
      this.log('info', `Found ${exports.length} exports from ${libName}`);

      if (exports.length === 0) {
        this.log('warn', `No exports found for ${libName}`);
        continue;
      }

      // Generate a safe filename from library name (replace @ and / with -)
      const safeLibName = libName.replace(/[@/]/g, '-');
      const reexportPath = path.join(this.lspWorkspaceDir, `${safeLibName}-exports.ts`);

      // Generate re-export file content
      const reexportContent = `// Auto-generated re-exports for ${libName}
// This makes all library symbols searchable via workspace/symbol
export { ${exports.join(', ')} } from '${libName}';
`;

      this.log('info', `Writing re-export file: ${reexportPath}`);
      fs.writeFileSync(reexportPath, reexportContent, 'utf-8');

      // Open the re-export file to make symbols searchable
      await this.ensureDocumentOpen(reexportPath);
    }

    // Give TypeScript time to parse and index
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  /**
   * Stop the language server
   */
  async stop(): Promise<void> {
    if (!this.process) {
      return;
    }

    this.log('info', 'Stopping TypeScript language server');

    try {
      // Send shutdown request
      await this.protocol.sendRequest('shutdown');

      // Send exit notification
      this.protocol.sendNotification('exit');
    } catch (error) {
      this.log('warn', `Error during LSP shutdown: ${error}`);
    }

    // Detach protocol
    this.protocol.detach();

    // Kill process if still running
    if (this.process && !this.process.killed) {
      this.process.kill('SIGTERM');
    }

    this.process = null;
    this.initialized = false;
    this.openDocuments.clear();
  }

  /**
   * Check if the language server is running
   */
  isRunning(): boolean {
    return this.process !== null && this.initialized;
  }

  /**
   * Wait for the LSP server to be ready.
   * Returns immediately if already ready, otherwise waits for initialization.
   */
  async waitForReady(): Promise<void> {
    if (this.isRunning()) {
      return;
    }
    if (this.readyPromise) {
      return this.readyPromise;
    }
    throw new Error('LSP server not started');
  }

  /**
   * Search for symbols by name across the workspace.
   * Uses native LSP workspace/symbol - works because we've opened all library files.
   */
  async workspaceSymbol(query: string, limit: number = 50): Promise<SymbolInformation[]> {
    this.ensureRunning();

    const params: WorkspaceSymbolParams = { query };

    const result = await this.protocol.sendRequest<SymbolInformation[] | null>(
      'workspace/symbol',
      params
    );

    if (!result) {
      this.log('info', `Symbol search for "${query}": no results`);
      return [];
    }

    this.log('info', `Symbol search for "${query}": found ${result.length} matches`);

    // Apply limit if needed
    return limit ? result.slice(0, limit) : result;
  }

  /**
   * Get hover information at a position
   */
  async hover(filePath: string, line: number, character: number): Promise<Hover | null> {
    this.ensureRunning();

    const uri = pathToUri(filePath);

    // Ensure document is open
    await this.ensureDocumentOpen(filePath);

    const params: HoverParams = {
      textDocument: { uri },
      position: { line: line - 1, character }, // Convert to 0-based line
    };

    const result = await this.protocol.sendRequest<Hover | null>('textDocument/hover', params);
    return result;
  }

  /**
   * Find definition of symbol at position
   */
  async goToDefinition(filePath: string, line: number, character: number): Promise<Location[]> {
    this.ensureRunning();

    const uri = pathToUri(filePath);

    // Ensure document is open
    await this.ensureDocumentOpen(filePath);

    const params: DefinitionParams = {
      textDocument: { uri },
      position: { line: line - 1, character }, // Convert to 0-based line
    };

    // TypeScript LSP can return Location, Location[], LocationLink, or LocationLink[]
    const result = await this.protocol.sendRequest<unknown>('textDocument/definition', params);

    if (!result) {
      return [];
    }

    // Normalize to array
    const items = Array.isArray(result) ? result : [result];

    // Convert to Location[], handling both Location and LocationLink formats
    return items.map((item: unknown): Location => {
      const obj = item as Record<string, unknown>;

      // LocationLink has targetUri and targetRange
      if ('targetUri' in obj && 'targetRange' in obj) {
        return {
          uri: obj.targetUri as string,
          range: obj.targetRange as Location['range'],
        };
      }

      // Regular Location has uri and range
      return item as Location;
    }).filter((loc): loc is Location => loc.uri !== undefined && loc.range !== undefined);
  }

  /**
   * Find all references to symbol at position
   */
  async findReferences(
    filePath: string,
    line: number,
    character: number,
    includeDeclaration: boolean = true
  ): Promise<Location[]> {
    this.ensureRunning();

    const uri = pathToUri(filePath);

    // Ensure document is open
    await this.ensureDocumentOpen(filePath);

    const params: ReferenceParams = {
      textDocument: { uri },
      position: { line: line - 1, character }, // Convert to 0-based line
      context: { includeDeclaration },
    };

    const result = await this.protocol.sendRequest<Location[] | null>('textDocument/references', params);
    return result ?? [];
  }

  /**
   * Get all symbols in a document
   */
  async documentSymbol(filePath: string): Promise<DocumentSymbol[]> {
    this.ensureRunning();

    const uri = pathToUri(filePath);

    // Ensure document is open
    await this.ensureDocumentOpen(filePath);

    const params: DocumentSymbolParams = {
      textDocument: { uri },
    };

    const result = await this.protocol.sendRequest<DocumentSymbol[] | SymbolInformation[] | null>(
      'textDocument/documentSymbol',
      params
    );

    if (!result) {
      return [];
    }

    // Handle both DocumentSymbol[] and SymbolInformation[] responses
    if (result.length > 0 && 'range' in result[0] && 'selectionRange' in result[0]) {
      return result as DocumentSymbol[];
    }

    // Convert SymbolInformation to DocumentSymbol
    return (result as SymbolInformation[]).map((info) => ({
      name: info.name,
      kind: info.kind,
      detail: '',
      range: info.location.range,
      selectionRange: info.location.range,
      children: [],
    }));
  }

  /**
   * Get the library name from a file path
   */
  getLibraryFromPath(filePath: string): string {
    return extractLibraryFromPath(filePath);
  }

  /**
   * Find the typescript-language-server binary
   */
  private findServerPath(): string {
    const binaryName = 'typescript-language-server';

    // Try to find in workspace node_modules
    const localPath = path.join(this.workspaceFolder, 'node_modules', '.bin', binaryName);
    if (fs.existsSync(localPath)) {
      return localPath;
    }

    // Try package's own node_modules (sandbox-server/node_modules)
    const packagePath = path.join(__dirname, '..', '..', 'node_modules', '.bin', binaryName);
    if (fs.existsSync(packagePath)) {
      return packagePath;
    }

    // Try monorepo root node_modules (hoisted dependencies in npm workspaces)
    // __dirname is dist/server/, so go up to packages/sandbox-server, then to prodisco root
    const monorepoPath = path.join(__dirname, '..', '..', '..', '..', 'node_modules', '.bin', binaryName);
    if (fs.existsSync(monorepoPath)) {
      return monorepoPath;
    }

    // Fall back to global (will be found via PATH)
    return binaryName;
  }

  /**
   * Ensure workspace has a tsconfig for LSP.
   * Creates a dedicated .prodisco-lsp/ directory with tsconfig.json that includes node_modules types.
   */
  private async ensureWorkspaceConfig(): Promise<void> {
    // Create a dedicated LSP workspace directory
    // Clean up existing directory to remove stale re-export files from previous configs
    const lspWorkspaceDir = path.join(this.workspaceFolder, '.prodisco-lsp');
    if (fs.existsSync(lspWorkspaceDir)) {
      fs.rmSync(lspWorkspaceDir, { recursive: true });
    }
    fs.mkdirSync(lspWorkspaceDir, { recursive: true });

    const tsconfigPath = path.join(lspWorkspaceDir, 'tsconfig.json');

    // Get configured libraries from environment
    const allowedModulesRaw = process.env.SANDBOX_ALLOWED_MODULES;
    let libraryNames: string[] = [];
    if (allowedModulesRaw) {
      try {
        libraryNames = JSON.parse(allowedModulesRaw);
      } catch {
        this.log('warn', 'Failed to parse SANDBOX_ALLOWED_MODULES for tsconfig');
      }
    }

    // Build include paths for each configured library
    const libraryIncludes: string[] = [];
    for (const libName of libraryNames) {
      libraryIncludes.push(`../node_modules/${libName}/**/*.ts`);
      libraryIncludes.push(`../node_modules/${libName}/**/*.d.ts`);
    }

    // Create paths relative to the LSP workspace (which is inside the main workspace)
    const tsconfig = {
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        esModuleInterop: true,
        strict: false,
        skipLibCheck: false,
        noEmit: true,
        allowJs: true,
        checkJs: false,
        // Point to parent's node_modules
        baseUrl: '..',
        paths: {
          '*': ['node_modules/*'],
        },
      },
      include: [
        // Bootstrap file in LSP workspace
        './*.ts',
        // Configured library paths
        ...libraryIncludes,
      ],
      exclude: [],
    };

    // Add scripts cache dir if configured
    if (this.config.scriptsCacheDir) {
      // Scripts cache dir is absolute, make it relative or keep absolute
      tsconfig.include.push(`${this.config.scriptsCacheDir}/**/*.ts`);
    }

    this.log('info', `Writing LSP tsconfig to ${tsconfigPath}`);
    fs.writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2), 'utf-8');

    // Update workspace folder to point to our LSP workspace
    this.lspTsconfigPath = tsconfigPath;
    this.lspWorkspaceDir = lspWorkspaceDir;
  }

  /**
   * Initialize the language server
   */
  private async initialize(): Promise<void> {
    // Use LSP workspace for initialization (contains our tsconfig)
    const effectiveWorkspace = this.lspWorkspaceDir ?? this.workspaceFolder;
    const rootUri = pathToUri(effectiveWorkspace);

    const params: InitializeParams = {
      processId: process.pid,
      rootUri,
      rootPath: this.workspaceFolder,
      capabilities: {
        textDocument: {
          hover: {
            contentFormat: ['markdown', 'plaintext'],
          },
          definition: {
            linkSupport: true,
          },
          references: {},
          documentSymbol: {
            hierarchicalDocumentSymbolSupport: true,
          },
        },
        workspace: {
          symbol: {
            dynamicRegistration: false,
          },
          workspaceFolders: true,
        },
      },
      workspaceFolders: [
        {
          uri: rootUri,
          name: path.basename(effectiveWorkspace),
        },
      ],
      // Pass our custom tsconfig to the language server
      initializationOptions: this.lspTsconfigPath ? {
        preferences: {
          includePackageJsonAutoImports: 'auto',
        },
        tsserver: {
          // Tell tsserver to use our custom tsconfig
          logDirectory: undefined,
          logVerbosity: undefined,
        },
      } : undefined,
    };

    const result = await this.protocol.sendRequest<InitializeResult>('initialize', params);

    this.log('debug', `LSP initialized with capabilities: ${JSON.stringify(result.capabilities)}`);

    // Send initialized notification
    this.protocol.sendNotification('initialized', {});

    this.initialized = true;
  }

  /**
   * Ensure a document is open in the language server
   */
  private async ensureDocumentOpen(filePath: string): Promise<void> {
    const uri = pathToUri(filePath);

    if (this.openDocuments.has(uri)) {
      return;
    }

    // Read the file content
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch (error) {
      throw new Error(`Failed to read file ${filePath}: ${error}`);
    }

    // Determine language ID
    const ext = path.extname(filePath).toLowerCase();
    const languageId = ext === '.ts' || ext === '.tsx' ? 'typescript' : 'javascript';

    // Send didOpen notification
    const params: DidOpenTextDocumentParams = {
      textDocument: {
        uri,
        languageId,
        version: 1,
        text: content,
      },
    };

    this.protocol.sendNotification('textDocument/didOpen', params);
    this.openDocuments.add(uri);
  }

  /**
   * Ensure the server is running
   */
  private ensureRunning(): void {
    if (!this.isRunning()) {
      throw new Error('LSP server is not running');
    }
  }

  /**
   * Handle notifications from the language server
   */
  private handleNotification(method: string, params: unknown): void {
    this.log('debug', `LSP notification: ${method}`);

    // Handle specific notifications as needed
    switch (method) {
      case 'textDocument/publishDiagnostics':
        // We could expose diagnostics if needed
        break;
      case 'window/logMessage':
        const logParams = params as { type: number; message: string };
        this.log('debug', `LSP log: ${logParams.message}`);
        break;
    }
  }

  /**
   * Handle protocol errors
   */
  private handleError(error: Error): void {
    this.log('error', `LSP protocol error: ${error.message}`);
  }

  /**
   * Log a message
   */
  private log(level: 'error' | 'warn' | 'info' | 'debug', message: string): void {
    const logLevel = this.config.logLevel ?? 'info';
    const levels = ['debug', 'info', 'warn', 'error'];
    const currentLevelIndex = levels.indexOf(logLevel);
    const messageLevelIndex = levels.indexOf(level);

    if (messageLevelIndex >= currentLevelIndex) {
      console.log(`[LSP ${level.toUpperCase()}] ${message}`);
    }
  }
}
