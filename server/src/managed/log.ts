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

function emit(level: "info" | "warn" | "error", msg: string, ctx?: LogContext, data?: Record<string, any>): void {
  const entry: Record<string, any> = {
    ts: new Date().toISOString(),
    level,
    msg,
  };
  if (ctx) {
    if (ctx.requestId) entry.rid = ctx.requestId;
    if (ctx.workspaceId) entry.wid = ctx.workspaceId;
    if (ctx.taskId) entry.tid = ctx.taskId;
    if (ctx.sessionId) entry.sid = ctx.sessionId;
  }
  if (data) Object.assign(entry, data);
  console.error(JSON.stringify(entry));
}

export const log = {
  info: (msg: string, ctx?: LogContext, data?: Record<string, any>) => emit("info", msg, ctx, data),
  warn: (msg: string, ctx?: LogContext, data?: Record<string, any>) => emit("warn", msg, ctx, data),
  error: (msg: string, ctx?: LogContext, data?: Record<string, any>) => emit("error", msg, ctx, data),
};
