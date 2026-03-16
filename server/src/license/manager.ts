/**
 * License Manager for MCP Server
 *
 * Mirrors the extension's license-manager.js but uses filesystem storage
 * instead of chrome.storage.local. Same constants, same LemonSqueezy API.
 *
 * Free: 100 tasks total
 * Pro: Unlimited ($29 one-time via LemonSqueezy)
 *
 * License key sources (checked in order):
 * 1. HANZI_IN_CHROME_LICENSE_KEY env var
 * 2. ~/.hanzi-in-chrome/mcp-license.json (persisted from previous activation)
 *
 * Storage:
 *   ~/.hanzi-in-chrome/mcp-license.json — { key, valid, instanceId, validatedAt }
 *   ~/.hanzi-in-chrome/mcp-usage.json   — { count }
 */

import fs from "fs";
import os from "os";
import path from "path";

const FREE_TASK_LIMIT = 100;
const LEMON_SQUEEZY_VALIDATE_URL =
  "https://api.lemonsqueezy.com/v1/licenses/validate";
const REVALIDATION_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const OFFLINE_GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const DATA_DIR = path.join(os.homedir(), ".hanzi-in-chrome");
const LICENSE_PATH = path.join(DATA_DIR, "mcp-license.json");
const USAGE_PATH = path.join(DATA_DIR, "mcp-usage.json");

interface LicenseData {
  key: string;
  valid: boolean;
  instanceId: string | null;
  validatedAt: number;
}

interface UsageData {
  count: number;
}

// --- File helpers ---

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readJson<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(filePath: string, data: unknown): void {
  ensureDataDir();
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// --- License data ---

function getLicenseData(): LicenseData | null {
  return readJson<LicenseData>(LICENSE_PATH);
}

function saveLicenseData(data: LicenseData): void {
  writeJson(LICENSE_PATH, data);
}

function getUsageData(): UsageData {
  return readJson<UsageData>(USAGE_PATH) || { count: 0 };
}

function saveUsageData(data: UsageData): void {
  writeJson(USAGE_PATH, data);
}

// --- Public API ---

/**
 * Check if user can run a task, and increment the counter.
 */
export async function checkAndIncrementUsage(): Promise<{
  allowed: boolean;
  remaining: number | null;
  message: string;
}> {
  // Auto-activate from env var if no license exists yet
  const envKey = process.env.HANZI_IN_CHROME_LICENSE_KEY;
  if (envKey && !getLicenseData()) {
    const result = await activateLicense(envKey);
    if (result.success) {
      console.error(`[MCP] Auto-activated license from HANZI_IN_CHROME_LICENSE_KEY`);
    } else {
      console.error(`[MCP] License key from env var invalid: ${result.message}`);
    }
  }

  const license = getLicenseData();

  // Pro user — check if revalidation needed
  if (license && license.valid) {
    const elapsed = Date.now() - (license.validatedAt || 0);

    if (elapsed > REVALIDATION_INTERVAL_MS) {
      const result = await revalidateLicense(license);
      if (!result.valid && elapsed > OFFLINE_GRACE_PERIOD_MS) {
        return {
          allowed: false,
          remaining: 0,
          message:
            "Pro license could not be validated (offline for 7+ days). Please check your internet connection and try again, or set HANZI_IN_CHROME_LICENSE_KEY in your environment.",
        };
      }
    }

    return { allowed: true, remaining: null, message: "Pro — unlimited tasks" };
  }

  // Free tier — check total count
  const usage = getUsageData();

  if (usage.count >= FREE_TASK_LIMIT) {
    return {
      allowed: false,
      remaining: 0,
      message: [
        `You've used all ${FREE_TASK_LIMIT} free tasks.`,
        ``,
        `Upgrade to Pro ($29 one-time) for unlimited tasks:`,
        `  Buy: https://hanziinchrome.lemonsqueezy.com/checkout/buy/14a16cd3-47d7-42c9-a870-b44aa070cc44`,
        `  Then set HANZI_IN_CHROME_LICENSE_KEY=<your-key> in your environment.`,
      ].join("\n"),
    };
  }

  // Increment counter
  usage.count += 1;
  saveUsageData(usage);

  return {
    allowed: true,
    remaining: FREE_TASK_LIMIT - usage.count,
    message: `Free tier: ${usage.count}/${FREE_TASK_LIMIT} tasks used`,
  };
}

/**
 * Activate a license key via LemonSqueezy Validate API.
 */
export async function activateLicense(
  key: string
): Promise<{ success: boolean; message: string }> {
  if (!key || !key.trim()) {
    return { success: false, message: "License key cannot be empty" };
  }

  try {
    const response = await fetch(LEMON_SQUEEZY_VALIDATE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        license_key: key.trim(),
        instance_name: "hanzi-in-chrome",
      }),
    });

    const result = await response.json();

    if (result.valid || result.license_key?.status === "active") {
      const licenseData: LicenseData = {
        key: key.trim(),
        valid: true,
        instanceId: result.instance?.id || null,
        validatedAt: Date.now(),
      };
      saveLicenseData(licenseData);
      return {
        success: true,
        message: "Pro license activated! Unlimited tasks unlocked.",
      };
    }

    return {
      success: false,
      message:
        result.error || "Invalid license key. Please check and try again.",
    };
  } catch (error: any) {
    return {
      success: false,
      message: `Validation failed: ${error.message}. Check your internet connection.`,
    };
  }
}

/**
 * Re-validate an existing license with LemonSqueezy.
 */
async function revalidateLicense(
  license: LicenseData
): Promise<{ valid: boolean }> {
  try {
    const response = await fetch(LEMON_SQUEEZY_VALIDATE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        license_key: license.key,
        instance_id: license.instanceId,
      }),
    });

    const result = await response.json();

    if (result.valid || result.license_key?.status === "active") {
      license.validatedAt = Date.now();
      license.valid = true;
      saveLicenseData(license);
      return { valid: true };
    }

    // License revoked or expired
    license.valid = false;
    saveLicenseData(license);
    return { valid: false };
  } catch {
    // Network error — don't invalidate, rely on grace period
    return { valid: license.valid };
  }
}

/**
 * Get current license status for diagnostics.
 */
export function getLicenseStatus(): {
  isPro: boolean;
  tasksUsed: number;
  taskLimit: number | null;
  message: string;
} {
  const license = getLicenseData();
  const usage = getUsageData();

  if (license && license.valid) {
    return {
      isPro: true,
      tasksUsed: usage.count,
      taskLimit: null,
      message: "Pro — Unlimited tasks",
    };
  }

  return {
    isPro: false,
    tasksUsed: usage.count,
    taskLimit: FREE_TASK_LIMIT,
    message: `Free — ${usage.count}/${FREE_TASK_LIMIT} tasks used`,
  };
}
