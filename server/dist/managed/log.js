/**
 * Structured JSON logger for the managed platform.
 *
 * All output goes to stderr (same as before) but in JSON format
 * with timestamps, levels, and optional context for correlation.
 */
function emit(level, msg, ctx, data) {
    const entry = {
        ts: new Date().toISOString(),
        level,
        msg,
    };
    if (ctx) {
        if (ctx.requestId)
            entry.rid = ctx.requestId;
        if (ctx.workspaceId)
            entry.wid = ctx.workspaceId;
        if (ctx.taskId)
            entry.tid = ctx.taskId;
        if (ctx.sessionId)
            entry.sid = ctx.sessionId;
    }
    if (data)
        Object.assign(entry, data);
    console.error(JSON.stringify(entry));
}
export const log = {
    info: (msg, ctx, data) => emit("info", msg, ctx, data),
    warn: (msg, ctx, data) => emit("warn", msg, ctx, data),
    error: (msg, ctx, data) => emit("error", msg, ctx, data),
};
