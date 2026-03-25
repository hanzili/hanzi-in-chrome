#!/usr/bin/env node

/**
 * Managed Backend Server
 *
 * Starts the REST API + connects to the WebSocket relay.
 * On first run, creates a default workspace and API key.
 *
 * Usage:
 *   VERTEX_SA_PATH=/path/to/sa.json node dist/managed/server.js
 *   node dist/managed/server.js --sa /path/to/sa.json --port 3456
 */

import { initVertex } from "../llm/vertex.js";
import { WebSocketClient } from "../ipc/websocket-client.js";
import { startManagedAPI, initManagedAPI, handleRelayMessage } from "./api.js";
import { ensureDefaultWorkspace } from "./store.js";

const SA_PATH =
  process.env.VERTEX_SA_PATH ||
  process.argv.find((_, i, arr) => arr[i - 1] === "--sa") ||
  "/tmp/hanzi-vertex-sa.json";

const RELAY_URL = process.env.RELAY_URL || "ws://localhost:7862";
const API_PORT = parseInt(process.env.API_PORT || "3456", 10);

async function main() {
  // 1. Init Vertex AI
  console.error(`[Server] Loading Vertex AI credentials from ${SA_PATH}`);
  initVertex(SA_PATH);

  // 2. Bootstrap default workspace + API key
  const { workspace, apiKey } = ensureDefaultWorkspace();
  console.error(`[Server] Workspace: ${workspace.name} (${workspace.id})`);
  console.error(`[Server] API Key: ${apiKey.key}`);

  // 3. Connect to WebSocket relay
  console.error(`[Server] Connecting to relay at ${RELAY_URL}`);
  const relay = new WebSocketClient({
    role: "mcp" as any,
    relayUrl: RELAY_URL,
    autoStartRelay: true,
  });

  relay.onMessage((message: any) => {
    if (handleRelayMessage(message)) return;
    // Ignore pong and registered messages
    if (message?.type === "pong" || message?.type === "registered") return;
    console.error(`[Server] Unhandled relay message: ${message?.type}`);
  });

  await relay.connect();

  // 4. Start the API
  initManagedAPI(relay);
  startManagedAPI(API_PORT);

  console.error(`
╔═══════════════════════════════════════════════════════╗
║  Hanzi Managed Backend                                ║
║                                                       ║
║  API:     http://localhost:${String(API_PORT).padEnd(5)}                      ║
║  Relay:   ${RELAY_URL.padEnd(43)} ║
║  LLM:     Vertex AI (Gemini 2.5 Flash)                ║
║                                                       ║
║  API Key: ${apiKey.key.slice(0, 20)}...  ║
║                                                       ║
║  Test:                                                ║
║  curl -X POST http://localhost:${String(API_PORT).padEnd(5)}v1/tasks \\        ║
║    -H "Authorization: Bearer ${apiKey.key.slice(0, 16)}..." \\  ║
║    -H "Content-Type: application/json" \\               ║
║    -d '{"task": "Go to example.com"}'                  ║
╚═══════════════════════════════════════════════════════╝
`);
}

main().catch((err) => {
  console.error("[Server] Fatal error:", err);
  process.exit(1);
});
