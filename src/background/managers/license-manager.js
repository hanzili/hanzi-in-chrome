/**
 * License Manager
 *
 * Enforces daily task limits for free tier, validates Pro licenses via Lemon Squeezy.
 *
 * Free: 10 tasks/day (resets at UTC midnight)
 * Pro: Unlimited ($29 one-time via Lemon Squeezy)
 *
 * License state stored in chrome.storage.local:
 *   license_data: { key, valid, instanceId, validatedAt }
 *   usage_YYYY-MM-DD: { count }
 */

const FREE_TASK_LIMIT = 100;
const LEMON_SQUEEZY_VALIDATE_URL = 'https://api.lemonsqueezy.com/v1/licenses/validate';
const REVALIDATION_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const OFFLINE_GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const USAGE_KEY = 'usage_total';

/**
 * Check if user can run a task, and increment the daily counter.
 * @returns {{ allowed: boolean, remaining: number|null, message: string }}
 */
export async function checkAndIncrementUsage() {
  const license = await getLicenseData();

  // Pro user — check if revalidation needed
  if (license && license.valid) {
    const elapsed = Date.now() - (license.validatedAt || 0);

    if (elapsed > REVALIDATION_INTERVAL_MS) {
      // Try to revalidate in background
      const result = await revalidateLicense(license);
      if (!result.valid && elapsed > OFFLINE_GRACE_PERIOD_MS) {
        // Grace period expired and can't validate
        return { allowed: false, remaining: 0, message: 'Pro license could not be validated (offline for 7+ days). Please check your internet connection and try again, or re-enter your license key in Settings > License.' };
      }
      // Either revalidation succeeded or we're still within grace period
    }

    return { allowed: true, remaining: null, message: 'Pro — unlimited tasks' };
  }

  // Free tier — check total count
  const data = await chrome.storage.local.get(USAGE_KEY);
  const usage = data[USAGE_KEY] || { count: 0 };

  if (usage.count >= FREE_TASK_LIMIT) {
    return {
      allowed: false,
      remaining: 0,
      message: [
        `You've used all ${FREE_TASK_LIMIT} free tasks.`,
        ``,
        `Upgrade to Pro ($29 one-time) for unlimited tasks:`,
        `  Buy: https://hanziinchrome.lemonsqueezy.com/checkout/buy/5f9be29a-b862-43bf-a440-b4a3cdc9b28e`,
        `  Then activate your key in the extension Settings > License tab,`,
        `  or set HANZI_IN_CHROME_LICENSE_KEY in your environment.`,
      ].join('\n'),
    };
  }

  // Increment counter
  usage.count += 1;
  await chrome.storage.local.set({ [USAGE_KEY]: usage });

  return {
    allowed: true,
    remaining: FREE_TASK_LIMIT - usage.count,
    message: `Free tier: ${usage.count}/${FREE_TASK_LIMIT} tasks used`
  };
}

/**
 * Activate a license key via Lemon Squeezy Validate API.
 * @param {string} key - License key from Lemon Squeezy
 * @returns {{ success: boolean, message: string }}
 */
export async function activateLicense(key) {
  if (!key || !key.trim()) {
    return { success: false, message: 'License key cannot be empty' };
  }

  try {
    const response = await fetch(LEMON_SQUEEZY_VALIDATE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ license_key: key.trim(), instance_name: 'hanzi-in-chrome' }),
    });

    const result = await response.json();

    if (result.valid || result.license_key?.status === 'active') {
      const licenseData = {
        key: key.trim(),
        valid: true,
        instanceId: result.instance?.id || null,
        validatedAt: Date.now(),
      };
      await chrome.storage.local.set({ license_data: licenseData });
      return { success: true, message: 'Pro license activated! Unlimited tasks unlocked.' };
    }

    return { success: false, message: result.error || 'Invalid license key. Please check and try again.' };
  } catch (error) {
    return { success: false, message: `Validation failed: ${error.message}. Check your internet connection.` };
  }
}

/**
 * Get current license status for display in settings UI.
 * @returns {{ isPro: boolean, key: string|null, tasksUsedToday: number, dailyLimit: number, message: string }}
 */
export async function getLicenseStatus() {
  const license = await getLicenseData();
  const data = await chrome.storage.local.get(USAGE_KEY);
  const usage = data[USAGE_KEY] || { count: 0 };

  if (license && license.valid) {
    return {
      isPro: true,
      key: license.key,
      tasksUsed: usage.count,
      taskLimit: null,
      message: 'Pro — Unlimited tasks',
    };
  }

  return {
    isPro: false,
    key: null,
    tasksUsed: usage.count,
    taskLimit: FREE_TASK_LIMIT,
    message: `Free — ${usage.count}/${FREE_TASK_LIMIT} tasks used`,
  };
}

/**
 * Remove the stored license (for UI "Deactivate" action).
 */
export async function deactivateLicense() {
  await chrome.storage.local.remove('license_data');
  return { success: true, message: 'License deactivated.' };
}

// --- Internal helpers ---

async function getLicenseData() {
  const data = await chrome.storage.local.get('license_data');
  return data.license_data || null;
}

async function revalidateLicense(license) {
  try {
    const response = await fetch(LEMON_SQUEEZY_VALIDATE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ license_key: license.key, instance_id: license.instanceId }),
    });

    const result = await response.json();

    if (result.valid || result.license_key?.status === 'active') {
      license.validatedAt = Date.now();
      license.valid = true;
      await chrome.storage.local.set({ license_data: license });
      return { valid: true };
    }

    // License revoked or expired
    license.valid = false;
    await chrome.storage.local.set({ license_data: license });
    return { valid: false };
  } catch {
    // Network error — don't invalidate, rely on grace period
    return { valid: license.valid };
  }
}
