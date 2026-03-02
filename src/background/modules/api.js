/**
 * LLM API communication module (Refactored with Provider Pattern)
 * Handles API calls, streaming responses, and configuration.
 */

import { getToolsForUrl } from '../../tools/definitions.js';
import { buildSystemPrompt } from './system-prompt.js';
import { DOMAIN_SKILLS } from './domain-skills.js';
import { createProvider } from './providers/provider-factory.js';
import { getAccessToken, refreshAccessToken } from './oauth-manager.js';

// Configuration (loaded from storage)
let config = {
  apiBaseUrl: 'http://127.0.0.1:8000/claude/v1/messages',
  apiKey: null,
  model: 'claude-sonnet-4-20250514',
  maxTokens: 10000,
  maxSteps: 0,
};

// Abort controller for cancellation
let abortController = null;

// API call counter for debugging
let apiCallCounter = 0;

// Native host port for OAuth proxy (reused across API calls)
let nativeHostPort = null;

/**
 * Load configuration from storage
 */
export async function loadConfig() {
  const stored = await chrome.storage.local.get([
    'apiBaseUrl', 'apiKey', 'model', 'maxSteps', 'maxTokens',
    'providerKeys', 'customModels', 'currentModelIndex', 'userSkills', 'authMethod'
  ]);
  config = { ...config, ...stored };

  // Include built-in skills for UI display
  config.builtInSkills = DOMAIN_SKILLS.map(s => ({ domain: s.domain, skill: s.skill }));
  config.userSkills = stored.userSkills || [];

  return config;
}

/**
 * Get current config
 */
export function getConfig() {
  return config;
}

/**
 * Update config
 */
export function setConfig(newConfig) {
  config = { ...config, ...newConfig };
}

/**
 * Get API headers based on the provider endpoint and auth method
 * Supports both OAuth tokens and API keys
 */
export async function getApiHeaders() {
  // Create provider to get base headers (Anthropic-specific headers, etc.)
  const provider = createProvider(config.apiBaseUrl || '', config);
  const providerHeaders = await provider.getHeaders();

  // OAuth only applies to Anthropic - don't add OAuth headers to other providers
  const isAnthropic = config.apiBaseUrl?.includes('anthropic.com');

  // Check if using OAuth authentication (only for Anthropic)
  if (isAnthropic && config.authMethod === 'oauth') {
    const accessToken = await getAccessToken();

    if (accessToken) {
      // Use OAuth Bearer token instead of x-api-key
      // Remove x-api-key if present and add Authorization header
      const { 'x-api-key': _, ...headersWithoutApiKey } = providerHeaders;

      return {
        ...headersWithoutApiKey,
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      };
    }

    // OAuth configured but no token - fall back to API key
    console.warn('OAuth configured but no token available, falling back to API key');
  }

  // Use API key (provider-based)
  return providerHeaders;
}

/**
 * Create a new abort controller for task cancellation
 */
export function createAbortController() {
  abortController = new AbortController();
  return abortController;
}

/**
 * Get current abort controller
 */
export function getAbortController() {
  return abortController;
}

/**
 * Abort current request
 */
export function abortRequest() {
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
}

/**
 * Reset API call counter (called at start of each task)
 */
export function resetApiCallCounter() {
  apiCallCounter = 0;
}

/**
 * Get current API call count
 */
export function getApiCallCount() {
  return apiCallCounter;
}

/**
 * Check if the current provider is Claude (Anthropic)
 * Used to conditionally enable Claude-specific features like update_plan
 */
export function isClaudeProvider() {
  const provider = createProvider(config.apiBaseUrl || '', config);
  return provider.getName() === 'anthropic';
}

/**
 * Model tier mapping - maps tier names to specific model IDs
 * This allows agents to request "smart" or "fast" without knowing exact model names
 */
const MODEL_TIER_MAP = {
  fast: 'claude-haiku-4-5-20251001',      // Quick, cheap - good for browser execution
  smart: 'claude-sonnet-4-20250514',      // Balanced - good for planning, analysis
  powerful: 'claude-opus-4-5-20251101',   // Best quality - good for complex reasoning
};

