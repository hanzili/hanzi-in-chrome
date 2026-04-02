import type { SessionFileStatus } from './session-files.js';
export declare function buildTaskCompletePayload(sessionId: string, result: unknown): {
    session_id: string;
    status: string;
    result: unknown;
};
export declare function buildTaskErrorPayload(sessionId: string, error: string): {
    session_id: string;
    status: string;
    error: string;
};
export declare function buildStatusPayload(status: SessionFileStatus | SessionFileStatus[]): SessionFileStatus | SessionFileStatus[];
export declare function buildStopPayload(sessionId: string, remove?: boolean): {
    session_id: string;
    status: string;
    removed: boolean;
};
export declare function buildScreenshotPayload(sessionId: string, screenshotPath: string): {
    session_id: string;
    screenshot_path: string;
};
