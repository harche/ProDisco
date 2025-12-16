# Examples

These examples show how to use ProDisco as a **library-agnostic** MCP server: you configure libraries, search their APIs, and execute code in the sandbox.

This directory includes runnable library config files:

- `prodisco.postgres.yaml` (uses `pg-mem`)
- `prodisco.kubernetes.yaml` (uses `@kubernetes/client-node`)

> Current limitation: ProDisco indexes APIs from TypeScript declaration files (`.d.ts`). Libraries must ship typings (or have typings installed). Pure JavaScript-only packages without typings are not supported for indexing yet.

---

## Example 1: Postgres (local, no external services) with `pg-mem`

This example is intentionally easy to run locally: it uses an in-memory Postgres implementation, so you don’t need Docker or a real database.

### 1) Config

Use: `examples/prodisco.postgres.yaml` (this repo ships it).

### 2) Install / build

Run ProDisco with runtime install:

```bash
node dist/server.js --config examples/prodisco.postgres.yaml --install-missing
```

Or build images with the library baked in:

```bash
npm run docker:build:config -- --config examples/prodisco.postgres.yaml
```

### 3) Discover the API

Call `prodisco.searchTools` with:

- `methodName: "newDb"`
- `library: "pg-mem"`

### 4) Execute in sandbox

Run with `prodisco.runSandbox`:

```ts
const { newDb } = require("pg-mem");

const db = newDb();
db.public.none("create table users(id int primary key, name text);");
db.public.none("insert into users values (1, 'ada'), (2, 'grace');");

const rows = db.public.many("select * from users order by id;");
console.log(JSON.stringify(rows));
```

Expected output:

```json
[{"id":1,"name":"ada"},{"id":2,"name":"grace"}]
```

---

## Example 2: Kubernetes (cluster-backed) with `@kubernetes/client-node`

This example shows how to configure ProDisco to work with a Kubernetes cluster by indexing and allowing the Kubernetes client library.

### 1) Config

Use: `examples/prodisco.kubernetes.yaml` (this repo ships it).

### 2) Install / build

Run ProDisco with runtime install:

```bash
node dist/server.js --config examples/prodisco.kubernetes.yaml --install-missing
```

Or build images with the library baked in:

```bash
npm run docker:build:config -- --config examples/prodisco.kubernetes.yaml
```

### 3) Ensure the sandbox has Kubernetes credentials

- **Local subprocess**: `@kubernetes/client-node` will load credentials from `KUBECONFIG` or `~/.kube/config`.
- **Containers/pods**: mount a kubeconfig into the sandbox container (and set `KUBECONFIG`) or run with in-cluster credentials.

### 4) Discover the API

Call `prodisco.searchTools` with:

- `methodName: "listNamespace"` (or `methodName: "listPod"`)
- `library: "@kubernetes/client-node"`

### 5) Execute in sandbox

Run with `prodisco.runSandbox`:

```ts
const k8s = require("@kubernetes/client-node");

const kc = new k8s.KubeConfig();
kc.loadFromDefault();

const coreApi = kc.makeApiClient(k8s.CoreV1Api);
const res = await coreApi.listNamespace();

const names = (res.body.items || [])
  .map((ns: any) => ns.metadata?.name)
  .filter(Boolean);

console.log(JSON.stringify(names, null, 2));
```


