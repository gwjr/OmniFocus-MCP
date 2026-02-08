# Server crash-loops on Claude Desktop (MCP protocol version mismatch)

## Problem

The OmniFocus MCP server crash-loops when used with Claude Desktop. The server starts, responds to `tools/list`, then exits within ~5 seconds — before any tool call is made. Claude Desktop reconnects and the cycle repeats indefinitely.

As a result, Claude Desktop cannot use any tools (query, edit, complete tasks, etc.) and falls back to `dump_database` or gives up entirely.

The same server binary works fine from Claude Code, which keeps the connection alive.

## Evidence from logs

`~/Library/Logs/Claude/mcp-server-omnifocus.log` shows a repeating pattern:

```
Server started and connected successfully
Message from client: {"method":"initialize","params":{"protocolVersion":"2025-06-18",...}}
Message from server: {"protocolVersion":"2024-11-05","capabilities":{"tools":{}},...}
Message from client: {"method":"tools/list",...}
Message from server: {"result":{"tools":[...]}}   ← full tool list returned
Client transport closed
Server transport closed unexpectedly
Server disconnected
```

Cycle repeats every ~5 seconds.

## Likely cause

**MCP protocol version mismatch.** Claude Desktop negotiates `2025-06-18` but the server responds with `2024-11-05`. Desktop may be dropping the connection (or the server may exit) because the protocol versions are incompatible.

The server uses the `@modelcontextprotocol/sdk` package — updating it to a version that supports `2025-06-18` should fix this.

## Steps to reproduce

1. Configure in `~/Library/Application Support/Claude/claude_desktop_config.json`
2. Open Claude Desktop
3. Ask it to query or modify OmniFocus tasks
4. Observe that it can't use query/edit tools; check `~/Library/Logs/Claude/mcp-server-omnifocus.log` for the crash loop

## Environment

- macOS Darwin 24.6.0
- Node: /opt/homebrew/bin/node
- Server: `dist/server.js`
- Claude Desktop client protocol: `2025-06-18`
- Server protocol version: `2024-11-05`

## Fix

Update `@modelcontextprotocol/sdk` to a version supporting protocol `2025-06-18`, rebuild, and test with Claude Desktop.