/**
 * Codex model tier mapping - for OpenAI Codex (ChatGPT Pro/Plus)
 */
const CODEX_MODEL_TIER_MAP = {
  fast: 'gpt-5.1-codex',                  // gpt-5.1-mini not supported via Codex with ChatGPT account
  smart: 'gpt-5.1-codex',                 // Balanced - good for planning
  powerful: 'gpt-5.1-codex-max',          // Best quality - complex reasoning
};

/**
 * Simple LLM API call (for quick tasks like summarization, find tool, etc.)
 * Routes through native host to use keychain credentials (same as streaming API).
 *
 * Supports two call signatures:
 * 1. callLLMSimple(prompt, maxTokens) - simple string prompt
 * 2. callLLMSimple({ messages, maxTokens, modelTier }) - full messages array with options
 *
 * modelTier: "fast" (Haiku), "smart" (Sonnet), "powerful" (Opus)
 * If modelTier not specified, uses user's configured default model.
 *
 * Returns the full API response when using messages array, or just text when using string prompt.
 */
export async function callLLMSimple(promptOrOptions, maxTokensArg = 800) {
  await loadConfig();

  // Support both call signatures
  let messages;
  let maxTokens;
  let modelTier;
  let returnFullResponse = false;

  let system;

  if (typeof promptOrOptions === 'object' && promptOrOptions.messages) {
    // New signature: { messages, maxTokens, modelTier, system }
    messages = promptOrOptions.messages;
    maxTokens = promptOrOptions.maxTokens || 800;
    modelTier = promptOrOptions.modelTier;
    system = promptOrOptions.system;
    returnFullResponse = true;
  } else {
    // Legacy signature: (prompt, maxTokens)
    messages = [{ role: 'user', content: promptOrOptions }];
    maxTokens = maxTokensArg;
  }

  // Determine which model to use
  // This function always routes through the Anthropic API (via native host),
  // so we must use a Claude model. If the user configured a non-Claude model
  // (e.g., gpt-5.1-codex), fall back to haiku.
  const isClaudeModel = config.model?.startsWith('claude-');
  const modelToUse = modelTier && MODEL_TIER_MAP[modelTier]
    ? MODEL_TIER_MAP[modelTier]
    : isClaudeModel ? config.model : MODEL_TIER_MAP.fast;

  if (modelTier) {
    console.log(`[API] callLLMSimple: Using model tier "${modelTier}" → ${modelToUse}`);
  }

  // Claude Code credentials require streaming requests (non-streaming gets rejected)
  const useStreaming = config.authMethod === 'oauth';

  const requestBody = {
    model: modelToUse,
    max_tokens: maxTokens,
    messages: messages,
    ...(system ? { system } : {}),
    stream: useStreaming,
  };

  // Use Anthropic API directly (native host will add credentials from keychain)
  const apiUrl = 'https://api.anthropic.com/v1/messages';

  console.log(`[API] callLLMSimple: Routing through native host (streaming: ${useStreaming})`);

  // Route through native host (which loads credentials from keychain)
  const result = await callLLMSimpleViaProxy(apiUrl, requestBody);

  // Return full response for messages-based calls, just text for simple prompts
  if (returnFullResponse) {
    return result;
  }
  return result.content?.find(b => b.type === 'text')?.text || '';
}

/**
 * Make API call through native host proxy
 * Handles both streaming and non-streaming responses.
 * Uses keychain credentials (same as browser agent).
 * @private
 */
