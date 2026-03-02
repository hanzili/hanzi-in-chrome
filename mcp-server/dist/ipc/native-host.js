/**
 * Native Host IPC Module
 *
 * Handles communication with the Chrome extension via native messaging protocol.
 * This module is shared between the MCP server and CLI to eliminate duplication.
 *
 * Protocol: Chrome Native Messaging (4-byte little-endian length prefix + JSON)
 *
 * Architecture:
 *   MCP Server/CLI → NativeHostConnection → Native Host Process → Chrome Extension
 *                  ↑                                            ↓
 *                  ← ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ←
 */
import { spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
// ============================================================================
// Native Host Connection Class
// ============================================================================
/**
 * Manages a connection to the native host process.
 *
 * Usage:
 *   const conn = new NativeHostConnection();
 *   conn.onMessage((msg) => console.log('Received:', msg));
 *   await conn.connect();
 *   await conn.send({ type: 'mcp_poll_results', requestIds: ['abc'] });
 */
export class NativeHostConnection {
    process = null;
    messageBuffer = Buffer.alloc(0);
    messageHandlers = [];
    options;
    connected = false;
    constructor(options = {}) {
        this.options = options;
    }
    /**
     * Find the native host executable path from the installed Chrome manifest
     */
    findHostPath() {
        // Check user-provided path first
        if (this.options.hostPath && existsSync(this.options.hostPath)) {
            return this.options.hostPath;
        }
        // Look for Chrome native messaging manifest
        const manifestPath = join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts', 'com.hanzi_in_chrome.oauth_host.json');
        if (existsSync(manifestPath)) {
            try {
                const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
                if (manifest.path && existsSync(manifest.path)) {
                    return manifest.path;
                }
            }
            catch {
                // Fall through to error
            }
        }
        throw new Error('Native host not found. Please install the Chrome extension first.\n' +
            'Expected manifest at: ' + manifestPath);
    }
    /**
     * Register a handler for incoming messages
     */
    onMessage(handler) {
        this.messageHandlers.push(handler);
    }
    /**
     * Remove a message handler
     */
    offMessage(handler) {
        const index = this.messageHandlers.indexOf(handler);
        if (index !== -1) {
            this.messageHandlers.splice(index, 1);
        }
    }
    /**
     * Connect to the native host process
     */
    async connect() {
        if (this.connected && this.process?.stdin?.writable) {
            return; // Already connected
        }
        const hostPath = this.findHostPath();
        console.error(`[NativeHost] Connecting to: ${hostPath}`);
        return new Promise((resolve, reject) => {
            try {
                this.process = spawn(hostPath, [], {
                    stdio: ['pipe', 'pipe', 'pipe'],
                });
                this.process.stdout?.on('data', (chunk) => {
                    this.messageBuffer = Buffer.concat([this.messageBuffer, chunk]);
                    this.processMessages();
                });
                this.process.stderr?.on('data', (data) => {
                    const text = data.toString().trim();
                    if (this.options.onStderr) {
                        this.options.onStderr(text);
                    }
                    else {
                        console.error(`[NativeHost] ${text}`);
                    }
                });
                this.process.on('error', (err) => {
                    console.error('[NativeHost] Process error:', err.message);
                    this.connected = false;
                    reject(err);
                });
                this.process.on('close', (code) => {
                    console.error(`[NativeHost] Process exited with code: ${code}`);
                    this.connected = false;
                    this.process = null;
                    if (this.options.onDisconnect) {
                        this.options.onDisconnect(code);
                    }
                });
                this.connected = true;
                // Give the process a moment to initialize
                setTimeout(() => resolve(), 100);
            }
            catch (err) {
                reject(err);
            }
        });
    }
    /**
     * Process buffered messages using the native messaging protocol
     * (4-byte little-endian length prefix + JSON payload)
     */
    processMessages() {
        while (this.messageBuffer.length >= 4) {
            const msgLen = this.messageBuffer.readUInt32LE(0);
            if (this.messageBuffer.length < 4 + msgLen) {
                break; // Wait for more data
            }
            const msgStr = this.messageBuffer.subarray(4, 4 + msgLen).toString();
            this.messageBuffer = this.messageBuffer.subarray(4 + msgLen);
            try {
                const message = JSON.parse(msgStr);
                this.dispatchMessage(message);
            }
            catch (e) {
                console.error('[NativeHost] Failed to parse message:', e);
                console.error('[NativeHost] Raw message (first 200 chars):', msgStr.substring(0, 200));
            }
        }
    }
    /**
     * Dispatch a message to all registered handlers
     */
    async dispatchMessage(message) {
        for (const handler of this.messageHandlers) {
            try {
                await handler(message);
            }
            catch (err) {
                console.error('[NativeHost] Handler error:', err);
            }
        }
    }
    /**
     * Send a message to the native host
     */
    async send(message) {
        if (!this.process?.stdin?.writable) {
            await this.connect();
        }
        const json = JSON.stringify(message);
        const buffer = Buffer.from(json);
        const len = Buffer.alloc(4);
        len.writeUInt32LE(buffer.length, 0);
        try {
            this.process.stdin.write(len);
            this.process.stdin.write(buffer);
        }
        catch (err) {
            console.error('[NativeHost] Send failed:', err.message);
            this.connected = false;
            this.process = null;
            throw new Error(`Failed to send message: ${err.message}`);
        }
    }
    /**
     * Check if connected to native host
     */
    isConnected() {
        return this.connected && !!this.process?.stdin?.writable;
    }
    /**
     * Disconnect from the native host
     */
    disconnect() {
        if (this.process) {
            this.process.kill();
            this.process = null;
        }
        this.connected = false;
        this.messageBuffer = Buffer.alloc(0);
    }
}
// ============================================================================
// Convenience Functions
// ============================================================================
/** Singleton instance for simple usage */
let defaultConnection = null;
/**
 * Get the default native host connection (creates one if needed)
 */
export function getDefaultConnection() {
    if (!defaultConnection) {
        defaultConnection = new NativeHostConnection();
    }
    return defaultConnection;
}
/**
 * Reset the default connection (useful for testing)
 */
export function resetDefaultConnection() {
    if (defaultConnection) {
        defaultConnection.disconnect();
        defaultConnection = null;
    }
}
