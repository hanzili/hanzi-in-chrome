/**
 * System prompt for server-side managed agent loop.
 */
export declare function buildSystemPrompt(taskUrl?: string): Array<{
    type: "text";
    text: string;
}>;
