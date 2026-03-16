/**
 * OpenAI API Provider
 * Handles GPT-4, GPT-4o, and compatible APIs
 */

import { BaseProvider } from './base-provider.js';
import { filterClaudeOnlyTools } from '../../../tools/definitions.js';

export class OpenAIProvider extends BaseProvider {
  getName() {
    return 'openai';
  }

  static matchesUrl(baseUrl) {
    return baseUrl.includes('openai.com')
      || baseUrl.includes('/v1/chat/completions')
      || baseUrl.includes('localhost:11434')
      || baseUrl.includes('127.0.0.1:11434');
  }

  getHeaders() {
    const headers = {
      'Content-Type': 'application/json',
    };

    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }

    return headers;
  }

  buildUrl(_useStreaming) {
    return this.config.apiBaseUrl;
  }

  buildRequestBody(messages, systemPrompt, tools, useStreaming) {
    const convertedMessages = this._convertMessages(messages);

    // Extract text from systemPrompt array (Anthropic format)
    const systemText = Array.isArray(systemPrompt)
      ? systemPrompt.map(p => p.text).join('\n\n')
      : systemPrompt;

    const openaiMessages = [
      { role: 'system', content: systemText },
      ...convertedMessages,
    ];

    return {
      model: this.config.model,
      max_completion_tokens: this.config.maxTokens || 10000,
      messages: openaiMessages,
      tools: this._convertTools(tools),
      stream: useStreaming,
    };
  }

  normalizeResponse(response) {
    const message = response.choices?.[0]?.message;
    if (!message) {
      throw new Error(`Unexpected OpenAI response format: ${JSON.stringify(response).substring(0, 200)}`);
    }

    const content = [];

    // Add text content
    if (message.content) {
      content.push({ type: 'text', text: message.content });
    }

    // Add tool calls
    if (message.tool_calls) {
      for (const toolCall of message.tool_calls) {
        const toolUseBlock = {
          type: 'tool_use',
          id: toolCall.id,
          name: toolCall.function.name,
          input: typeof toolCall.function.arguments === 'string'
            ? JSON.parse(toolCall.function.arguments)
            : toolCall.function.arguments,
        };

        // Preserve reasoning for Kimi K2.5
        if (message.reasoning) {
          toolUseBlock.reasoning = message.reasoning;
        }
        if (message.reasoning_details) {
          toolUseBlock.reasoning_details = message.reasoning_details;
        }

        content.push(toolUseBlock);
      }
    }

    // Ensure content is never empty
    if (content.length === 0) {
      content.push({ type: 'text', text: '' });
    }

    // Map OpenAI finish_reason to Anthropic stop_reason
    let stopReason = 'end_turn';
    const finishReason = response.choices?.[0]?.finish_reason;
    if (finishReason === 'length') {
      stopReason = 'max_tokens';
    } else if (finishReason === 'tool_calls') {
      stopReason = 'tool_use';
    }

    const normalized = {
      content,
      stop_reason: stopReason,
      usage: response.usage,
    };

    // Store reasoning fields at the top level for easier access
    if (message.reasoning) {
      normalized.reasoning = message.reasoning;
    }
    if (message.reasoning_details) {
      normalized.reasoning_details = message.reasoning_details;
    }

    return normalized;
  }

  async handleStreaming(response, onTextChunk, _log) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let result = {
      content: [],
      usage: null,
    };

    let currentText = '';
    let toolCalls = {}; // Track by index
    let finishReason = null;
    let reasoning = null; // For Kimi K2.5
    let reasoningDetails = null; // For Kimi K2.5
    let buffer = '';

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') continue;

        try {
          const chunk = JSON.parse(data);
          const choice = chunk.choices?.[0];
          if (!choice) continue;

          const delta = choice.delta;

          // Handle text content
          if (delta.content) {
            currentText += delta.content;
            if (onTextChunk) onTextChunk(delta.content);
          }

          // Handle tool calls
          if (delta.tool_calls) {
            for (const toolCall of delta.tool_calls) {
              const index = toolCall.index;

              if (!toolCalls[index]) {
                toolCalls[index] = {
                  id: toolCall.id || `call_${Date.now()}_${index}`,
                  name: toolCall.function?.name || '',
                  arguments: '',
                };
              }

              if (toolCall.function?.name) {
                toolCalls[index].name = toolCall.function.name;
              }
              if (toolCall.function?.arguments) {
                toolCalls[index].arguments += toolCall.function.arguments;
              }
            }
          }

          // Handle finish reason
          if (choice.finish_reason) {
            finishReason = choice.finish_reason;
          }

          // Handle usage (may be in final chunk)
          if (chunk.usage) {
            result.usage = chunk.usage;
          }

          // Handle reasoning for Kimi K2.5 (may be in delta or full message)
          if (delta.reasoning && !reasoning) {
            reasoning = delta.reasoning;
          }
          if (delta.reasoning_details && !reasoningDetails) {
            reasoningDetails = delta.reasoning_details;
          }
          // Also check the full message (some providers send it there)
          if (choice.message?.reasoning && !reasoning) {
            reasoning = choice.message.reasoning;
          }
          if (choice.message?.reasoning_details && !reasoningDetails) {
            reasoningDetails = choice.message.reasoning_details;
          }
        } catch (e) {
          // Ignore JSON parse errors for malformed chunks
        }
      }
    }

    // Build content array
    if (currentText) {
      result.content.push({ type: 'text', text: currentText });
    }

    // Add tool calls
    for (const toolCall of Object.values(toolCalls)) {
      let parsedArgs = {};
      try {
        parsedArgs = JSON.parse(toolCall.arguments);
      } catch (e) {
        parsedArgs = {};
      }

      const toolUseBlock = {
        type: 'tool_use',
        id: toolCall.id,
        name: toolCall.name,
        input: parsedArgs,
      };

      // Preserve reasoning for Kimi K2.5
      if (reasoning) {
        toolUseBlock.reasoning = reasoning;
      }
      if (reasoningDetails) {
        toolUseBlock.reasoning_details = reasoningDetails;
      }

      result.content.push(toolUseBlock);
    }

    // Ensure content is never empty
    if (result.content.length === 0) {
      result.content.push({ type: 'text', text: '' });
    }

    // Map finish_reason to stop_reason
    let stopReason = 'end_turn';
    if (finishReason === 'length') {
      stopReason = 'max_tokens';
    } else if (finishReason === 'tool_calls') {
      stopReason = 'tool_use';
    }
    result.stop_reason = stopReason;

    // Store reasoning fields at the top level for easier access (Kimi K2.5)
    if (reasoning) {
      result.reasoning = reasoning;
    }
    if (reasoningDetails) {
      result.reasoning_details = reasoningDetails;
    }

    return result;
  }

  /**
   * Convert Anthropic tools to OpenAI format
   * Filters out Claude-only tools that don't work with OpenAI models
   * @private
   */
  _convertTools(anthropicTools) {
    if (!anthropicTools || anthropicTools.length === 0) return [];

    // Filter out Claude-only tools (like turn_answer_start, update_plan)
    const filteredTools = filterClaudeOnlyTools(anthropicTools);

    return filteredTools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    }));
  }

  /**
   * Convert Anthropic messages to OpenAI format
   * @private
   */
  _convertMessages(anthropicMessages) {
    const openaiMessages = [];

    for (const msg of anthropicMessages) {
      // Simple string content - keep as is
      if (typeof msg.content === 'string') {
        openaiMessages.push({
          role: msg.role,
          content: msg.content,
        });
        continue;
      }

      // Array content - need to convert blocks
      if (Array.isArray(msg.content)) {
        if (msg.role === 'assistant') {
          // Assistant message with content blocks
          let textContent = '';
          const toolCalls = [];
          let reasoning = null;
          let reasoningDetails = null;

          for (const block of msg.content) {
            if (block.type === 'text') {
              textContent += block.text;
            } else if (block.type === 'tool_use') {
              toolCalls.push({
                id: block.id,
                type: 'function',
                function: {
                  name: block.name,
                  arguments: JSON.stringify(block.input),
                },
              });

              // Preserve reasoning fields for Kimi K2.5
              if (block.reasoning && !reasoning) {
                reasoning = block.reasoning;
              }
              if (block.reasoning_details && !reasoningDetails) {
                reasoningDetails = block.reasoning_details;
              }
            }
          }

          const assistantMsg = {
            role: 'assistant',
            content: textContent || null,
          };
          if (toolCalls.length > 0) {
            assistantMsg.tool_calls = toolCalls;
          }

          // Include reasoning fields for Kimi K2.5 if present
          // Kimi RETURNS "reasoning" but EXPECTS "reasoning_content" when sending back
          if (reasoning) {
            assistantMsg.reasoning_content = reasoning;
          }
          if (reasoningDetails) {
            assistantMsg.reasoning_details = reasoningDetails;
          }

          openaiMessages.push(assistantMsg);

        } else if (msg.role === 'user') {
          // User message with tool results
          for (const block of msg.content) {
            if (block.type === 'tool_result') {
              // OpenAI expects role: 'tool' with tool_call_id
              let content = '';
              if (typeof block.content === 'string') {
                content = block.content;
              } else if (Array.isArray(block.content)) {
                // Handle array content (e.g., text + image)
                content = block.content
                  .filter(c => c.type === 'text')
                  .map(c => c.text)
                  .join('\n');
              }

              openaiMessages.push({
                role: 'tool',
                tool_call_id: block.tool_use_id,
                content: content,
              });
            } else if (block.type === 'text') {
              // Regular text in user message
              openaiMessages.push({
                role: 'user',
                content: block.text,
              });
            }
          }
        }
      }
    }

    return openaiMessages;
  }
}
