#!/usr/bin/env node
/**
 * WebSocket Relay Server
 *
 * Stateless message router between extension, MCP server, and CLI.
 * Replaces file-based IPC with real-time WebSocket communication.
 *
 * Roles:
 *   - extension: Chrome extension service worker (one at a time)
 *   - mcp: MCP server (can have multiple)
 *   - cli: CLI clients (can have multiple)
 *
 * Routing:
 *   - extension → originating mcp/cli client when tagged, otherwise broadcast
 *   - mcp/cli → send to extension
 */
export {};
