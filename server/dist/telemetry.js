/**
 * Anonymous telemetry for local MCP users.
 *
 * Collects error reports and usage stats to improve Hanzi.
 * Opt out: `hanzi-browse telemetry off` or set DO_NOT_TRACK=1
 *
 * Never sends: task content, URLs, API keys, file paths, PII.
 */
import * as Sentry from "@sentry/node";
import { PostHog } from "posthog-node";
import { homedir } from "os";
import { join, dirname } from "path";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_DIR = join(homedir(), ".hanzi-browse");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const SENTRY_DSN = "https://2d5504c5db572b0b2709e64f03bdfcc6@o4511120870932480.ingest.us.sentry.io/4511120907698176";
// Public PostHog project API key for the hanzi org (project 318295). Safe to
// ship in the npm package — it only permits event ingest, not reads/queries.
// Override with POSTHOG_API_KEY when testing or routing to a different project.
const DEFAULT_POSTHOG_KEY = "phc_T6BDBkhAIdOY7jESBnMHHQxJRj2MOwXfB40SUvW7MQO";
const POSTHOG_KEY = process.env.POSTHOG_API_KEY || DEFAULT_POSTHOG_KEY;
const POSTHOG_HOST = process.env.POSTHOG_HOST || "https://us.i.posthog.com";
let posthog = null;
let anonymousId = null;
let enabled = false;
let initialized = false;
let version = "0.0.0";
function readConfig() {
    try {
        return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    }
    catch {
        return {};
    }
}
function writeConfig(config) {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}
export function isTelemetryEnabled() {
    if (process.env.DO_NOT_TRACK === "1")
        return false;
    if (process.env.HANZI_TELEMETRY === "0")
        return false;
    const config = readConfig();
    return config.telemetry !== false;
}
export function setTelemetryEnabled(value) {
    const config = readConfig();
    config.telemetry = value;
    writeConfig(config);
}
function getAnonymousId() {
    const config = readConfig();
    if (config.anonymousId)
        return config.anonymousId;
    const id = randomUUID();
    config.anonymousId = id;
    if (config.telemetry === undefined) {
        config.telemetry = true;
        console.error('\x1b[2mHanzi collects anonymous error reports and usage stats to improve the tool.\n' +
            'Run "hanzi-browse telemetry off" to disable.\x1b[0m');
    }
    writeConfig(config);
    return id;
}
export function initTelemetry() {
    if (initialized)
        return;
    initialized = true;
    // Read version from package.json
    try {
        const pkg = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf-8"));
        version = pkg.version || "0.0.0";
    }
    catch { }
    // Don't init SDKs if placeholders haven't been replaced
    if (SENTRY_DSN.startsWith("__") || !POSTHOG_KEY || POSTHOG_KEY.startsWith("__"))
        return;
    enabled = isTelemetryEnabled();
    if (!enabled)
        return;
    anonymousId = getAnonymousId();
    Sentry.init({
        dsn: SENTRY_DSN,
        environment: "local",
        release: `hanzi-browse@${version}`,
        beforeSend(event) {
            if (event.exception?.values) {
                for (const ex of event.exception.values) {
                    if (ex.stacktrace?.frames) {
                        for (const frame of ex.stacktrace.frames) {
                            if (frame.filename) {
                                const match = frame.filename.match(/hanzi-browse\/(.+)/);
                                frame.filename = match ? match[1] : "<scrubbed>";
                            }
                        }
                    }
                }
            }
            delete event.user;
            delete event.server_name;
            event.tags = { ...event.tags, anonymousId };
            return event;
        },
    });
    Sentry.setTag("os", process.platform);
    Sentry.setTag("node_version", process.version);
    posthog = new PostHog(POSTHOG_KEY, { host: POSTHOG_HOST, flushAt: 5, flushInterval: 30000 });
}
export function trackEvent(name, properties) {
    if (!enabled || !posthog || !anonymousId)
        return;
    posthog.capture({
        distinctId: anonymousId,
        event: name,
        properties: {
            version,
            os: process.platform,
            node_version: process.version,
            ...properties,
        },
    });
}
export function captureException(error, context) {
    if (!enabled)
        return;
    Sentry.withScope((scope) => {
        if (context)
            scope.setContext("extra", context);
        scope.captureException(error);
    });
}
export async function shutdownTelemetry() {
    if (!enabled)
        return;
    await Promise.all([
        Sentry.close(2000),
        posthog?.shutdown(),
    ]);
}
