# MCP Status

This is the single internal note for the current MCP cleanup status.

## Current Model

- `server/` is the transport and session layer
- the Chrome extension is the browser execution layer
- relay transport is the supported MCP task path

There is no longer a separate server-side browser-agent loop in source.

## Cleanup Completed

- removed the duplicate MCP server agent path
- removed the fake native-host MCP task fallback
- fixed relay request correlation with `requestId`
- scoped tagged task traffic back to the originating MCP/CLI client
- fixed CLI session handling for `message`, `stop`, and `screenshot`
- made logging, usage, debugger state, screenshots, and most MCP task state
  session-scoped instead of global
- separated MCP task state from sidepanel UI task state

## Live Validation Completed

Validated through `node server/dist/cli.js` against the local relay and
Chrome extension:

- parallel MCP `start` sessions complete independently
- `message` resumes a completed session correctly
- `screenshot` works on completed and resumed sessions
- `stop` stops the target session without killing a parallel session
- `stop --remove` removes the target session files
- short idle/reconnect worked after waiting about 70 seconds, then sending
  `message` and `screenshot`
- parallel monitoring smoke test looked isolated
  - `example.org` saw its own network activity
  - `example.com` did not inherit that history

## Still Not Fully Proven

- sidepanel UI task running in parallel with MCP
- popup-heavy / OAuth / multi-tab workflows after the refactor
- long-idle TTL cleanup behavior
- deeper console/network isolation checks on more dynamic sites

## Working Rule

Do not add a second MCP browser execution path.

If browser behavior changes, the source of truth is the extension execution path
and the MCP server should stay a thin wrapper around it.