async function callLLMSimpleViaProxy(apiUrl, requestBody) {
  const TIMEOUT_MS = 90000; // 90 second timeout

  return new Promise((resolve, reject) => {
    const port = getNativeHostPort();
    let settled = false;

    // Streaming state (for stream: true requests)
    let streamResult = { content: [], stop_reason: null, usage: null };
    let currentTextBlock = null;

    const timeoutId = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error('LLM request timed out after 90 seconds'));
      }
    }, TIMEOUT_MS);

    const messageListener = (message) => {
      if (settled) return;

      if (message.type === 'stream_chunk') {
        // Streaming response — accumulate text
        const event = message.data;

        if (event.type === 'content_block_start' && event.content_block?.type === 'text') {
          currentTextBlock = { type: 'text', text: '' };
        } else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && currentTextBlock) {
          currentTextBlock.text += event.delta.text;
        } else if (event.type === 'content_block_stop' && currentTextBlock) {
          streamResult.content.push(currentTextBlock);
          currentTextBlock = null;
        } else if (event.type === 'message_delta') {
          streamResult.stop_reason = event.delta?.stop_reason;
          streamResult.usage = event.usage;
        }
      } else if (message.type === 'stream_end') {
        // Streaming complete
        settled = true;
        clearTimeout(timeoutId);
        port.onMessage.removeListener(messageListener);
        resolve(streamResult);
      } else if (message.type === 'api_response') {
        // Non-streaming response
        settled = true;
        clearTimeout(timeoutId);
        port.onMessage.removeListener(messageListener);

        if (message.status !== 200) {
          reject(new Error(`API error: ${message.status} - ${message.body?.substring(0, 200)}`));
          return;
        }

        try {
          const parsed = JSON.parse(message.body);
          resolve(parsed);
        } catch (e) {
          reject(new Error(`Failed to parse API response: ${e.message}`));
        }
      } else if (message.type === 'api_error') {
        settled = true;
        clearTimeout(timeoutId);
        port.onMessage.removeListener(messageListener);
        reject(new Error(message.error || 'API call failed'));
      } else if (message.type === 'tokens_refreshed') {
        // Token refreshed, native host will retry — just wait
        console.log('[API] callLLMSimpleViaProxy: Tokens refreshed, waiting for retry');
      }
    };

    port.onMessage.addListener(messageListener);

    // Send request to native host
    port.postMessage({
      type: 'proxy_api_call',
      data: {
        url: apiUrl,
        method: 'POST',
        headers: {},
        body: JSON.stringify(requestBody)
      }
    });
  });
}

/**
 * Get or create persistent native host connection for OAuth proxy
 * @private
 */
function getNativeHostPort() {
  if (!nativeHostPort || !nativeHostPort.name) {
    console.log('[API] Creating new native host connection for OAuth proxy');
    nativeHostPort = chrome.runtime.connectNative('com.hanzi_in_chrome.oauth_host');

    // Listen for token refresh events
    nativeHostPort.onMessage.addListener(async (message) => {
      if (message.type === 'tokens_refreshed') {
        console.log('[API] OAuth tokens were refreshed by native host');
        // Update extension storage with new tokens
        await chrome.storage.local.set({
          oauthAccessToken: message.credentials.accessToken,
          oauthRefreshToken: message.credentials.refreshToken,
          oauthExpiresAt: message.credentials.expiresAt
        });
        console.log('[API] Extension storage updated with refreshed tokens');
      }
    });

    nativeHostPort.onDisconnect.addListener(() => {
      console.log('[API] Native host disconnected');
      nativeHostPort = null;
    });
  }

  return nativeHostPort;
}

/**
 * Make API call through native messaging proxy (for OAuth)
 * Includes automatic retry on stream stalls
 * @private
 */
async function callLLMThroughProxy(messages, onTextChunk = null, log = () => {}, currentUrl = null) {
  const MAX_RETRIES = 2;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await callLLMThroughProxyOnce(messages, onTextChunk, log, currentUrl);
    } catch (err) {
      const isRetryable = err.message.includes('Stream stalled') ||
                          err.message.includes('timed out') ||
                          err.message.includes('no data received');

      if (isRetryable && attempt < MAX_RETRIES) {
        console.log(`[API] Attempt ${attempt} failed: ${err.message}. Retrying...`);
        await log('RETRY', `API retry ${attempt}/${MAX_RETRIES}`, { error: err.message });
        continue;
      }
      throw err;
    }
  }
}

/**
 * Single attempt at making API call through proxy
 * @private
 */
