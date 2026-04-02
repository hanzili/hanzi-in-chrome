/**
 * Authenticated API route handlers.
 *
 * Each handler function takes the request context and returns true if it handled the request.
 * Extracted from the monolithic handleRequest() to improve readability.
 */
import { IncomingMessage, ServerResponse } from "http";
import type { ApiKey } from "../store.js";
import type * as fileStore from "../store.js";
type RouteContext = {
    req: IncomingMessage;
    res: ServerResponse;
    method: string;
    url: string;
    apiKey: ApiKey;
    requestId: string;
    S: typeof fileStore;
    sendJson: (req: IncomingMessage, res: ServerResponse, status: number, data: any) => void;
    parseBody: (req: IncomingMessage) => Promise<any>;
    rejectPublishable: (apiKey: ApiKey, req: IncomingMessage, res: ServerResponse, action: string) => boolean;
    isSessionConnectedFn: ((id: string) => boolean) | null;
    taskAborts: Map<string, AbortController>;
    taskWorkspaceMap: Map<string, {
        workspaceId: string;
        startedAt: number;
    }>;
    handleCreateTask: (body: any, apiKey: ApiKey, requestId?: string) => Promise<{
        status: number;
        data: any;
    }>;
    runInternalTask: (params: {
        workspaceId: string;
        browserSessionId: string;
        task: string;
        url?: string;
    }) => Promise<any>;
};
/** Browser session routes: /v1/browser-sessions/* */
export declare function handleSessionRoutes(ctx: RouteContext): Promise<boolean>;
/** Task routes: /v1/tasks/* */
export declare function handleTaskRoutes(ctx: RouteContext): Promise<boolean>;
/** API key + usage + billing routes */
export declare function handleKeyAndBillingRoutes(ctx: RouteContext): Promise<boolean>;
export {};
