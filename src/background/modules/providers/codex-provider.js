/**
 * Codex Provider
 * Handles Codex/ChatGPT Pro API through native messaging proxy
 *
 * Uses OAuth credentials from Codex CLI (~/.codex/auth.json)
 * Routes through native host to bypass CORS and use authenticated requests
 */

import { BaseProvider } from './base-provider.js';
import { filterClaudeOnlyTools } from '../../../tools/definitions.js';

const NATIVE_HOST_NAME = 'com.hanzi_in_chrome.oauth_host';
const CODEX_API_URL = 'https://chatgpt.com/backend-api/codex/responses';

export class CodexProvider extends BaseProvider {
  getName() {
    return 'codex';
  }

  static matchesUrl(baseUrl) {
    return baseUrl.includes('chatgpt.com') || baseUrl.includes('codex');
  }

  getHeaders() {
    // Headers are handled by native host using stored credentials
    return {
      'Content-Type': 'application/json',
    };
  }

  buildUrl(_useStreaming) {
    return CODEX_API_URL;
  }

  buildRequestBody(messages, systemPrompt, tools, _useStreaming) {
    // Extract text from systemPrompt array (Anthropic format)
    const systemText = Array.isArray(systemPrompt)
      ? systemPrompt.map(p => p.text).join('\n\n')
      : systemPrompt;

    // Convert messages to Responses API "input" format
    const input = this._convertToResponsesInput(messages);

    // Codex uses Responses API format (not chat completions)
    // Required: store=false, stream=true (Codex backend requires these)
    return {
      model: this.config.model || 'gpt-5.1-codex-max',
      instructions: systemText,
      input: input,
      tools: this._convertToolsForResponses(tools),
      stream: true,  // Codex backend requires stream=true
      store: false,  // Required by Codex API
    };
  }

  /**
   * Override call method to use native messaging proxy
   */
  async call(messages, systemPrompt, tools, onTextChunk, log) {
    const useStreaming = !!onTextChunk;
    const requestBody = this.buildRequestBody(messages, systemPrompt, tools, useStreaming);
    const url = this.buildUrl(useStreaming);

    await log?.('DEBUG', 'Codex API call through proxy', {
      url,
      model: requestBody.model,
      messageCount: messages.length,
      streaming: useStreaming,
    });

    return new Promise((resolve, reject) => {
      let port = null;
      let result = {
        content: [],
        usage: null,
        stop_reason: 'end_turn',
      };
      let currentText = '';
      let itemsById = {};  // Track Responses API items by id

      try {
        port = chrome.runtime.connectNative(NATIVE_HOST_NAME);

        port.onMessage.addListener(async (message) => {
          if (message.type === 'stream_chunk') {
            // Handle Responses API streaming events
            const event = message.data;

            // response.output_item.added - new item (text or function_call)
            if (event.type === 'response.output_item.added') {
              const item = event.item;
              if (item) {
                itemsById[item.id] = {
                  id: item.id,
                  type: item.type,
                  call_id: item.call_id,
                  name: item.name || '',
                  arguments: item.arguments || '',
                };
              }

            // response.output_item.done - finalized item with complete data
            } else if (event.type === 'response.output_item.done') {
              const item = event.item;
              if (item && item.type === 'function_call') {
                itemsById[item.id] = {
                  id: item.id,
                  type: item.type,
                  call_id: item.call_id,
                  name: item.name || '',
                  arguments: item.arguments || '',
                };
              }

            // response.output_text.delta - text streaming
            } else if (event.type === 'response.output_text.delta') {
              const text = event.delta || '';
              currentText += text;
              if (onTextChunk) onTextChunk(text);

            // response.function_call_arguments.delta - argument fragments
            } else if (event.type === 'response.function_call_arguments.delta') {
              const itemId = event.item_id;
              if (itemId && itemsById[itemId]) {
                itemsById[itemId].arguments += event.delta || '';
              }

            // response.function_call_arguments.done - complete arguments
            } else if (event.type === 'response.function_call_arguments.done') {
              const itemId = event.item_id;
              if (itemId && itemsById[itemId]) {
                itemsById[itemId].arguments = event.arguments || '';
              }

            // response.completed - final response
            } else if (event.type === 'response.completed') {
              const response = event.response;
              if (response?.usage) {
                result.usage = response.usage;
              }
              if (response?.status === 'incomplete') {
                result.stop_reason = 'max_tokens';
              }
              // Extract output items from completed response
              if (response?.output) {
                for (const item of response.output) {
                  if (item.type === 'function_call') {
                    itemsById[item.id] = {
                      id: item.id,
                      type: item.type,
                      call_id: item.call_id,
                      name: item.name,
                      arguments: item.arguments || '',
                    };
                  }
                }
              }
            }

            // Handle usage in chunk
            if (event.usage) {
              result.usage = event.usage;
            }

          } else if (message.type === 'stream_end') {
            // Finalize streaming response
            if (currentText) {
              result.content.push({ type: 'text', text: currentText });
            }

            // Add function calls from tracked items
            let hasToolCalls = false;
            for (const item of Object.values(itemsById)) {
              // Only include function_call items with a valid name
              if (item.type === 'function_call' && item.name) {
                let parsedArgs = {};
                try {
                  parsedArgs = JSON.parse(item.arguments || '{}');
                } catch (e) {
                  parsedArgs = {};
                }

                result.content.push({
                  type: 'tool_use',
                  id: item.call_id || item.id,
                  name: item.name,
                  input: parsedArgs,
                });
                hasToolCalls = true;
              }
            }

            // Set stop reason based on content
            if (hasToolCalls) {
              result.stop_reason = 'tool_use';
            }

            // Ensure content is never empty
            if (result.content.length === 0) {
              result.content.push({ type: 'text', text: '' });
            }

            if (port) port.disconnect();
            resolve(result);

          } else if (message.type === 'api_response') {
            // Handle non-streaming response
            if (message.status >= 400) {
              if (port) port.disconnect();
              reject(new Error(`Codex API error: ${message.status} - ${message.body}`));
              return;
            }

            try {
              const response = JSON.parse(message.body);
              const normalized = this.normalizeResponse(response);
              if (port) port.disconnect();
              resolve(normalized);
            } catch (e) {
              if (port) port.disconnect();
              reject(new Error(`Failed to parse Codex response: ${e.message}`));
            }

          } else if (message.type === 'api_error') {
            if (port) port.disconnect();
            reject(new Error(message.error));
          }
        });

        port.onDisconnect.addListener(() => {
          if (chrome.runtime.lastError) {
            reject(new Error(`Native host error: ${chrome.runtime.lastError.message}`));
          }
        });

        // Send API request through proxy
        port.postMessage({
          type: 'proxy_api_call',
          data: {
            url: url,
            method: 'POST',
            body: JSON.stringify(requestBody),
            headers: this.getHeaders(),
          },
        });

      } catch (error) {
        if (port) port.disconnect();
        reject(new Error(`Failed to connect to native host: ${error.message}`));
      }
    });
  }

