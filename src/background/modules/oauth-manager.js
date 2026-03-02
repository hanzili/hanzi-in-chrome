/**
 * OAuth Manager - Handles Claude OAuth authentication
 *
 * Implements PKCE (Proof Key for Code Exchange) OAuth 2.0 flow
 * to authenticate users with their claude.ai account.
 *
 * This allows using Claude Pro/Max subscription quota instead of API rate limits.
 */

// OAuth endpoints
const OAUTH_CONFIG = {
  authorizeUrl: 'https://claude.ai/oauth/authorize',
  tokenUrl: 'https://console.anthropic.com/v1/oauth/token',
  scope: 'user:inference',
  clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  redirectUri: 'http://127.0.0.1:8080/callback'
};

const NATIVE_HOST_NAME = 'com.hanzi_in_chrome.oauth_host';

/**
 * Generate cryptographically random string for PKCE
 * @param {number} length - Length of random string
 * @returns {string} Base64url encoded random string
 */
function generateRandomString(length) {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return base64UrlEncode(array);
}

/**
 * Base64 URL encoding (without padding)
 * @param {Uint8Array} buffer - Buffer to encode
 * @returns {string} Base64url encoded string
 */
function base64UrlEncode(buffer) {
  const base64 = btoa(String.fromCharCode(...buffer));
  return base64
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * Generate SHA-256 hash
 * @param {string} plain - Plain text to hash
 * @returns {Promise<string>} Base64url encoded hash
 */
async function sha256(plain) {
  const encoder = new TextEncoder();
  const data = encoder.encode(plain);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(new Uint8Array(hash));
}

/**
 * Import OAuth credentials from Claude CLI installation
 * Reads tokens from ~/.claude/.credentials.json (same approach as ccproxy)
 *
 * @returns {Promise<Object>} OAuth credentials { sessionKey, expiresAt }
 */
export async function importCLICredentials() {
  console.log('[OAuth] ===== Importing Claude CLI Credentials =====');
  console.log('[OAuth] This reads tokens from ~/.claude/.credentials.json');
  console.log('[OAuth] (Same approach as ccproxy)');

  return new Promise((resolve, reject) => {
    let port = null;

    try {
      console.log('[OAuth] Connecting to native host:', NATIVE_HOST_NAME);
      port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
      console.log('[OAuth] ✓ Connected to native host');

      port.onMessage.addListener(async (message) => {
        console.log('[OAuth] Message received:', message.type);

        if (message.type === 'cli_credentials') {
          console.log('[OAuth] ✓ CLI credentials received');
          const { accessToken, refreshToken, expiresAt, subscriptionType } = message.credentials;

          // Validate accessToken
          if (!accessToken) {
            console.error('[OAuth] ✗ No accessToken in credentials');
            if (port) port.disconnect();
            reject(new Error('No accessToken found in Claude CLI credentials'));
            return;
          }

          console.log('[OAuth] Access token:', accessToken.substring(0, 20) + '...');
          console.log('[OAuth] Refresh token:', refreshToken ? refreshToken.substring(0, 20) + '...' : 'none');
          console.log('[OAuth] Subscription type:', subscriptionType || 'unknown');

          // Handle expiresAt (should be a timestamp in milliseconds)
          let expiresAtTimestamp = null;
          if (expiresAt) {
            expiresAtTimestamp = typeof expiresAt === 'number' ? expiresAt : new Date(expiresAt).getTime();
            if (!isNaN(expiresAtTimestamp)) {
              console.log('[OAuth] Expires at:', new Date(expiresAtTimestamp).toISOString());
            } else {
              console.warn('[OAuth] Invalid expiresAt value, tokens will not auto-refresh');
              expiresAtTimestamp = null;
            }
          } else {
            console.log('[OAuth] No expiresAt field (tokens may not expire)');
          }

          // Save credentials to storage
          await chrome.storage.local.set({
            oauthAccessToken: accessToken,
            oauthRefreshToken: refreshToken,
            oauthExpiresAt: expiresAtTimestamp,
            oauthTokenType: 'Bearer',
            authMethod: 'oauth',
            oauthState: 'authenticated',
            tokenSource: 'claude_cli'
          });

          console.log('[OAuth] ✓ Credentials saved to storage');

          if (port) port.disconnect();
          resolve({ accessToken, refreshToken, expiresAt: expiresAtTimestamp });

        } else if (message.type === 'credentials_not_found') {
          console.error('[OAuth] ✗ CLI credentials not found');
          console.error('[OAuth]', message.error);
          if (port) port.disconnect();
          reject(new Error(message.error));

        } else if (message.type === 'error') {
          console.error('[OAuth] ✗ Error:', message.error);
          if (port) port.disconnect();
          reject(new Error(message.error));
        }
      });

      port.onDisconnect.addListener(() => {
        console.log('[OAuth] Native host disconnected');
        if (chrome.runtime.lastError) {
          console.error('[OAuth] ✗ Disconnect error:', chrome.runtime.lastError.message);
          reject(new Error(`Native host error: ${chrome.runtime.lastError.message}`));
        }
      });

      console.log('[OAuth] Sending read_cli_credentials message...');
      port.postMessage({ type: 'read_cli_credentials' });

    } catch (error) {
      console.error('[OAuth] ✗ Failed to connect:', error);
      if (port) port.disconnect();
      reject(new Error(`Failed to connect: ${error.message}`));
    }
  });
}

/**
 * Start OAuth login flow using native messaging + local server
 * Opens OAuth URL in browser tab, local server captures callback
 *
 * @returns {Promise<Object>} OAuth tokens { accessToken, refreshToken, expiresAt }
 */
export async function startOAuthLogin() {
  console.log('[OAuth] ===== Starting OAuth Login Flow =====');

  const codeVerifier = generateRandomString(128);
  console.log('[OAuth] Generated code verifier:', codeVerifier.substring(0, 20) + '...');

  const codeChallenge = await sha256(codeVerifier);
  console.log('[OAuth] Generated code challenge:', codeChallenge.substring(0, 20) + '...');

  const state = generateRandomString(32);
  console.log('[OAuth] Generated state:', state);

  console.log('[OAuth] Saving PKCE data to storage...');
  await chrome.storage.local.set({
    pkceCodeVerifier: codeVerifier,
    oauthState: 'pending',
    oauthStateParam: state
  });
  console.log('[OAuth] Storage saved successfully');

  console.log('[OAuth] Connecting to native host:', NATIVE_HOST_NAME);

  return new Promise((resolve, reject) => {
    let port = null;
    let authTab = null;

    try {
      console.log('[OAuth] Calling chrome.runtime.connectNative...');
      port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
      console.log('[OAuth] ✓ Connected to native host successfully');
      console.log('[OAuth] Port object:', port);

      port.onMessage.addListener(async (message) => {
        console.log('[OAuth] <<<< Message received from native host');
        console.log('[OAuth] Message type:', message.type);
        console.log('[OAuth] Full message:', JSON.stringify(message, null, 2));

        if (message.type === 'server_started') {
          console.log('[OAuth] Server started! Port:', message.port);
          console.log('[OAuth] Callback URL:', message.callback_url);
          console.log('[OAuth] Building authorization URL...');
          const authUrl = new URL(OAUTH_CONFIG.authorizeUrl);
          authUrl.searchParams.set('response_type', 'code');
          authUrl.searchParams.set('client_id', OAUTH_CONFIG.clientId);
          authUrl.searchParams.set('redirect_uri', OAUTH_CONFIG.redirectUri);
          authUrl.searchParams.set('scope', OAUTH_CONFIG.scope);
          authUrl.searchParams.set('state', state);
          authUrl.searchParams.set('code_challenge', codeChallenge);
          authUrl.searchParams.set('code_challenge_method', 'S256');

          console.log('[OAuth] Authorization URL:', authUrl.toString());
          console.log('[OAuth] Opening authorization page in new tab...');
          authTab = await chrome.tabs.create({ url: authUrl.toString(), active: true });
          console.log('[OAuth] ✓ Authorization tab opened, tab ID:', authTab.id);
        } else if (message.type === 'oauth_success') {
          console.log('[OAuth] OAuth success! Received authorization code');
          console.log('[OAuth] Code:', message.code.substring(0, 10) + '...');
          console.log('[OAuth] State from callback:', message.state);

          const { oauthStateParam } = await chrome.storage.local.get('oauthStateParam');
          console.log('[OAuth] State from storage:', oauthStateParam);

          if (message.state !== oauthStateParam) {
            console.error('[OAuth] ✗ State mismatch! CSRF attack detected');
            reject(new Error('Invalid state'));
            return;
          }
          console.log('[OAuth] ✓ State validated');

          try {
            console.log('[OAuth] Exchanging authorization code for tokens...');
            const tokens = await exchangeCodeForTokens(message.code);
            console.log('[OAuth] ✓ Tokens received');

            console.log('[OAuth] Saving tokens to storage...');
            await saveTokens(tokens);
            console.log('[OAuth] ✓ Tokens saved');

            await chrome.storage.local.set({ oauthState: 'authenticated' });
            console.log('[OAuth] Cleaning up...');
            if (port) port.disconnect();
            if (authTab) chrome.tabs.remove(authTab.id).catch(() => {});
            console.log('[OAuth] ===== OAuth Login Complete =====');
            resolve(tokens);
          } catch (error) {
            console.error('[OAuth] ✗ Token exchange failed:', error);
            reject(error);
          }
        } else if (message.type === 'error' || message.type === 'oauth_error') {
          console.error('[OAuth] ✗ Error from native host:', message.error);
          reject(new Error(message.error || 'OAuth failed'));
        } else {
          console.warn('[OAuth] Unknown message type:', message.type);
        }
      });

      port.onDisconnect.addListener(() => {
        console.log('[OAuth] ==== Native host disconnected ====');
        if (chrome.runtime.lastError) {
          console.error('[OAuth] ✗ Disconnect error:', chrome.runtime.lastError);
          console.error('[OAuth] Error message:', chrome.runtime.lastError.message);
          reject(new Error(`Native host error: ${chrome.runtime.lastError.message}`));
        } else {
          console.log('[OAuth] Clean disconnect (no error)');
        }
      });

      console.log('[OAuth] >>>> Sending start_server message to native host');
      const msg = { type: 'start_server' };
      console.log('[OAuth] Message:', JSON.stringify(msg));
      port.postMessage(msg);
      console.log('[OAuth] Message sent, waiting for response...');

    } catch (error) {
      console.error('[OAuth] ✗ connectNative error:', error);
      console.error('[OAuth] Error stack:', error.stack);
      reject(new Error(`Failed to connect: ${error.message}`));
    }
  });
}

/**
 * Exchange authorization code for access tokens
 *
 * @param {string} code - Authorization code from OAuth callback
 * @returns {Promise<Object>} Token response
 */
async function exchangeCodeForTokens(code) {
  console.log('[OAuth] exchangeCodeForTokens() called');
  console.log('[OAuth] Code:', code.substring(0, 10) + '...');

  // Retrieve stored code verifier
  console.log('[OAuth] Retrieving PKCE code verifier from storage...');
  const { pkceCodeVerifier } = await chrome.storage.local.get('pkceCodeVerifier');

  if (!pkceCodeVerifier) {
    console.error('[OAuth] ✗ PKCE code verifier not found in storage');
    throw new Error('PKCE code verifier not found');
  }
  console.log('[OAuth] ✓ Code verifier found:', pkceCodeVerifier.substring(0, 20) + '...');

  // Build token request
  const body = {
    grant_type: 'authorization_code',
    code: code,
    redirect_uri: OAUTH_CONFIG.redirectUri,
    code_verifier: pkceCodeVerifier
  };

  // Add client_id if we have one
  if (OAUTH_CONFIG.clientId) {
    body.client_id = OAUTH_CONFIG.clientId;
  }

  console.log('[OAuth] Token request body:', {
    ...body,
    code: body.code.substring(0, 10) + '...',
    code_verifier: body.code_verifier.substring(0, 20) + '...'
  });
  console.log('[OAuth] Token URL:', OAUTH_CONFIG.tokenUrl);
  console.log('[OAuth] Making POST request...');

  const response = await fetch(OAUTH_CONFIG.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  console.log('[OAuth] Response status:', response.status);
  console.log('[OAuth] Response headers:', Object.fromEntries(response.headers.entries()));

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[OAuth] ✗ Token exchange failed');
    console.error('[OAuth] Status:', response.status);
    console.error('[OAuth] Error:', errorText);
    throw new Error(`Token exchange failed: ${response.status} ${errorText}`);
  }

  console.log('[OAuth] Parsing token response...');
  const data = await response.json();
  console.log('[OAuth] ✓ Token response received:', {
    ...data,
    access_token: data.access_token ? data.access_token.substring(0, 20) + '...' : undefined,
    refresh_token: data.refresh_token ? data.refresh_token.substring(0, 20) + '...' : undefined
  });

  // Clean up PKCE verifier and state parameter
  console.log('[OAuth] Cleaning up PKCE data from storage...');
  await chrome.storage.local.remove(['pkceCodeVerifier', 'oauthStateParam']);
  console.log('[OAuth] ✓ PKCE data cleaned up');

  const tokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
    tokenType: data.token_type
  };
  console.log('[OAuth] Returning tokens:', {
    ...tokens,
    accessToken: tokens.accessToken?.substring(0, 20) + '...',
    refreshToken: tokens.refreshToken?.substring(0, 20) + '...'
  });
  return tokens;
}