async function callLLMThroughProxyOnce(messages, onTextChunk = null, log = () => {}, currentUrl = null) {
  const provider = createProvider(config.apiBaseUrl || '', config);
  const isClaudeModel = provider.getName() === 'anthropic';
  const systemPrompt = buildSystemPrompt({ isClaudeModel });
  const useStreaming = onTextChunk !== null;

  // Filter tools based on current URL (hides domain-specific tools on non-matching sites)
  // Always use getToolsForUrl to ensure _domains property is stripped (API rejects unknown properties)
  const tools = getToolsForUrl(currentUrl);

  const requestBody = provider.buildRequestBody(messages, systemPrompt, tools, useStreaming);
  const apiUrl = provider.buildUrl(useStreaming);
  const requestBodyStr = JSON.stringify(requestBody);

  apiCallCounter++;
  const callNumber = apiCallCounter;
  const startTime = Date.now();

  // Extension-side timeout as safety net (native host has its own timeout too)
  const PROXY_TIMEOUT_MS = 150000; // 2.5 minutes

  const apiPromise = new Promise((resolve, reject) => {
    const port = getNativeHostPort();

    // Accumulate streaming response
    let streamResult = {
      content: [],
      stop_reason: null,
      usage: null
    };
    let currentTextBlock = null;
    let currentToolUse = null;

    const messageListener = async (message) => {
      if (message.type === 'stream_chunk') {
        const event = message.data;

        // Handle different SSE event types
        if (event.type === 'content_block_start') {
          if (event.content_block?.type === 'text') {
            currentTextBlock = { type: 'text', text: '' };
          } else if (event.content_block?.type === 'tool_use') {
            currentToolUse = {
              type: 'tool_use',
              id: event.content_block.id,
              name: event.content_block.name,
              input: {}
            };
          }
        } else if (event.type === 'content_block_delta') {
          if (event.delta?.type === 'text_delta' && currentTextBlock) {
            currentTextBlock.text += event.delta.text;
            if (onTextChunk) onTextChunk(event.delta.text);
          } else if (event.delta?.type === 'input_json_delta' && currentToolUse) {
            // Accumulate JSON string for tool input
            currentToolUse._inputJson = (currentToolUse._inputJson || '') + event.delta.partial_json;
          }
        } else if (event.type === 'content_block_stop') {
          if (currentTextBlock) {
            streamResult.content.push(currentTextBlock);
            currentTextBlock = null;
          } else if (currentToolUse) {
            try {
              currentToolUse.input = JSON.parse(currentToolUse._inputJson || '{}');
            } catch (e) {
              currentToolUse.input = {};
            }
            delete currentToolUse._inputJson;
            streamResult.content.push(currentToolUse);
            currentToolUse = null;
          }
        } else if (event.type === 'message_delta') {
          streamResult.stop_reason = event.delta?.stop_reason;
          streamResult.usage = event.usage;
        }
      } else if (message.type === 'stream_end') {
        port.onMessage.removeListener(messageListener);
        const duration = Date.now() - startTime;

        await log('API', `#${callNumber} ${config.model} → ${streamResult.stop_reason}`, {
          model: config.model,
          messages: messages.length,
          stopReason: streamResult.stop_reason,
          tokens: streamResult.usage,
          duration: `${duration}ms`,
        });

        resolve(streamResult);
      } else if (message.type === 'api_response') {
        port.onMessage.removeListener(messageListener);

        if (message.status !== 200) {
          const errorMessage = parseErrorResponse(message.body, message.status);
          reject(new Error(errorMessage));
          return;
        }

        try {
          const result = JSON.parse(message.body);
          const duration = Date.now() - startTime;

          await log('API', `#${callNumber} ${config.model} → ${result.stop_reason}`, {
            model: config.model,
            messages: messages.length,
            stopReason: result.stop_reason,
            tokens: result.usage,
            duration: `${duration}ms`,
          });

          resolve(result);
        } catch (err) {
          reject(new Error(`Failed to parse API response: ${err.message}`));
        }
      } else if (message.type === 'api_error') {
        port.onMessage.removeListener(messageListener);
        reject(new Error(message.error));
      }
    };

    port.onMessage.addListener(messageListener);

    // Send request to native host
    port.postMessage({
      type: 'proxy_api_call',
      data: {
        url: apiUrl,
        method: 'POST',
        headers: {},
        body: requestBodyStr
      }
    });
  });

  // Wrap with timeout
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error(`Proxy request timed out after ${PROXY_TIMEOUT_MS / 1000} seconds`));
    }, PROXY_TIMEOUT_MS);
  });

  return Promise.race([apiPromise, timeoutPromise]);
}

