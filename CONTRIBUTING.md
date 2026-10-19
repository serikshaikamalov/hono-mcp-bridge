# Contributing

```sh
bun install
bun test          # unit tests + a real MCP SDK client against the bridge
bun run typecheck
bun run example   # tours API on http://localhost:3000/mcp
```

Keep the runtime dependency-free (only peer deps) and add a test for every behaviour change.
