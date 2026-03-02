# OAuth Native Messaging Host

This directory contains the native messaging host for OAuth authentication with Claude.

## Why is this needed?

Claude's OAuth requires a `redirect_uri` that's whitelisted for the Claude Code CLI `client_id`. Browser extension URLs (`chrome-extension://...`) are not whitelisted, but `localhost` URLs are.

**Solution**: Run a local HTTP server to receive the OAuth callback.

## Architecture

```
Extension → Native Messaging → Node.js Script → HTTP Server (localhost:8080)
                                                      ↓
                                                OAuth Callback
                                                      ↓
Extension ← Native Messaging ← Node.js Script ← Auth Code
```

## Installation

### Prerequisites

- Node.js installed (https://nodejs.org)
- Browser extension loaded in Chrome

### Steps

1. **Get your extension ID**:
   ```bash
   # Go to chrome://extensions
   # Enable "Developer mode"
   # Find "Hanzi in Chrome" and copy the ID
   ```

2. **Run the installation script**:
   ```bash
   cd native-host
   chmod +x install.sh
   ./install.sh
   ```

3. **Enter your extension ID** when prompted

4. **Reload the extension** in `chrome://extensions`

### What the installer does:

- Makes `oauth-server.js` executable
- Creates a manifest with your extension ID and correct paths
- Installs the manifest to the Chrome native messaging directory:
  - **macOS**: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`
  - **Linux**: `~/.config/google-chrome/NativeMessagingHosts/`

## Usage

1. Open the extension
2. Go to Settings → Providers
3. Click **"Login with Claude Account"**
4. A new tab opens with the Claude authorization page
5. Click "Authorize"
6. The tab redirects to `http://localhost:8080/callback`
7. You see "✓ Authorization Successful!"
8. The tab auto-closes
9. Extension is now authenticated with OAuth

## How it works

### 1. Extension starts OAuth flow

```javascript
// Extension connects to native messaging host
const port = chrome.runtime.connectNative('com.hanzi_in_chrome.oauth_host');

// Sends "start_server" message
port.postMessage({ type: 'start_server' });
```

### 2. Native app starts HTTP server

```javascript
// Native app (oauth-server.js) starts server on localhost:8080
http.createServer((req, res) => {
  // Listens for OAuth callback at /callback
}).listen(8080);

// Sends confirmation back to extension
sendMessage({ type: 'server_started', callback_url: 'http://127.0.0.1:8080/callback' });
```

### 3. Extension opens OAuth URL

```javascript
// Extension opens OAuth page in new tab
const authUrl = 'https://claude.ai/oauth/authorize?' +
  'client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&' +
  'redirect_uri=http://127.0.0.1:8080/callback&' +
  // ... other params

chrome.tabs.create({ url: authUrl });
```

### 4. User authorizes

- User sees Claude authorization page
- User clicks "Authorize"
- Browser redirects to `http://127.0.0.1:8080/callback?code=...&state=...`

### 5. Local server captures callback

```javascript
// Native app receives callback
const code = parsedUrl.query.code;
const state = parsedUrl.query.state;

// Sends code back to extension
sendMessage({ type: 'oauth_success', code, state });

// Shows success page to user
res.end('<h1>✓ Authorization Successful!</h1>');
```

### 6. Extension exchanges code for tokens

```javascript
// Extension receives code from native app
port.onMessage.addListener((message) => {
  if (message.type === 'oauth_success') {
    // Exchange code for access token
    const tokens = await exchangeCodeForTokens(message.code);
    // Save tokens for API calls
  }
});
```

## Troubleshooting

### Error: "Failed to connect to native messaging host"

**Solution**: The native messaging host is not installed or not configured correctly.

```bash
cd native-host
./install.sh
```

### Error: "Native host error: Specified native messaging host not found"

**Causes**:
1. Manifest file not in the correct directory
2. Extension ID in manifest doesn't match your extension
3. Path in manifest is incorrect

**Check**:
```bash
# macOS
cat ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/com.hanzi_in_chrome.oauth_host.json

# Linux
cat ~/.config/google-chrome/NativeMessagingHosts/com.hanzi_in_chrome.oauth_host.json
```

**Fix**:
```bash
# Uninstall and reinstall
cd native-host
./uninstall.sh
./install.sh
```

### Error: "EADDRINUSE: address already in use"

**Cause**: Another process is using port 8080

**Solution**:
```bash
# Find and kill the process
lsof -ti:8080 | xargs kill -9

# Or change the PORT in oauth-server.js (line 25)
```

### Server starts but callback never arrives

**Check**:
1. Look at the browser address bar after clicking "Authorize"
2. Does it redirect to `http://127.0.0.1:8080/callback?code=...`?
3. If not, the redirect URI might not be whitelisted

**Debug**:
```bash
# Check native host logs
# They go to Chrome's extension console
# chrome://extensions → Hanzi in Chrome → service worker → Console
```

## Testing

### Test native messaging connection

Open the extension's service worker console (`chrome://extensions` → service worker):

```javascript
// Test connection
const port = chrome.runtime.connectNative('com.hanzi_in_chrome.oauth_host');

port.onMessage.addListener((msg) => {
  console.log('Received:', msg);
});

port.onDisconnect.addListener(() => {
  console.log('Disconnected:', chrome.runtime.lastError);
});

// Send ping
port.postMessage({ type: 'ping' });
// Should receive: { type: 'pong' }

// Start server
port.postMessage({ type: 'start_server' });
// Should receive: { type: 'server_started', port: 8080, callback_url: '...' }

// Test server is running
fetch('http://127.0.0.1:8080/callback?code=test&state=test')
  .then(r => r.text())
  .then(console.log);
```

### Manual OAuth test

1. Get the OAuth URL from console after clicking "Login"
2. Open it in a browser
3. Click "Authorize"
4. Check if you're redirected to `http://127.0.0.1:8080/callback`
5. Check if you see the success message

## Uninstallation

```bash
cd native-host
chmod +x uninstall.sh
./uninstall.sh
```

This removes the manifest file from Chrome's native messaging directory.

## Files

- `oauth-server.cjs` - Node.js HTTP server (native messaging host)
- `com.hanzi_in_chrome.oauth_host.json` - Template manifest
- `install.sh` - Installation script (macOS/Linux)
- `uninstall.sh` - Uninstallation script
- `README.md` - This file

## Security

- Server only runs during OAuth flow (auto-stops after success)
- Only listens on `127.0.0.1` (localhost only, not accessible from network)
- CSRF protection with `state` parameter
- Native messaging only allows communication from specified extension ID

## Alternatives

If native messaging seems too complex:

1. **Use API Keys** - Simple, works immediately
2. **Use OpenRouter** - Different provider, same Claude models
3. **Contact Anthropic** - Request official OAuth client registration
