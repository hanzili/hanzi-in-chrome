/**
 * Conversation Compaction Module
 *
 * Prevents context explosion by summarizing conversation when it reaches ~150K tokens.
 * Keeps only recent messages to prevent rate limits.
 */

// Compaction prompt
const ZEPHER_PROMPT = `Your task is to create a detailed summary of the conversation so far, with EXTREME EMPHASIS on preserving ALL user instructions, requirements, and feedback. User instructions are the most critical element and must be preserved verbatim when possible.

Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. CRITICAL - Extract ALL user instructions:
   - The initial task definition (preserve as close to verbatim as possible)
   - Any modifications or clarifications to the task
   - Specific requirements, criteria, or rules they provided
   - Warnings, constraints, or "DO NOT" instructions
   - Any feedback that changed your approach
   - Instructions about how to continue or when to stop

2. Identify if this is a REPEATABLE TASK WORKFLOW:
   - Is there a pattern being repeated (e.g., reviewing multiple candidates, processing multiple items)?
   - What is the atomic unit of work being repeated?
   - What are the specific steps in each iteration?
   - What decision criteria or rules are being applied consistently?

3. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key browser interactions and automation steps
   - Specific details like:
     - URLs visited
     - Elements clicked or interacted with
     - Form data entered
     - Screenshots taken
     - Navigation patterns
   - Errors that you ran into and how you fixed them
   - Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.

4. Double-check that you have captured EVERY user instruction, especially:
   - Initial requirements
   - Process modifications
   - Corrections to your behavior
   - Explicit "IMPORTANT" or emphasized instructions

Your summary should include the following sections:

1. USER INSTRUCTIONS (MOST CRITICAL): Preserve verbatim or as close as possible:
   - Complete initial task definition
   - ALL specific requirements and criteria
   - Every "IMPORTANT", "DO NOT", "ALWAYS", "MUST" instruction
   - Process modifications and corrections
   - Feedback that changed behavior
   - Instructions about when/how to continue

2. Task Template (if applicable): If this is a repeatable workflow, describe:
   - The pattern/template of the repeated task
   - Complete decision criteria and evaluation rules
   - Standard workflow steps for each iteration
   - Example of a completed iteration

3. Constraints and Rules: Organize all user-specified rules:
   - Critical constraints that must never be violated
   - Specific acceptance/rejection criteria
   - Process requirements and warnings
   - Edge cases and exceptions

4. Key Browser Context: Current page URL, domain, and any important page state

5. Pages and Interactions: List all pages visited, elements interacted with, and actions taken

6. Automation Steps: Document the sequence of browser automation steps performed

7. Errors and fixes: List all errors that you ran into, and how you fixed them

8. User Feedback History: Chronological list of:
   - Initial instructions
   - Corrections received
   - Process refinements
   - Confirmations or approvals

9. Progress Tracking: For repeatable tasks:
   - How many items have been processed
   - Where we are in the current iteration
   - Any items that need revisiting

10. Current Work: Describe in detail precisely what was being worked on immediately before this summary request

11. Next Step: For repeatable tasks, specify exactly where to resume (e.g., "Continue reviewing candidates starting with the next one in the queue")

Here's an example of how your output should be structured:

<example>
<analysis>
[Your thought process, identifying if this is a repeatable task, what the pattern is, and ensuring all points are covered thoroughly and accurately]
</analysis>

<summary>
1. USER INSTRUCTIONS (MOST CRITICAL):
   Initial Task: "[Verbatim or near-verbatim initial request from user]"

   Key Requirements:
   - [Specific requirement 1 as stated by user]
   - [Specific requirement 2 as stated by user]

   Critical Constraints:
   - [Any DO NOT instruction from user]
   - [Any MUST/ALWAYS instruction from user]

   User Corrections/Feedback:
   - [Any modification to original instructions]
   - [Any correction to behavior]

2. Task Template (if applicable):
   - Pattern: Processing multiple items from a list/queue
   - Decision Criteria:
     * [Specific criteria for evaluation]
     * [Required qualifications or attributes]
     * [Disqualifying factors]
   - Workflow Steps:
     1. Navigate to item page
     2. Review item details
     3. Evaluate against criteria
     4. Take appropriate action (approve/reject/modify)
     5. Move to next item
   - Example Iteration: [Brief description of one completed cycle]

3. Constraints and Rules:
   - IMPORTANT: [Key instructions that must always be followed]
   - DO NOT: [Actions to avoid]
   - ALWAYS: [Required behaviors]
   - Edge cases: [Special handling instructions]

4. Key Browser Context:
   - Current URL: [Current page URL]
   - Current Domain: [Domain]
   - Page State: [Important state information]

5. Pages and Interactions:
   - [Page/Section]: [Actions taken]
   - [Buttons/Forms]: [Interactions performed]

6. Automation Steps:
   - [Step-by-step workflow description]

7. Errors and fixes:
   - [Error description]: [How it was resolved]
   - [User feedback on errors if any]

8. User Feedback History:
   - Initial: [Complete task definition]
   - Corrections: [Any process refinements]
   - Feedback: [Important guidance received]

9. Progress Tracking:
   - Processed: [Number and summary of items completed]
   - Current: [What's being worked on now]
   - Remaining: [What's left to do]

10. Current Work:
   [Precise description of the immediate task being performed]

11. Next Step:
   [Exactly what should be done next to continue the workflow]

</summary>
</example>

Please provide your summary based on the conversation so far, following this structure and ensuring precision and thoroughness in your response.`;