  normalizeResponse(response) {
    const content = [];
    let stopReason = 'end_turn';

    // Handle Responses API format (has "output" array)
    if (response.output) {
      for (const item of response.output) {
        if (item.type === 'message' && item.role === 'assistant') {
          // Extract text from message content
          for (const part of item.content || []) {
            if (part.type === 'output_text' && part.text) {
              content.push({ type: 'text', text: part.text });
            }
          }
        } else if (item.type === 'function_call') {
          // Convert function_call to tool_use
          let parsedArgs = {};
          try {
            parsedArgs = typeof item.arguments === 'string'
              ? JSON.parse(item.arguments)
              : item.arguments || {};
          } catch (e) {
            parsedArgs = {};
          }

          content.push({
            type: 'tool_use',
            id: item.call_id,
            name: item.name,
            input: parsedArgs,
          });
          stopReason = 'tool_use';
        }
      }

      // Map status to stop_reason
      if (response.status === 'incomplete') {
        stopReason = 'max_tokens';
      }

    } else if (response.choices?.[0]?.message) {
      // Fallback: Handle legacy chat completions format
      const message = response.choices[0].message;

      if (message.content) {
        content.push({ type: 'text', text: message.content });
      }

      if (message.tool_calls) {
        for (const toolCall of message.tool_calls) {
          content.push({
            type: 'tool_use',
            id: toolCall.id,
            name: toolCall.function.name,
            input: typeof toolCall.function.arguments === 'string'
              ? JSON.parse(toolCall.function.arguments)
              : toolCall.function.arguments,
          });
        }
        stopReason = 'tool_use';
      }

      const finishReason = response.choices[0].finish_reason;
      if (finishReason === 'length') {
        stopReason = 'max_tokens';
      }
    } else {
      throw new Error(`Unexpected Codex response format: ${JSON.stringify(response).substring(0, 200)}`);
    }

    // Ensure content is never empty
    if (content.length === 0) {
      content.push({ type: 'text', text: '' });
    }

    return {
      content,
      stop_reason: stopReason,
      usage: response.usage,
    };
  }

  /**
   * Convert tools to Responses API format
   * Filters out Claude-only tools that don't work with OpenAI models
   * @private
   */
  _convertToolsForResponses(anthropicTools) {
    if (!anthropicTools || anthropicTools.length === 0) return [];

    // Filter out Claude-only tools (like turn_answer_start)
    const filteredTools = filterClaudeOnlyTools(anthropicTools);

    return filteredTools.map(tool => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    }));
  }

  /**
   * Convert Anthropic messages to Responses API "input" format
   * Converts full conversation history for multi-turn support
   * @private
   */
  _convertToResponsesInput(anthropicMessages) {
    const input = [];

    for (const msg of anthropicMessages) {
      if (msg.role === 'user') {
        // User message - could be text or tool results
        if (typeof msg.content === 'string') {
          input.push({
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: msg.content }],
          });
        } else if (Array.isArray(msg.content)) {
          // Check if it's tool results or regular text
          const toolResults = msg.content.filter(b => b.type === 'tool_result');
          const textBlocks = msg.content.filter(b => b.type === 'text');

          // Add tool results as function_call_output
          for (const result of toolResults) {
            let output = result.content;
            if (Array.isArray(result.content)) {
              // Extract text from array content (skip images for now)
              output = result.content
                .filter(c => c.type === 'text')
                .map(c => c.text)
                .join('\n');
            }
            input.push({
              type: 'function_call_output',
              call_id: result.tool_use_id,
              output: typeof output === 'string' ? output : JSON.stringify(output),
            });
          }

          // Add text blocks as user message
          if (textBlocks.length > 0) {
            const text = textBlocks.map(b => b.text).join('\n');
            input.push({
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text }],
            });
          }
        }
      } else if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        // Assistant message - could have text and/or tool calls
        const textBlocks = msg.content.filter(b => b.type === 'text');
        const toolUses = msg.content.filter(b => b.type === 'tool_use');

        // Add text response if present
        if (textBlocks.length > 0) {
          const text = textBlocks.map(b => b.text).join('\n');
          if (text.trim()) {
            input.push({
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text }],
            });
          }
        }

        // Add function calls
        for (const toolUse of toolUses) {
          input.push({
            type: 'function_call',
            call_id: toolUse.id,
            name: toolUse.name,
            arguments: JSON.stringify(toolUse.input),
          });
        }
      }
    }

    return input;
  }
}
