#!/usr/bin/env node
/**
 * LLM Browser CLI
 *
 * Command-line interface for browser automation.
 * Sends tasks to the Chrome extension via WebSocket relay.
 *
 * Usage:
 *   hanzi-browser start "task" --url https://example.com
 *   hanzi-browser status [session_id]
 *   hanzi-browser message <session_id> "message"
 *   hanzi-browser logs <session_id> [--follow]
 *   hanzi-browser stop <session_id> [--remove]
 *   hanzi-browser screenshot <session_id>
 */
export {};
