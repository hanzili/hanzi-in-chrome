/**
 * Page & static file routes.
 *
 * Handles: dashboard SPA, docs, embed.js, pairing pages, root redirect.
 * Returns true if the request was handled, false to continue to API routes.
 */
import { existsSync, readFileSync } from "fs";
import { join, extname } from "path";
import { resolveSessionToWorkspace } from "../auth.js";
// Template rendering
const EXTENSION_URL = "https://chromewebstore.google.com/detail/hanzi-browse/iklpkemlmbhemkiojndpbhoakgikpmcd";
const templateDir = join(new URL(import.meta.url).pathname, "../../templates");
function renderTemplate(filename, vars) {
    let html = readFileSync(join(templateDir, filename), "utf-8");
    for (const [key, value] of Object.entries(vars)) {
        html = html.replaceAll(`{{${key}}}`, value);
    }
    return html;
}
function getSelfPairPageHtml(token, host) {
    const apiUrl = host.includes("localhost") ? `http://${host}` : `https://${host}`;
    const safeToken = token.replace(/[<>"'&]/g, "");
    return renderTemplate("pair-self.html", { TOKEN: safeToken, API_URL: apiUrl });
}
function getPairingPageHtml(token, host) {
    const apiUrl = host.includes("localhost") ? `http://${host}` : `https://${host}`;
    const safeToken = token.replace(/[<>"'&]/g, "");
    return renderTemplate("pair.html", { TOKEN: safeToken, API_URL: apiUrl, EXTENSION_URL });
}
const MIME_TYPES = {
    ".html": "text/html", ".js": "application/javascript",
    ".css": "text/css", ".json": "application/json",
    ".svg": "image/svg+xml", ".png": "image/png",
};
/**
 * Try to handle the request as a page/static file route.
 * Returns true if handled (response sent), false otherwise.
 */
export async function handlePageRoutes(req, res, S) {
    const { method, url } = req;
    if (method !== "GET")
        return false;
    // --- Dashboard SPA ---
    if (url?.startsWith("/dashboard")) {
        const thisFile = new URL(import.meta.url).pathname;
        const dashboardDir = join(thisFile, "../../../dashboard");
        const filePath = url === "/dashboard" || url === "/dashboard/"
            ? join(dashboardDir, "index.html")
            : join(dashboardDir, url.replace("/dashboard/", ""));
        if (existsSync(filePath)) {
            const ext = extname(filePath);
            const cacheControl = ext === ".html" ? "no-cache, no-store, must-revalidate" : "public, max-age=31536000, immutable";
            res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream", "Cache-Control": cacheControl });
            res.end(readFileSync(filePath));
            return true;
        }
        // SPA fallback
        const indexPath = join(dashboardDir, "index.html");
        if (existsSync(indexPath)) {
            res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-cache, no-store, must-revalidate" });
            res.end(readFileSync(indexPath));
            return true;
        }
    }
    // --- Root redirect ---
    if (url === "/") {
        const session = await resolveSessionToWorkspace(req);
        if (session) {
            res.writeHead(302, { Location: "/dashboard" });
        }
        else {
            res.writeHead(302, { Location: "https://browse.hanzilla.co" });
        }
        res.end();
        return true;
    }
    // --- Docs ---
    if (url === "/docs.html" || url?.startsWith("/docs.html")) {
        const filePath = join(process.cwd(), "landing", "docs.html");
        if (existsSync(filePath)) {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(readFileSync(filePath));
            return true;
        }
    }
    // --- Embeddable pairing component ---
    if (url === "/embed.js") {
        const embedPath = join(process.cwd(), "landing/embed.js");
        if (existsSync(embedPath)) {
            res.writeHead(200, {
                "Content-Type": "application/javascript",
                "Access-Control-Allow-Origin": "*",
                "Cache-Control": "public, max-age=3600",
            });
            res.end(readFileSync(embedPath));
        }
        else {
            res.writeHead(404);
            res.end("Not found");
        }
        return true;
    }
    // --- Legacy pairing snippet ---
    if (url === "/hanzi-pair.js") {
        const snippetPath = join(process.cwd(), "sdk/hanzi-pair.js");
        if (existsSync(snippetPath)) {
            res.writeHead(200, {
                "Content-Type": "application/javascript",
                "Access-Control-Allow-Origin": "*",
                "Cache-Control": "public, max-age=3600",
            });
            res.end(readFileSync(snippetPath));
        }
        else {
            res.writeHead(404);
            res.end("Not found");
        }
        return true;
    }
    // --- Self-service pairing (/pair-self) ---
    if (url === "/pair-self") {
        const session = await resolveSessionToWorkspace(req);
        if (!session) {
            res.writeHead(302, { Location: "/api/auth/sign-in/social?provider=google&callbackURL=/pair-self" });
            res.end();
            return true;
        }
        try {
            const wsKeys = await S.listApiKeys(session.workspaceId);
            const createdBy = wsKeys.length > 0 ? wsKeys[0].id : session.workspaceId;
            const token = await S.createPairingToken(session.workspaceId, createdBy, { label: "Sidepanel" });
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(getSelfPairPageHtml(token._plainToken, req.headers.host || ""));
        }
        catch (err) {
            res.writeHead(500, { "Content-Type": "text/html" });
            res.end(`<html><body><p>Error: ${err.message}</p><a href="/pair-self">Try again</a></body></html>`);
        }
        return true;
    }
    // --- Hosted pairing page (/pair/:token) ---
    const pairMatch = url?.match(/^\/pair\/(.+)$/);
    if (pairMatch) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(getPairingPageHtml(pairMatch[1], req.headers.host || ""));
        return true;
    }
    return false;
}
