import type { SessionFileStatus } from './session-files.js';

export function buildTaskCompletePayload(sessionId: string, result: unknown) {
  return {
    session_id: sessionId,
    status: 'completed',
    result,
  };
}

export function buildTaskErrorPayload(sessionId: string, error: string) {
  return {
    session_id: sessionId,
    status: 'error',
    error,
  };
}

export function buildStatusPayload(status: SessionFileStatus | SessionFileStatus[]) {
  return status;
}

export function buildStopPayload(sessionId: string, remove = false) {
  return {
    session_id: sessionId,
    status: 'stopped',
    removed: remove,
  };
}

export function buildScreenshotPayload(sessionId: string, screenshotPath: string) {
  return {
    session_id: sessionId,
    screenshot_path: screenshotPath,
  };
}
