export function buildTaskCompletePayload(sessionId, result) {
    return {
        session_id: sessionId,
        status: 'completed',
        result,
    };
}
export function buildTaskErrorPayload(sessionId, error) {
    return {
        session_id: sessionId,
        status: 'error',
        error,
    };
}
export function buildStatusPayload(status) {
    return status;
}
export function buildStopPayload(sessionId, remove = false) {
    return {
        session_id: sessionId,
        status: 'stopped',
        removed: remove,
    };
}
export function buildScreenshotPayload(sessionId, screenshotPath) {
    return {
        session_id: sessionId,
        screenshot_path: screenshotPath,
    };
}
