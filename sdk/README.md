# @hanzi/browser-agent

SDK for the Hanzi browser automation platform. Control a real Chrome browser programmatically — navigate, click, read pages, fill forms — powered by AI.

## Install

The SDK is not yet published to npm. Install from the repo:

```bash
# From the llm-in-chrome repo root:
cd sdk && npm install && npm run build
# Then in your project:
npm install /path/to/llm-in-chrome/sdk
```

## Quick Start

```typescript
import { HanziClient } from '@hanzi/browser-agent';

const client = new HanziClient({
  apiKey: 'hic_live_xxx',
});

// Run a task (blocks until complete)
const result = await client.runTask({
  browserSessionId: 'your-session-id',
  task: 'Go to linkedin.com and check unread messages',
});

console.log(result.answer);
// "You have 3 unread messages from: Alice, Bob, Carol"
```

## Setup

### 1. Get an API key

[Sign in](https://api.hanzilla.co/api/auth/sign-in/social) to open your developer console, then create an API key.

### 2. Connect a browser

The browser you want to control needs the Hanzi Chrome extension installed and paired to your workspace.

```typescript
// Your backend creates a pairing token
const { pairingToken } = await client.createPairingToken();

// The browser user enters the pairing token in the extension
// (Settings → Managed → paste token → Connect)
```

### 3. Run tasks

```typescript
// Find connected browser sessions
const sessions = await client.listSessions();
const connected = sessions.find(s => s.status === 'connected');

// Run a task against that browser
const result = await client.runTask({
  browserSessionId: connected.id,
  task: 'Read the patient chart on the current page',
  context: 'Extract: name, medications, allergies, problems',
});

console.log(result.answer);
console.log(result.usage); // { inputTokens, outputTokens, apiCalls }
```

## API Reference

### `new HanziClient(options)`

| Option | Type | Required | Default |
|--------|------|----------|---------|
| `apiKey` | string | Yes | — |
| `baseUrl` | string | No | `https://api.hanzilla.co` |

### `client.runTask(params, options?)`

Run a task and wait for completion. This is the main method.

**Params:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `browserSessionId` | string | Yes | Connected browser session |
| `task` | string | Yes | What to do |
| `url` | string | No | Starting URL |
| `context` | string | No | Extra context (form data, preferences) |

**Options:**
| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `pollIntervalMs` | number | 2000 | How often to check status |
| `timeoutMs` | number | 300000 | Max wait time (5 min) |

**Returns:** `TaskRun` with `status`, `answer`, `steps`, `usage`.

### `client.createTask(params)`

Start a task without waiting. Returns immediately.

### `client.getTask(taskId)`

Check status of a running task.

### `client.cancelTask(taskId)`

Cancel a running task.

### `client.createPairingToken()`

Create a pairing token for connecting a browser.

### `client.listSessions()`

List browser sessions in your workspace.

### `client.getUsage()`

Get usage summary (tokens, costs, task count).

### `client.health()`

Check if the API is reachable. No auth required.
