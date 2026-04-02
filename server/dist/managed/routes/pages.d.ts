/**
 * Page & static file routes.
 *
 * Handles: dashboard SPA, docs, embed.js, pairing pages, root redirect.
 * Returns true if the request was handled, false to continue to API routes.
 */
import { IncomingMessage, ServerResponse } from "http";
import type * as fileStore from "../store.js";
/**
 * Try to handle the request as a page/static file route.
 * Returns true if handled (response sent), false otherwise.
 */
export declare function handlePageRoutes(req: IncomingMessage, res: ServerResponse, S: typeof fileStore): Promise<boolean>;
