/**
 * Session Files Module
 *
 * Manages file-based session storage for the CLI.
 * Sessions are stored as JSON files in ~/.hanzi-in-chrome/sessions/
 */
export interface SessionFileStatus {
    session_id: string;
    status: 'starting' | 'running' | 'complete' | 'error' | 'stopped';
    task: string;
    url?: string;
    context?: string;
    started_at: string;
    updated_at: string;
    result?: string;
    error?: string;
}
export declare function ensureSessionDir(): void;
export declare function getSessionFilePath(sessionId: string): string;
export declare function getSessionLogPath(sessionId: string): string;
export declare function getSessionScreenshotPath(sessionId: string): string;
export declare function writeSessionStatus(sessionId: string, status: Partial<SessionFileStatus>): void;
export declare function readSessionStatus(sessionId: string): SessionFileStatus | null;
export declare function appendSessionLog(sessionId: string, message: string): void;
export declare function readSessionLog(sessionId: string, lines?: number): string;
export declare function listSessions(): SessionFileStatus[];
export declare function listActiveSessions(): SessionFileStatus[];
export declare function deleteSessionFiles(sessionId: string): boolean;