/**
 * Simple LLM call through proxy WITHOUT tools
 * Used by MCP for Planning Agent, Explorer Agent, etc.
 * Routes through native host which uses keychain credentials.
 *
 * @param {Array} messages - Conversation messages
 * @param {number} maxTokens - Maximum tokens in response
 * @returns {Promise<Object>} Full API response
 */
export async function callLLMSimpleViaProxyNoTools(messages, maxTokens = 2000) {
  await loadConfig();

  const PROXY_TIMEOUT_MS = 60000; // 60 seconds for simple requests

  // Build simple request body without tools
  const requestBody = {
    model: config.model,
    max_tokens: maxTokens,
    messages: messages,
    stream: false,  // Non-streaming for simple requests
  };

  const apiUrl = 'https://api.anthropic.com/v1/messages';
  const requestBodyStr = JSON.stringify(requestBody);

  console.log('[API] callLLMSimpleViaProxyNoTools: Sending request without tools');

  const apiPromise = new Promise((resolve, reject) => {
    const port = getNativeHostPort();
    let settled = false;

    const messageListener = (message) => {
      if (settled) return;

      if (message.type === 'api_response') {
        settled = true;
        port.onMessage.removeListener(messageListener);

        if (message.status !== 200) {
          reject(new Error(`API error: ${message.status} - ${message.body?.substring(0, 200)}`));
          return;
        }

        try {
          const result = JSON.parse(message.body);
          console.log('[API] callLLMSimpleViaProxyNoTools: Got response', {
            stopReason: result.stop_reason,
            contentBlocks: result.content?.length,
            usage: result.usage
          });
          resolve(result);
        } catch (err) {
          reject(new Error(`Failed to parse API response: ${err.message}`));
        }
      } else if (message.type === 'api_error') {
        settled = true;
        port.onMessage.removeListener(messageListener);
        reject(new Error(message.error || 'API call failed'));
      } else if (message.type === 'tokens_refreshed') {
        // Token was refreshed, native host will retry - just wait
        console.log('[API] callLLMSimpleViaProxyNoTools: Tokens refreshed, waiting for retry');
      }
    };

    port.onMessage.addListener(messageListener);

    // Send request to native host
    port.postMessage({
      type: 'proxy_api_call',
      data: {
        url: apiUrl,
        method: 'POST',
        headers: {},
        body: requestBodyStr
      }
    });
  });

  // Wrap with timeout
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error(`Simple LLM request timed out after ${PROXY_TIMEOUT_MS / 1000} seconds`));
    }, PROXY_TIMEOUT_MS);
  });

  return Promise.race([apiPromise, timeoutPromise]);
}

/**
 * Simple LLM call through proxy using Codex (ChatGPT Pro/Plus)
 * Uses Responses API format. Routes through native host which uses ~/.codex/auth.json.
 *
 * @param {Array} messages - Conversation messages (Anthropic format, will be converted)
 * @param {number} maxTokens - Maximum tokens in response
 * @param {string} modelTier - Model tier: 'fast', 'smart', or 'powerful'
 * @param {string} instructions - System instructions (optional, defaults to general assistant)
 * @returns {Promise<Object>} API response in Anthropic-compatible format
 */
