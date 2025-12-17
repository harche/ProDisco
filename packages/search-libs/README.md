# @prodisco/search-libs

A generic library indexing + search solution using [Orama](https://orama.com/). Extract types, methods, and functions from TypeScript libraries (via `.d.ts`) and **ESM JavaScript libraries** (best-effort), index TypeScript scripts, and provide unified structured search for AI agents.

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [API Reference](#api-reference)
- [Document Types](#document-types)
- [Architecture](#architecture)
- [How Library Indexing Works](#how-library-indexing-works-typescript--javascript)
- [Extending the Schema](#extending-the-schema)
- [License](#license)

## Features

- **Generic Library Extraction**: Extract types (classes, interfaces, enums, type-aliases) and methods/functions from npm packages using TypeScript AST parsing (TypeScript `.d.ts` + ESM JavaScript fallback)
- **Script Indexing**: Index TypeScript scripts with automatic metadata extraction (description, keywords, API references)
- **Unified Search**: Search across types, methods, functions, and scripts with structured queries and structured output
- **Extensible Schema**: Base Orama schema with support for custom extensions
- **AI-Optimized**: Structured output designed for AI code generation agents

## Installation

```bash
npm install @prodisco/search-libs
```

## Quick Start

```typescript
import { LibraryIndexer } from '@prodisco/search-libs';

// Create indexer with packages to extract
const indexer = new LibraryIndexer({
  packages: [
    { name: '@kubernetes/client-node' },
    { name: '@prodisco/prometheus-client' },
    { name: 'simple-statistics' },
  ],
});

// Initialize - extracts and indexes all packages
await indexer.initialize();

// Search across all indexed content
const results = await indexer.search({
  query: 'Pod',
  documentType: 'type',
  limit: 10,
});

console.log(results.results[0]);
// {
//   id: 'type:@kubernetes/client-node:V1Pod',
//   documentType: 'type',
//   name: 'V1Pod',
//   library: '@kubernetes/client-node',
//   category: 'interface',
//   description: 'Pod is a collection of containers...',
//   properties: [...],
//   typeKind: 'interface',
// }
```

## API Reference

### LibraryIndexer

The main entry point for indexing and searching.

```typescript
interface LibraryIndexerOptions {
  packages: PackageConfig[];
  basePath?: string;  // Defaults to process.cwd()
}

interface PackageConfig {
  name: string;                    // npm package name
  typeFilter?: RegExp | ((name: string) => boolean);
  methodFilter?: RegExp | ((name: string) => boolean);
}
```

#### Methods

##### `initialize(): Promise<{ indexed: number; errors: ExtractionError[] }>`

Extracts and indexes all configured packages.

##### `search(options: SearchOptions): Promise<SearchResult>`

Search the index with structured queries.

```typescript
interface SearchOptions {
  query?: string;           // Full-text search term
  documentType?: string;    // 'type' | 'method' | 'function' | 'script' | 'all'
  category?: string;        // Filter by category
  library?: string;         // Filter by library
  limit?: number;           // Max results (default: 10)
  offset?: number;          // Pagination offset
}

interface SearchResult {
  results: IndexedDocument[];
  totalMatches: number;
  facets: {
    documentType: Record<string, number>;
    library: Record<string, number>;
    category: Record<string, number>;
  };
  searchTime: number;
}
```

##### `addScript(filePath: string): Promise<void>`

Add a TypeScript script to the index. Automatically parses for:
- Description (from first comment block)
- Keywords (from description)
- Resource types (from filename and content AST)
- API references (from content AST)

##### `addScriptsFromDirectory(dirPath: string): Promise<void>`

Add all TypeScript scripts from a directory.

##### `removeScript(filePath: string): Promise<void>`

Remove a script from the index.

##### `addDocuments(docs: IndexedDocument[]): Promise<void>`

Add custom documents to the index (e.g., from external sources).

##### `shutdown(): Promise<void>`

Clean up resources.

## Document Types

### Type Documents

Extracted from `.d.ts` files (preferred). If no `.d.ts` is found, types/classes can be extracted from ESM JavaScript source (`.js/.mjs`) as a best-effort fallback (parameter/return types default to `any`).

```typescript
{
  id: 'type:@kubernetes/client-node:V1Pod',
  documentType: 'type',
  name: 'V1Pod',
  library: '@kubernetes/client-node',
  category: 'interface',
  description: 'Pod is a collection of containers...',
  properties: [
    { name: 'metadata', type: 'V1ObjectMeta', optional: true },
    { name: 'spec', type: 'V1PodSpec', optional: true },
  ],
  typeKind: 'interface',
  nestedTypes: ['V1ObjectMeta', 'V1PodSpec'],
}
```

### Method Documents

Extracted from class methods:

```typescript
{
  id: 'method:@kubernetes/client-node:CoreV1Api:listNamespacedPod',
  documentType: 'method',
  name: 'listNamespacedPod',
  library: '@kubernetes/client-node',
  category: 'list',
  description: 'List pods in a namespace',
  parameters: [
    { name: 'namespace', type: 'string', optional: false },
  ],
  returnType: 'Promise<V1PodList>',
  signature: 'listNamespacedPod(namespace: string): Promise<V1PodList>',
}
```

### Script Documents

Indexed from TypeScript files:

```typescript
{
  id: 'script:get-pod-logs.ts',
  documentType: 'script',
  name: 'get-pod-logs',
  library: 'CachedScript',
  category: 'script',
  description: 'Retrieves logs from a Kubernetes pod',
  filePath: '/path/to/scripts/get-pod-logs.ts',
  keywords: 'logs pod kubernetes',
}
```

## Architecture

```
search-libs/
├── extractor/           # TypeScript AST extraction
│   ├── type-extractor   # Extract classes, interfaces, enums
│   ├── method-extractor # Extract methods from classes
│   ├── function-extractor # Extract standalone functions
│   └── package-resolver # Find .d.ts files or ESM JS entrypoints in node_modules
├── script/              # Script parsing
│   └── script-parser    # Parse scripts for metadata
├── schema/              # Orama schema
│   ├── base-schema      # Core schema fields
│   └── schema-builder   # Extensibility
└── search/              # Search engine
    ├── search-engine    # Orama wrapper
    ├── query-builder    # Fluent query API
    └── result-formatter # Format for AI consumption
```

## How library indexing works (TypeScript + JavaScript)

This section explains what happens when you call `LibraryIndexer.initialize()` for a package in `node_modules`, and how `search-libs` decides whether to index from **TypeScript declarations** or **JavaScript source**.

### High-level flow

At a high level, indexing a package looks like:

- **Resolve package folder**: `basePath/node_modules/<packageName>/`
- **Decide extraction strategy**:
  - Prefer **TypeScript declarations** (`.d.ts`) when discoverable
  - Otherwise, attempt **ESM JavaScript source fallback** (`.js/.mjs`)
- **Extract documents**:
  - Types (classes/interfaces/enums/type-aliases)
  - Methods (class methods)
  - Functions (standalone functions)
- **Insert into Orama** and expose them via `search()`

### TypeScript packages (declaration-first)

For TypeScript libraries (or JS libraries that ship `.d.ts`), extraction is **declaration-first**:

#### 1) Finding `.d.ts` files

`search-libs` attempts to locate a main `.d.ts` and then scans for additional `.d.ts` files:

- **Main declaration** candidates:
  - `package.json` `"types"` / `"typings"`
  - `package.json` `"exports"["."]["types"]`
  - common fallbacks like `dist/index.d.ts`, `lib/index.d.ts`, `index.d.ts`
- **Additional declarations**:
  - Walks the package’s `types/`, `typings/`, `dist/`, `lib/`, and `src/` trees (bounded depth)
  - Skips common test/internal files (e.g. `*.test.*`, `*.spec.*`, names containing `__`)

#### 2) Understanding what’s “public”

Some packages have internal class names that are re-exported or aliased at the entrypoint. To reduce noise for method indexing, `search-libs` parses the package’s **main `.d.ts`** and builds:

- **Public export set**: the names users can import
- **Alias map**: internal names → public names (e.g. `ObjectCoreV1Api` → `CoreV1Api`)

It follows `export * from './x'` chains (relative only) to build a more complete public view.

#### 3) Extracting types / methods / functions

Once `.d.ts` files are discovered, each file is parsed with the TypeScript compiler AST and we extract:

- **Types**: `class`, `interface`, `enum`, and simple `type` aliases
  - Properties are captured as text (type strings from `.d.ts`)
  - Nested type references are detected for better searchability
- **Methods**:
  - Extracted from class declarations
  - If a public export set exists, methods are indexed only for **publicly exported classes**
  - Aliases are applied so class names match what users import
- **Functions**:
  - Extracts function declarations and exported function-valued variables

Notes:

- Types are extracted from all discovered `.d.ts` files (often includes internal-but-useful helper types).
- `LibraryIndexer` can expand complex parameter/return types by looking up extracted types and embedding a compact definition in method docs.

### JavaScript packages (ESM source fallback)

If **no `.d.ts` files are discoverable**, `search-libs` attempts to index the package’s **ESM JavaScript source**.

#### 1) Finding an ESM entry file

Entry resolution is based on `package.json` and common build layouts:

- Prefer `exports['.']` with `"import"` (then `"default"`)
- Then `"module"`
- Then `"main"` **only when** the package has `"type": "module"` (for `.js`)
- Plus common fallbacks (`dist/index.js`, `lib/index.js`, `index.js`, and `.mjs` variants)

Only `.js` (ESM via `"type":"module"`) and `.mjs` are considered. CommonJS (`.cjs`) is intentionally ignored.

#### 2) Computing the public surface (exports)

JavaScript libraries often re-export from multiple files. To avoid indexing internal helpers, `search-libs` first computes the **public export surface** by traversing the entry’s static export graph (relative only).

Supported patterns include:

- `export { a, b as c } from './x.js'`
- `export * from './x.js'` (does not re-export `default`)
- `export { a, b as c }` (local exports)
- import + re-export:

```js
import { foo as localFoo } from './x.js';
export { localFoo as foo };
```

- direct exports:
  - `export function foo() {}`
  - `export class Foo {}`
  - `export const foo = () => {}`
  - `export default <identifier>` (best-effort; indexed under the name `default` when resolvable)

From this traversal, `search-libs` builds:

- a **per-file allowlist** of declaration names that are actually part of the public API
- a **per-file alias map** for renamed exports (`internalFn` → `publicFn`)

Only relative (`./...`) re-exports are followed. Non-relative re-exports (from dependencies) are ignored.

#### 3) Extracting from JavaScript source

For each JS module that contributes exports, `search-libs` runs the same AST extractors as TypeScript, but applies the allowlist/aliases so only public symbols are indexed:

- **Exported functions**: indexed with parameter/return types defaulting to `any`
- **Exported classes**: indexed as type documents, and their methods are indexed as method documents
- **Descriptions**: pulled from JSDoc comment blocks when present (e.g. `/** ... */`)

### Filters and tuning

You can control noise and focus via `PackageConfig`:

- `typeFilter`: include only matching type names
- `methodFilter`: include only matching method/function names
- `classFilter`: include methods only from matching class names (applies to the public/aliased class name)

### Limitations (by design)

- **CommonJS** (`module.exports`, `exports.*`) is not supported by the JS fallback.
- **Dynamic exports** are not supported (computed exports, runtime mutation, etc.).
- **Re-exports from dependencies** (non-relative specifiers like `'lodash'`) are ignored by the JS fallback.
- JS fallback is **best-effort**: it parses syntax but does not run a type checker; parameter/return types default to `any`.

### Tips for best results

- If you can, ship `.d.ts` (or add `@types/<pkg>`): declaration-first indexing produces richer type signatures.
- For JS-only ESM libraries:
  - Prefer **static named exports** over dynamic export patterns
  - Add **JSDoc descriptions** on exported functions/classes/methods to improve search quality
  - Keep exports **shallow and explicit** at the entrypoint for a clearer public surface

## Extending the Schema

For domain-specific fields, use the schema builder:

```typescript
import { buildSchema, SearchEngine } from '@prodisco/search-libs';

const customSchema = buildSchema({
  extensions: {
    customField: 'string',
    customEnum: 'enum',
  },
});

const engine = new SearchEngine({ schema: customSchema });
```

## License

MIT