// Estimate ~800 tokens per image (maxTargetTokens is 768, slight buffer for encoding)
const IMAGE_TOKEN_ESTIMATE = 800;

// Overhead tokens that must be counted but aren't in messages:
// - System prompt: ~1000 tokens
// - Tool definitions: ~5000 tokens (17 tools with detailed schemas)
// - API overhead: ~500 tokens
const OVERHEAD_TOKENS = 6500;

// Threshold for triggering compaction
// Context window is 200K, but we need buffer for:
// - Response generation (max_tokens, typically 10K)
// - Overhead (system prompt, tools)
// - Safety margin for tokenization variance
// Real usable limit: 200K - 10K (response) - 6.5K (overhead) = ~183.5K
const COMPACTION_THRESHOLD = 170000;

/**
 * Estimate tokens for text content
 * Uses ~3.2 chars per token (conservative estimate for mixed content)
 * Actual tokenization varies, but this errs on the safe side
 * @param {string} text - Text to estimate
 * @returns {number} Estimated tokens
 */
function estimateTextTokens(text) {
  if (!text) return 0;
  // Use 3.2 chars/token (conservative) instead of 4 (optimistic)
  return Math.ceil(text.length / 3.2);
}

/**
 * Calculate estimated token count for messages
 * Includes overhead for system prompt and tools
 * @param {Array<Object>} messages - Conversation messages
 * @param {boolean} includeOverhead - Include system prompt/tools overhead (default: true)
 * @returns {number} Estimated token count
 */
export function calculateContextTokens(messages, includeOverhead = true) {
  let total = includeOverhead ? OVERHEAD_TOKENS : 0;

  for (const msg of messages) {
    // String content
    if (typeof msg.content === 'string') {
      total += estimateTextTokens(msg.content);
      continue;
    }

    // Array content (with text and images)
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'image') {
          total += IMAGE_TOKEN_ESTIMATE;
        } else if (block.type === 'text') {
          total += estimateTextTokens(block.text);
        } else if (block.type === 'tool_use') {
          total += estimateTextTokens(JSON.stringify(block));
        } else if (block.type === 'tool_result') {
          // Estimate tool result size
          const resultStr = typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content);
          total += estimateTextTokens(resultStr);
        }
      }
      continue;
    }

    // Fallback: stringify the content
    total += estimateTextTokens(JSON.stringify(msg.content));
  }

  return total;
}

/**
 * Preserve recent context — last N complete turns (user+assistant pairs)
 * plus any user messages with screenshots.
 * This ensures the agent retains recent tool results, page state,
 * and visual context after compaction.
 *
 * @param {Array<Object>} messages - Full conversation history
 * @returns {Array<Object>} Recent messages to preserve
 */
function preserveRecentContext(messages) {
  // Keep the last 6 messages (typically 3 complete user/assistant turns)
  // This preserves the most recent tool calls, results, and page state
  const RECENT_MSG_COUNT = 6;
  const recentMessages = messages.slice(-RECENT_MSG_COUNT);

  // Also grab any earlier user messages with screenshots (up to 2 more)
  const preserved = [];
  let extraScreenshots = 0;
  const recentStartIdx = messages.length - RECENT_MSG_COUNT;

  for (let i = recentStartIdx - 1; i >= 0 && extraScreenshots < 2; i--) {
    const msg = messages[i];
    if (
      msg &&
      msg.role === 'user' &&
      Array.isArray(msg.content) &&
      msg.content.some(
        (block) =>
          block.type === 'image' &&
          block.source &&
          (block.source.type === 'base64' || block.source.data)
      )
    ) {
      preserved.unshift(msg);
      extraScreenshots++;
    }
  }

  return [...preserved, ...recentMessages];
}

/**
 * Extract text content from API response
 * @param {Object} response - API response object
 * @returns {string} Extracted text
 */
function extractTextFromResponse(response) {
  if (!response.content || !Array.isArray(response.content)) {
    return '';
  }

  const textBlocks = response.content.filter((block) => block.type === 'text');

  if (textBlocks.length === 0) {
    return '';
  }

  return textBlocks.map((block) => block.text).join('\n');
}

/**
 * Strip images from messages for summarization
 * Keeps text descriptions but removes base64 image data
 * @param {Array<Object>} messages - Messages to process
 * @returns {Array<Object>} Messages with images replaced by placeholders
 */
function stripImagesForSummarization(messages) {
  return messages.map(msg => {
    if (typeof msg.content === 'string') {
      return msg;
    }

    if (Array.isArray(msg.content)) {
      const strippedContent = msg.content.map(block => {
        if (block.type === 'image') {
          return { type: 'text', text: '[Screenshot was taken here]' };
        }
        return block;
      });
      return { ...msg, content: strippedContent };
    }

    return msg;
  });
}