/**
 * Save OAuth tokens to storage
 *
 * @param {Object} tokens - Token data
 */
async function saveTokens(tokens) {
  const expiresAt = Date.now() + (tokens.expiresIn * 1000);

  await chrome.storage.local.set({
    oauthAccessToken: tokens.accessToken,
    oauthRefreshToken: tokens.refreshToken,
    oauthExpiresAt: expiresAt,
    oauthTokenType: tokens.tokenType || 'Bearer',
    authMethod: 'oauth'  // Set auth method to OAuth
  });

  console.log('OAuth tokens saved, expires at:', new Date(expiresAt).toISOString());
}

/**
 * Get current access token (refresh if needed)
 *
 * @returns {Promise<string|null>} Access token or null if not authenticated
 */
export async function getAccessToken() {
  const {
    oauthAccessToken,
    oauthRefreshToken,
    oauthExpiresAt
  } = await chrome.storage.local.get([
    'oauthAccessToken',
    'oauthRefreshToken',
    'oauthExpiresAt'
  ]);

  if (!oauthAccessToken) {
    return null;
  }

  // Check if token is expired (with 5 minute buffer)
  const now = Date.now();
  const buffer = 5 * 60 * 1000; // 5 minutes

  if (oauthExpiresAt && now + buffer < oauthExpiresAt) {
    // Token still valid
    return oauthAccessToken;
  }

  // Token expired, try to refresh
  if (oauthRefreshToken) {
    try {
      const tokens = await refreshAccessToken(oauthRefreshToken);
      await saveTokens(tokens);
      return tokens.accessToken;
    } catch (error) {
      console.error('Failed to refresh token:', error);
      // Clear invalid tokens
      await logout();
      return null;
    }
  }

  return null;
}

