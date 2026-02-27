# @prodisco/sandbox-server

## 0.1.6

### Patch Changes

- [#59](https://github.com/harche/ProDisco/pull/59) [`7e2154a`](https://github.com/harche/ProDisco/commit/7e2154ae72ab0900b829cd42c419d168e7b65a31) Thanks [@harche](https://github.com/harche)! - Prevent environment variable leaks from sandbox execution. Sandbox code now gets a frozen empty process.env instead of the host's real environment variables. Added defense-in-depth output filter that blocks execution if sensitive env var values appear in output.

## 0.1.5

### Patch Changes

- [#51](https://github.com/harche/ProDisco/pull/51) [`10ba8fe`](https://github.com/harche/ProDisco/commit/10ba8fea1d62bcc5287f6c0a71c559b14725ff18) Thanks [@harche](https://github.com/harche)! - Rename main package from @prodisco/k8s-mcp to @prodisco/mcp-server

- Updated dependencies [[`10ba8fe`](https://github.com/harche/ProDisco/commit/10ba8fea1d62bcc5287f6c0a71c559b14725ff18)]:
  - @prodisco/loki-client@0.1.3
  - @prodisco/prometheus-client@0.1.3

## 0.1.4

### Patch Changes

- [`6a52cc5`](https://github.com/harche/ProDisco/commit/6a52cc56624bb21c9d5fab4e26143a45def2fafb) Thanks [@harche](https://github.com/harche)! - Publish latest changes to npm

- Updated dependencies [[`6a52cc5`](https://github.com/harche/ProDisco/commit/6a52cc56624bb21c9d5fab4e26143a45def2fafb)]:
  - @prodisco/loki-client@0.1.2
  - @prodisco/prometheus-client@0.1.2