export async function callLLMSimpleViaCodex(messages, _maxTokens = 2000, modelTier = 'smart', instructions = null) {
  const PROXY_TIMEOUT_MS = 90000; // 90 seconds for Codex (can be slower)

  // Map model tier to Codex model
  const model = CODEX_MODEL_TIER_MAP[modelTier] || CODEX_MODEL_TIER_MAP.smart;

  // Convert messages to Codex Responses API "input" format
  const input = convertMessagesToCodexInput(messages);

  // Default instructions if not provided (required by Codex API)
  const systemInstructions = instructions || 'You are a helpful assistant. Be concise and direct in your responses.';

  // Build Codex Responses API request body
  const requestBody = {
    model: model,
    input: input,
    instructions: systemInstructions,  // Required by Codex API
    store: false,    // Required by Codex API
    stream: true,    // Codex backend requires stream=true even for "non-streaming" use
  };

  const apiUrl = 'https://chatgpt.com/backend-api/codex/responses';
  const requestBodyStr = JSON.stringify(requestBody);

  console.log('[API] callLLMSimpleViaCodex: Sending request', { model, modelTier, inputItems: input.length });

  const apiPromise = new Promise((resolve, reject) => {
    const port = getNativeHostPort();
    let settled = false;
    let accumulatedText = '';
    let usage = null;

    const messageListener = (message) => {
      if (settled) return;

      if (message.type === 'stream_chunk') {
        // Handle Responses API streaming events
        const event = message.data;

        if (event.type === 'response.output_text.delta') {
          // Text streaming
          accumulatedText += event.delta || '';
        } else if (event.type === 'response.completed') {
          // Final response with usage
          const response = event.response;
          if (response?.usage) {
            usage = response.usage;
          }
          // Extract text from completed response if we missed streaming
          if (!accumulatedText && response?.output) {
            for (const item of response.output) {
              if (item.type === 'message' && item.content) {
                for (const part of item.content) {
                  if (part.type === 'output_text') {
                    accumulatedText += part.text || '';
                  }
                }
              }
            }
          }
        }
      } else if (message.type === 'stream_end') {
        settled = true;
        port.onMessage.removeListener(messageListener);

        // Build Anthropic-compatible response format
        const result = {
          content: [{ type: 'text', text: accumulatedText }],
          stop_reason: 'end_turn',
          usage: usage
        };

        console.log('[API] callLLMSimpleViaCodex: Got response', {
          textLength: accumulatedText.length,
          usage: usage
        });

        resolve(result);
      } else if (message.type === 'api_response') {
        settled = true;
        port.onMessage.removeListener(messageListener);

        if (message.status >= 400) {
          reject(new Error(`Codex API error: ${message.status} - ${message.body?.substring(0, 200)}`));
          return;
        }

        try {
          const response = JSON.parse(message.body);
          // Normalize Codex response to Anthropic format
          const result = normalizeCodexResponse(response);
          resolve(result);
        } catch (err) {
          reject(new Error(`Failed to parse Codex response: ${err.message}`));
        }
      } else if (message.type === 'api_error') {
        settled = true;
        port.onMessage.removeListener(messageListener);
        reject(new Error(message.error || 'Codex API call failed'));
      }
    };

    port.onMessage.addListener(messageListener);

    // Send request to native host
    port.postMessage({
      type: 'proxy_api_call',
      data: {
        url: apiUrl,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: requestBodyStr
      }
    });
  });

  // Wrap with timeout
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error(`Codex request timed out after ${PROXY_TIMEOUT_MS / 1000} seconds`));
    }, PROXY_TIMEOUT_MS);
  });

  return Promise.race([apiPromise, timeoutPromise]);
}

/**
 * Convert Anthropic-style messages to Codex Responses API input format
 * @private
 */
function convertMessagesToCodexInput(messages) {
  const input = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      // User message
      const text = typeof msg.content === 'string'
        ? msg.content
        : msg.content.map(b => b.text || '').join('\n');

      input.push({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text }]
      });
    } else if (msg.role === 'assistant') {
      // Assistant message
      const text = typeof msg.content === 'string'
        ? msg.content
        : msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n');

      if (text.trim()) {
        input.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text }]
        });
      }
    }
  }

  return input;
}

/**
 * Normalize Codex Responses API response to Anthropic format
 * @private
 */
function normalizeCodexResponse(response) {
  const content = [];
  let stopReason = 'end_turn';

  if (response.output) {
    for (const item of response.output) {
      if (item.type === 'message' && item.role === 'assistant') {
        for (const part of item.content || []) {
          if (part.type === 'output_text' && part.text) {
            content.push({ type: 'text', text: part.text });
          }
        }
      }
    }

    if (response.status === 'incomplete') {
      stopReason = 'max_tokens';
    }
  }

  // Ensure content is never empty
  if (content.length === 0) {
    content.push({ type: 'text', text: '' });
  }

  return {
    content,
    stop_reason: stopReason,
    usage: response.usage
  };
}