/**
 * Compact conversation by summarizing old messages
 * Implements compaction strategy
 *
 * @param {Array<Object>} messages - Full conversation history
 * @param {Function} callLLM - Function to call LLM API
 * @param {Function} log - Logging function
 * @returns {Promise<Array<Object>>} Compacted message array
 */
export async function compactConversation(messages, callLLM, log) {
  if (messages.length === 0) {
    throw new Error('Not enough messages to compact');
  }

  const originalTokens = calculateContextTokens(messages);
  await log('COMPACT', `Starting compaction of ${originalTokens.toLocaleString()} tokens...`);

  // Strip images from messages for summarization to avoid token limits
  // We keep only text content for the summary generation
  const messagesForSummary = stripImagesForSummarization(messages);

  // Add summarization request to messages
  const messagesToSummarize = [
    ...messagesForSummary,
    {
      role: 'user',
      content: ZEPHER_PROMPT,
    },
  ];

  // Call LLM to create summary (without images, should fit in context)
  const summaryResponse = await callLLM(messagesToSummarize, null, log);

  // Extract summary text
  const summaryText = extractTextFromResponse(summaryResponse);

  if (!summaryText) {
    throw new Error('No text content in summary response');
  }

  // Format summary for user message
  const formattedSummary = `The conversation history was compressed to save context space. Here's a summary of what we discussed:

${summaryText}

I'll continue from where we left off without asking additional questions.`;

  // Preserve recent context (last 3 user messages with screenshots)
  const recentContext = preserveRecentContext(messages);

  // Build compacted conversation
  // Note: Don't add metadata fields like isCompactionMessage - they'll be rejected by the API
  // Ensure the first message is from 'user' (API requirement) and messages alternate correctly
  const compactedMessages = [
    {
      role: 'user',
      content: formattedSummary,
    },
    {
      role: 'assistant',
      content: 'Understood. I have the full context from the summary above. Continuing from where we left off.',
    },
    ...recentContext,
  ];

  // Ensure valid message alternation (user/assistant must alternate)
  // Fix any consecutive same-role messages from recentContext
  for (let i = 1; i < compactedMessages.length; i++) {
    if (compactedMessages[i].role === compactedMessages[i - 1].role) {
      if (compactedMessages[i].role === 'user') {
        // Insert a minimal assistant message to fix alternation
        compactedMessages.splice(i, 0, { role: 'assistant', content: 'Continuing.' });
        i++; // Skip the inserted message
      } else {
        // Insert a minimal user message to fix alternation
        compactedMessages.splice(i, 0, { role: 'user', content: 'Continue.' });
        i++;
      }
    }
  }

  const newTokens = calculateContextTokens(compactedMessages);

  await log('COMPACT', `${messages.length} msgs → ${compactedMessages.length} msgs`, {
    beforeTokens: originalTokens,
    afterTokens: newTokens,
    reduction: `${Math.round(((originalTokens - newTokens) / originalTokens) * 100)}%`,
  });

  return compactedMessages;
}

/**
 * Emergency compaction - just keep recent messages without summarization
 * Used when normal compaction fails (e.g., API error)
 * @param {Array<Object>} messages - Full conversation
 * @param {Function} log - Logging function
 * @returns {Promise<Array<Object>>} Truncated messages
 */
async function emergencyCompact(messages, log) {
  // Keep only the last few messages with images
  const recentContext = preserveRecentContext(messages);

  const compacted = [
    {
      role: 'assistant',
      content: 'Previous conversation was truncated due to length. I\'ll continue from the recent context.',
    },
    ...recentContext,
  ];

  await log('COMPACT', `Emergency compact: ${messages.length} msgs → ${compacted.length} msgs`);
  return compacted;
}

/**
 * Check if conversation needs compaction and compact if needed
 * Call this in your agent loop before each API call
 *
 * @param {Array<Object>} messages - Current conversation
 * @param {Function} callLLM - Function to call LLM API
 * @param {Function} log - Logging function
 * @returns {Promise<Array<Object>>} Original or compacted messages
 */
export async function compactIfNeeded(messages, callLLM, log) {
  const tokens = calculateContextTokens(messages);

  // Log token count periodically for debugging
  if (tokens > 100000) {
    await log('COMPACT', `Context size: ${tokens.toLocaleString()} tokens (threshold: ${COMPACTION_THRESHOLD.toLocaleString()})`);
  }

  if (tokens < COMPACTION_THRESHOLD) {
    return messages;
  }

  await log('COMPACT', `Context at ${tokens.toLocaleString()} tokens, compacting...`);

  try {
    return await compactConversation(messages, callLLM, log);
  } catch (error) {
    // If compaction fails (e.g., API error during summarization), do emergency compact
    await log('COMPACT', `Compaction failed: ${error.message}. Using emergency compact.`);
    return await emergencyCompact(messages, log);
  }
}
