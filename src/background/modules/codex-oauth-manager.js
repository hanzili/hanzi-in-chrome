/**
 * Codex OAuth Manager - Handles Codex/OpenAI OAuth authentication
 *
 * Imports credentials from Codex CLI (~/.codex/auth.json)
 * to use ChatGPT Pro/Plus subscription quota instead of API rate limits.
 */

const NATIVE_HOST_NAME = 'com.hanzi_in_chrome.oauth_host';

/**
 * Import OAuth credentials from Codex CLI installation
 * Reads tokens from ~/.codex/auth.json
 *
 * @returns {Promise<Object>} OAuth credentials { accessToken, refreshToken, accountId }
 */
export async function importCodexCredentials() {
  console.log('[Codex OAuth] ===== Importing Codex CLI Credentials =====');
  console.log('[Codex OAuth] This reads tokens from ~/.codex/auth.json');

  return new Promise((resolve, reject) => {
    let port = null;
    let resolved = false;

    // Timeout after 10 seconds
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        console.error('[Codex OAuth] ✗ Timeout waiting for native host response');
        if (port) port.disconnect();
        reject(new Error('Timeout waiting for native host response'));
      }
    }, 10000);

    try {
      console.log('[Codex OAuth] Connecting to native host:', NATIVE_HOST_NAME);
      port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
      console.log('[Codex OAuth] ✓ Connected to native host');

      port.onMessage.addListener(async (message) => {
        if (resolved) return;
        console.log('[Codex OAuth] Message received:', message.type);

        if (message.type === 'codex_credentials') {
          resolved = true;
          clearTimeout(timeout);
          console.log('[Codex OAuth] ✓ Codex credentials received');
          const { accessToken, refreshToken, accountId } = message.credentials;

          // Validate accessToken
          if (!accessToken) {
            console.error('[Codex OAuth] ✗ No accessToken in credentials');
            if (port) port.disconnect();
            reject(new Error('No accessToken found in Codex CLI credentials'));
            return;
          }

          console.log('[Codex OAuth] Access token:', accessToken.substring(0, 20) + '...');
          console.log('[Codex OAuth] Refresh token:', refreshToken ? refreshToken.substring(0, 20) + '...' : 'none');
          console.log('[Codex OAuth] Account ID:', accountId || 'none');

          // Save credentials to storage
          await chrome.storage.local.set({
            codexAccessToken: accessToken,
            codexRefreshToken: refreshToken,
            codexAccountId: accountId,
            codexAuthState: 'authenticated',
            codexTokenSource: 'codex_cli'
          });

          console.log('[Codex OAuth] ✓ Credentials saved to storage');

          if (port) port.disconnect();
          resolve({ accessToken, refreshToken, accountId });

        } else if (message.type === 'credentials_not_found') {
          resolved = true;
          clearTimeout(timeout);
          console.error('[Codex OAuth] ✗ CLI credentials not found');
          console.error('[Codex OAuth]', message.error);
          if (port) port.disconnect();
          reject(new Error(message.error));

        } else if (message.type === 'error') {
          resolved = true;
          clearTimeout(timeout);
          console.error('[Codex OAuth] ✗ Error:', message.error);
          if (port) port.disconnect();
          reject(new Error(message.error));
        }
      });

      port.onDisconnect.addListener(() => {
        console.log('[Codex OAuth] Native host disconnected');
        clearTimeout(timeout);
        if (!resolved) {
          resolved = true;
          const errorMsg = chrome.runtime.lastError?.message || 'Native host disconnected unexpectedly';
          console.error('[Codex OAuth] ✗ Disconnect error:', errorMsg);
          reject(new Error(`Native host error: ${errorMsg}`));
        }
      });

      console.log('[Codex OAuth] Sending read_codex_credentials message...');
      port.postMessage({ type: 'read_codex_credentials' });

    } catch (error) {
      resolved = true;
      clearTimeout(timeout);
      console.error('[Codex OAuth] ✗ Failed to connect:', error);
      if (port) port.disconnect();
      reject(new Error(`Failed to connect: ${error.message}`));
    }
  });
}

/**
 * Get current Codex access token
 *
 * @returns {Promise<string|null>} Access token or null if not authenticated
 */
export async function getCodexAccessToken() {
  const { codexAccessToken } = await chrome.storage.local.get('codexAccessToken');
  return codexAccessToken || null;
}

/**
 * Get Codex account ID for API headers
 *
 * @returns {Promise<string|null>} Account ID or null
 */
export async function getCodexAccountId() {
  const { codexAccountId } = await chrome.storage.local.get('codexAccountId');
  return codexAccountId || null;
}

/**
 * Logout and clear Codex OAuth tokens
 */
export async function logoutCodex() {
  await chrome.storage.local.remove([
    'codexAccessToken',
    'codexRefreshToken',
    'codexAccountId',
    'codexAuthState',
    'codexTokenSource'
  ]);

  console.log('[Codex OAuth] Codex tokens cleared');
}

/**
 * Check if user is authenticated with Codex
 *
 * @returns {Promise<boolean>} True if authenticated
 */
export async function isCodexAuthenticated() {
  const token = await getCodexAccessToken();
  return token !== null;
}

/**
 * Get Codex authentication status
 *
 * @returns {Promise<Object>} Status object
 */
export async function getCodexAuthStatus() {
  const {
    codexAccessToken,
    codexAccountId,
    codexAuthState
  } = await chrome.storage.local.get([
    'codexAccessToken',
    'codexAccountId',
    'codexAuthState'
  ]);

  return {
    isAuthenticated: !!codexAccessToken,
    accountId: codexAccountId,
    state: codexAuthState || 'unauthenticated'
  };
}
