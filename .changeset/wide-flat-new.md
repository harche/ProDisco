---
"@prodisco/sandbox-server": patch
"@prodisco/mcp-server": patch
---

Prevent environment variable leaks from sandbox execution. Sandbox code now gets a frozen empty process.env instead of the host's real environment variables. Added defense-in-depth output filter that blocks execution if sensitive env var values appear in output.