/**
 * Main LLM API call with tools and streaming support
 * @param {Array} messages - Conversation messages
 * @param {Function|null} onTextChunk - Callback for streaming text chunks
 * @param {Function} log - Logging function
 * @param {string|null} currentUrl - Current tab URL (used to filter domain-specific tools)
 * @param {AbortSignal|null} externalSignal - Optional abort signal (e.g., per-session abort for MCP tasks)
 */
export async function callLLM(messages, onTextChunk = null, log = () => {}, currentUrl = null, externalSignal = null) {
  await loadConfig();

  // Debug: log config values
  console.log('[API] Config loaded:', {
    apiBaseUrl: config.apiBaseUrl,
    model: config.model,
    hasApiKey: !!config.apiKey,
    apiKeyPrefix: config.apiKey ? config.apiKey.substring(0, 10) + '...' : 'none',
  });

  // Create provider instance
  const provider = createProvider(config.apiBaseUrl || '', config);
  const useStreaming = onTextChunk !== null;
  const signal = externalSignal || abortController?.signal;
  const isClaudeModel = provider.getName() === 'anthropic';
  const systemPrompt = buildSystemPrompt({ isClaudeModel });

  // Filter tools based on current URL (hides domain-specific tools on non-matching sites)
  // Always use getToolsForUrl to ensure _domains property is stripped (API rejects unknown properties)
  const tools = getToolsForUrl(currentUrl);

  // Get URL for early routing checks (OAuth proxy, Codex fallback)
  // Full request body is built later after potential config changes
  const apiUrl = provider.buildUrl(useStreaming);

  // If calling Anthropic API directly with OAuth, use native host proxy (bypasses CORS)
  // API key calls try direct fetch first (with dangerous-direct-browser-access header)
  if (apiUrl.includes('api.anthropic.com') && config.authMethod === 'oauth') {
    return await callLLMThroughProxy(messages, onTextChunk, log, currentUrl);
  }

  // If calling Codex API (ChatGPT backend), use the provider's native messaging call
  // CodexProvider has its own call() method that handles native messaging with OpenAI SSE format
  // Falls back to ccproxy if Codex subscription is expired (429)
  if (apiUrl.includes('chatgpt.com') && config.authMethod === 'codex_oauth') {
    try {
      return await provider.call(messages, systemPrompt, tools, onTextChunk, log);
    } catch (e) {
      if (e.message.includes('429') || e.message.includes('usage_limit')) {
        console.log('[API] Codex limit reached, falling back to ccproxy');
        // Switch to ccproxy for the rest of this session (in-memory only)
        config.apiBaseUrl = 'http://127.0.0.1:8000/claude/v1/messages';
        config.authMethod = '';
        config.model = 'claude-haiku-4-5-20251001';
        // Fall through to direct fetch below with ccproxy URL
      } else {
        throw e;
      }
    }
  }

  // Rebuild provider/request if config was changed by Codex fallback
  const activeProvider = createProvider(config.apiBaseUrl || '', config);
  const activeIsClaudeModel = activeProvider.getName() === 'anthropic';
  const activeSystemPrompt = buildSystemPrompt({ isClaudeModel: activeIsClaudeModel });
  const activeTools = getToolsForUrl(currentUrl);
  const activeRequestBody = activeProvider.buildRequestBody(messages, activeSystemPrompt, activeTools, useStreaming);
  const activeApiUrl = activeProvider.buildUrl(useStreaming);

  // Add timeout to prevent hanging requests (2 minutes for API calls)
  const timeoutMs = 120000;
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);

  // Combine user abort signal with timeout — both should cancel the request
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutController.signal])
    : timeoutController.signal;
  const requestBodyStr = JSON.stringify(activeRequestBody);

  const makeRequest = async (headers) => {
    return await fetch(activeApiUrl, {
      method: 'POST',
      headers: headers,
      body: requestBodyStr,
      signal: combinedSignal,
    });
  };

  try {
    apiCallCounter++;
    const callNumber = apiCallCounter;
    const startTime = Date.now();

    let headers = await getApiHeaders();
    let response = await makeRequest(headers);

    // Handle 401 - try refreshing OAuth token and retry once
    if (response.status === 401 && config.authMethod === 'oauth') {
      console.log('[API] callLLM got 401, attempting token refresh...');
      let refreshFailed = false;
      let refreshErrorMsg = null;

      try {
        const tokens = await refreshAccessToken();
        if (tokens) {
          await chrome.storage.local.set({
            oauthAccessToken: tokens.accessToken,
            oauthRefreshToken: tokens.refreshToken,
            oauthExpiresAt: Date.now() + (tokens.expiresIn * 1000)
          });
          headers = await getApiHeaders();
          response = await makeRequest(headers);
          console.log('[API] Token refresh successful, retried request');
        } else {
          refreshFailed = true;
          refreshErrorMsg = 'Token refresh returned null';
        }
      } catch (refreshError) {
        refreshFailed = true;
        refreshErrorMsg = refreshError.message || 'Unknown refresh error';
        console.error('[API] Token refresh failed:', refreshError);
      }

      // If refresh failed and response is still 401, throw descriptive error
      if (refreshFailed && !response.ok) {
        clearTimeout(timeoutId);
        throw new Error(`Authentication failed: OAuth token expired and refresh failed (${refreshErrorMsg}). Please re-authenticate.`);
      }
    }

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      const errorMessage = parseErrorResponse(errorText, response.status);
      throw new Error(errorMessage);
    }

    // Handle response based on streaming mode
    let result;
    if (useStreaming) {
      result = await activeProvider.handleStreaming(response, onTextChunk, log);
    } else {
      const jsonResponse = await response.json();
      result = activeProvider.normalizeResponse(jsonResponse);
    }

    const duration = Date.now() - startTime;
    await log('API', `#${callNumber} ${config.model} → ${result.stop_reason}`, {
      model: config.model,
      messages: messages.length,
      stopReason: result.stop_reason,
      tokens: result.usage,
      duration: `${duration}ms`,
    });

    return result;
  } catch (error) {
    clearTimeout(timeoutId);

    // Distinguish user-initiated abort from timeout
    if (error.name === 'AbortError') {
      if (signal?.aborted) {
        // User/session abort — preserve AbortError identity so callers can detect it
        throw error;
      }
      throw new Error(`API request timed out after ${timeoutMs / 1000} seconds. The model may be overloaded or unavailable.`);
    }

    throw error;
  }
}

