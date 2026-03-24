/**
 * Structured JSON logger for the managed platform.
 *
 * All output goes to stderr (same as before) but in JSON format
 * with timestamps, levels, and optional context for correlation.
 */
export interface LogContext {
    requestId?: string;
    workspaceId?: string;
    taskId?: string;
    sessionId?: string;
    [key: string]: any;
}
export declare const log: {
    info: (msg: string, ctx?: LogContext, data?: Record<string, any>) => void;
    warn: (msg: string, ctx?: LogContext, data?: Record<string, any>) => void;
    error: (msg: string, ctx?: LogContext, data?: Record<string, any>) => void;
};
