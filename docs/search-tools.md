# searchTools Reference

`prodisco.searchTools` is a unified interface for discovering **methods**, **types**, and **functions** across **startup-configured TypeScript libraries**. Use it to find the correct APIs (names, parameters, return types) **before** writing code for `prodisco.runSandbox`.

> Current limitation: ProDisco indexes APIs from TypeScript declaration files (`.d.ts`). Libraries must ship typings (or have typings installed). Pure JavaScript-only packages without typings are not supported for indexing yet.

---

## Quick Reference

### Input parameters

- **`methodName`**: string (optional) — search term (method/type/function name)
- **`documentType`**: enum (optional, default: `all`)
  - `method` — class methods and instance APIs extracted from `.d.ts`
  - `type` — classes/interfaces/enums/types extracted from `.d.ts`
  - `function` — standalone exported functions
  - `script` — cached scripts previously run in the sandbox
  - `all` — search across everything above
- **`library`**: enum (optional, default: `all`)
  - Values come from your startup config (plus `all`). Example: `pg-mem`, `simple-statistics`, `@prodisco/prometheus-client`
- **`category`**: string (optional)
  - A lightweight grouping derived during indexing (e.g. `list` / `create` / `delete` for methods, or `class` / `interface` for types). Exact values depend on the libraries you configured.
- **`exclude`**: object (optional)
  - `exclude.categories`: string[]
  - `exclude.libraries`: string[]
- **`limit`**: number (optional, default: 10, max: 50)
- **`offset`**: number (optional, default: 0)

### Typical workflow

1. Call `prodisco.searchTools` to find the API you need.
2. Use `prodisco.runSandbox` to execute code using **only** the allowlisted libraries from your config (`require()` is restricted to the same set).
3. Successful scripts are cached; you can later search them with `documentType: "script"` and re-run by name via `runSandbox({ cached: "..." })`.

---

## Examples

```ts
// Search broadly by name (methods/types/functions/scripts)
// Replace the placeholders with terms relevant to your configured libraries.
{ methodName: "<search-term>" }

// Constrain to a specific configured library (replace with one from your config)
{ methodName: "<search-term>", library: "<library>" }

// Only TypeScript types (classes/interfaces/enums/type aliases)
{ methodName: "<type-or-class-name>", documentType: "type" }

// Only functions
{ documentType: "function", methodName: "<function-name>" }

// Only cached scripts
{ documentType: "script", methodName: "<keyword>" }
```

---

## Response shape

`prodisco.searchTools` returns:

- **`summary`**: a human-readable summary of results
- **`results[]`**: structured matches (method/type/function/script), including signatures and type information when available
- **`facets`**: counts by documentType/library/category
- **`pagination`**: `offset`, `limit`, `hasMore`
- **`usage`**: short “what to do next” help, including the current **allowed imports** list
- **`paths.scriptsDirectory`**: where cached scripts live (informational)

---

## Configuration notes

The libraries visible in `library` filters and the sandbox `require()` allowlist come from the same startup configuration:

- CLI: `--config <path>`
- Env: `PRODISCO_CONFIG_PATH`

See [examples/README.md](../examples/README.md) for complete, config-driven examples (including `pg-mem` and `@kubernetes/client-node`).


