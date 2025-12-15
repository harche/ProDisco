# @prodisco/search-libs

A generic TypeScript library indexing and search solution using [Orama](https://orama.com/). Extract types, methods, and functions from any TypeScript library, index TypeScript scripts, and provide unified structured search for AI agents.

## Features

- **Generic Library Extraction**: Extract types (classes, interfaces, enums, type-aliases) and methods/functions from any npm package using TypeScript AST parsing
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
    { name: 'prometheus-query' },
    { name: 'mathjs', typeFilter: /^(Matrix|BigNumber)$/ },
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

Extracted from `.d.ts` files:

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
│   └── package-resolver # Find .d.ts files in node_modules
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
