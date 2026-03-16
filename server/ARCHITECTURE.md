# MCP Server Architecture

## Current Architecture

The MCP stack is now split into two clear roles:

1. `server/` is the transport and session layer.
2. The Chrome extension is the browser execution layer.

The MCP server should not run its own browser-agent loop. It should forward
browser tasks to the extension, wait for streamed updates, and expose those
results back to MCP clients.

## Runtime Flow

```text
MCP client
  -> stdio MCP protocol
MCP server (`server/src/index.ts`)
  -> WebSocket relay (`server/src/relay/server.ts`)
Chrome extension bridge (`src/background/modules/mcp-bridge.js`)
  -> extension MCP handlers (`src/background/service-worker.js`)
  -> extension `runAgentLoop(...)`
  -> browser tools / Chrome APIs
```

## Source Of Truth

The extension path is the source of truth for browser execution:

- Task start: [src/background/service-worker.js](/Users/apple/Dev/llm-in-chrome/src/background/service-worker.js#L1190)
- Follow-up messages: [src/background/service-worker.js](/Users/apple/Dev/llm-in-chrome/src/background/service-worker.js#L1431)
- Screenshot handling: [src/background/service-worker.js](/Users/apple/Dev/llm-in-chrome/src/background/service-worker.js#L1621)
- Main browser loop: [src/background/service-worker.js](/Users/apple/Dev/llm-in-chrome/src/background/service-worker.js#L498)

The MCP server entrypoint forwards to that path:

- MCP tools: [server/src/index.ts](/Users/apple/Dev/llm-in-chrome/server/src/index.ts)
- Relay client: [server/src/ipc/websocket-client.ts](/Users/apple/Dev/llm-in-chrome/server/src/ipc/websocket-client.ts)

## Components

### MCP server

Responsibilities:

- expose `browser_start`, `browser_message`, `browser_status`, `browser_stop`, `browser_screenshot`
- maintain lightweight session metadata for blocking MCP calls
- connect to the relay and wait for terminal task events
- enforce local concurrency and timeout limits

It should not:

- perform browser reasoning
- run a separate browser-agent LLM loop
- define a second copy of browser tools

### Relay

Responsibilities:

- accept WebSocket connections from extension, MCP server, and CLI
- queue messages briefly when the extension service worker is asleep
- route messages between producers and consumers

Current implementation notes:

- tagged task traffic can now be routed back to the originating MCP/CLI client
- untagged extension messages still broadcast to all consumers

See: [server/src/relay/server.ts](/Users/apple/Dev/llm-in-chrome/server/src/relay/server.ts)

### Extension bridge

Responsibilities:

- translate `mcp_*` transport messages into extension actions
- forward task results, screenshots, and status updates back over the relay
- preserve session ownership across MCP follow-up, stop, and screenshot commands

See: [src/background/modules/mcp-bridge.js](/Users/apple/Dev/llm-in-chrome/src/background/modules/mcp-bridge.js)

### Extension service worker

Responsibilities:

- own MCP task state
- create isolated browser windows per task
- run the real browser agent
- manage follow-up messages, task cancellation, screenshots, and cleanup

See: [src/background/service-worker.js](/Users/apple/Dev/llm-in-chrome/src/background/service-worker.js)

## Legacy / Cleanup Targets

These files represent legacy or partially migrated architecture and should not
be treated as the target design:

- utility/legacy references to native-host transport in [server/src/ipc/native-host.ts](/Users/apple/Dev/llm-in-chrome/server/src/ipc/native-host.ts)
- utility/legacy references to native-host transport in [server/src/ipc/index.ts](/Users/apple/Dev/llm-in-chrome/server/src/ipc/index.ts)

## Known Gaps

The main architectural duplication is gone, but a few gaps still remain:

- untagged extension relay messages still broadcast to all consumers
- native-host utility transport still exists alongside the relay path
- some important workflows are not fully live-validated yet
  - sidepanel UI task in parallel with MCP
  - popup-heavy / OAuth / multi-tab flows
  - long-idle TTL cleanup

See [MCP_STATUS.md](/Users/apple/Dev/llm-in-chrome/docs/internal/MCP_STATUS.md)
for the current validation summary.