/**
 * Refresh access token using refresh token
 *
 * @param {string} refreshToken - Refresh token (optional - will fetch from storage if not provided)
 * @returns {Promise<Object|null>} New token data or null if refresh failed
 */
export async function refreshAccessToken(refreshToken = null) {
  // If no refresh token provided, get from storage
  if (!refreshToken) {
    const stored = await chrome.storage.local.get(['oauthRefreshToken']);
    refreshToken = stored.oauthRefreshToken;
    if (!refreshToken) {
      console.error('No refresh token available');
      return null;
    }
  }

  const body = {
    grant_type: 'refresh_token',
    refresh_token: refreshToken
  };

  if (OAUTH_CONFIG.clientId) {
    body.client_id = OAUTH_CONFIG.clientId;
  }

  console.log('Refreshing access token...');

  const response = await fetch(OAUTH_CONFIG.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token refresh failed: ${response.status} ${errorText}`);
  }

  const data = await response.json();

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken, // Some APIs don't return new refresh token
    expiresIn: data.expires_in,
    tokenType: data.token_type
  };
}

/**
 * Logout and clear OAuth tokens
 */
export async function logout() {
  await chrome.storage.local.remove([
    'oauthAccessToken',
    'oauthRefreshToken',
    'oauthExpiresAt',
    'oauthTokenType',
    'oauthState',
    'oauthStateParam',
    'pkceCodeVerifier',
    'authMethod'
  ]);

  console.log('OAuth tokens cleared');
}

/**
 * Check if user is authenticated with OAuth
 *
 * @returns {Promise<boolean>} True if authenticated
 */
export async function isAuthenticated() {
  const token = await getAccessToken();
  return token !== null;
}

/**
 * Get OAuth authentication status
 *
 * @returns {Promise<Object>} Status object
 */
export async function getAuthStatus() {
  const {
    oauthAccessToken,
    oauthExpiresAt,
    oauthState,
    authMethod
  } = await chrome.storage.local.get([
    'oauthAccessToken',
    'oauthExpiresAt',
    'oauthState',
    'authMethod'
  ]);

  return {
    isOAuthEnabled: authMethod === 'oauth',
    isAuthenticated: !!oauthAccessToken,
    expiresAt: oauthExpiresAt,
    state: oauthState || 'unauthenticated'
  };
}
