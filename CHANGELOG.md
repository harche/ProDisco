# @prodisco/mcp-server

## 0.1.14

### Patch Changes

- [#59](https://github.com/harche/ProDisco/pull/59) [`7e2154a`](https://github.com/harche/ProDisco/commit/7e2154ae72ab0900b829cd42c419d168e7b65a31) Thanks [@harche](https://github.com/harche)! - Prevent environment variable leaks from sandbox execution. Sandbox code now gets a frozen empty process.env instead of the host's real environment variables. Added defense-in-depth output filter that blocks execution if sensitive env var values appear in output.

- Updated dependencies [[`7e2154a`](https://github.com/harche/ProDisco/commit/7e2154ae72ab0900b829cd42c419d168e7b65a31)]:
  - @prodisco/sandbox-server@0.1.6

## 0.1.13

### Patch Changes

- [#54](https://github.com/harche/ProDisco/pull/54) [`fdd99aa`](https://github.com/harche/ProDisco/commit/fdd99aa6a796d5538999e8a955b4bde469367aa9) Thanks [@harche](https://github.com/harche)! - Re-create reaped sandboxes transparently on getClient instead of throwing an error