/**
 * Parse error response from API
 * @private
 */
function parseErrorResponse(errorText, status) {
  let errorMessage = `API error: ${status}`;

  try {
    const errorJson = JSON.parse(errorText);
    console.error('[API] Error response:', errorJson);

    // OpenAI/OpenRouter format
    if (errorJson.error?.message) {
      errorMessage += ` - ${errorJson.error.message}`;
      if (errorJson.error.code) {
        errorMessage += ` (${errorJson.error.code})`;
      }
      // Include metadata if available (OpenRouter specific)
      if (errorJson.error?.metadata) {
        errorMessage += ` [${JSON.stringify(errorJson.error.metadata)}]`;
      }
    }
    // Anthropic format
    else if (errorJson.error?.type) {
      errorMessage += ` - ${errorJson.error.type}: ${errorJson.error.message || 'Unknown error'}`;
    }
    // Google format or any other error object
    else if (errorJson.error) {
      errorMessage += ` - ${JSON.stringify(errorJson.error)}`;
    }
    // Direct message at top level (some providers)
    else if (errorJson.message) {
      errorMessage += ` - ${errorJson.message}`;
    }
    // Fallback: dump entire response
    else {
      errorMessage += ` - ${errorText.substring(0, 500)}`;
    }
  } catch {
    errorMessage += ` - ${errorText.substring(0, 500)}`;
  }

  return errorMessage;
}
