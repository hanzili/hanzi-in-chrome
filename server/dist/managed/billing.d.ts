/**
 * Stripe Billing Integration
 *
 * Wired but not yet activated in production (billing env vars not set).
 *
 * What's implemented:
 * - Checkout session creation with workspace metadata
 * - Webhook handlers persist subscription status to workspace
 * - Usage metering called from task completion flow
 * - Plan gating scaffolded in api.ts (soft check, log only — uncomment to enforce)
 * - Customer ID mapped from checkout.session.completed webhook
 *
 * To activate:
 * 1. Set STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_MANAGED_PRICE_ID
 * 2. Optionally set STRIPE_API_METER_ID for usage metering
 * 3. Uncomment the 402 return in api.ts handleCreateTask() to enforce plan gating
 * 4. Run schema migrations (ALTER TABLE workspaces ADD COLUMN ...)
 *
 * Requires env vars:
 * - STRIPE_SECRET_KEY
 * - STRIPE_WEBHOOK_SECRET
 * - STRIPE_MANAGED_PRICE_ID (monthly subscription price)
 * - STRIPE_API_METER_ID (usage meter for API tasks)
 */
import type * as fileStore from "./store.js";
/** Set the backing store so billing can persist webhook results. */
export declare function setBillingStore(store: typeof fileStore): void;
export declare function initBilling(): boolean;
export declare function isBillingEnabled(): boolean;
/**
 * Create a Stripe Checkout session for managed subscription.
 */
export declare function createCheckoutSession(params: {
    workspaceId: string;
    userId: string;
    email?: string;
    successUrl: string;
    cancelUrl: string;
}): Promise<{
    url: string;
}>;
/**
 * Create a Stripe Billing Portal session for managing subscription.
 */
export declare function createPortalSession(params: {
    customerId: string;
    returnUrl: string;
}): Promise<{
    url: string;
}>;
/**
 * Record a completed API task for usage-based billing.
 * Uses Stripe's Billing Meter Events API.
 */
export declare function recordTaskUsage(params: {
    workspaceId: string;
    taskId: string;
    steps: number;
    inputTokens: number;
    outputTokens: number;
}): Promise<void>;
/**
 * Handle Stripe webhook events.
 * Returns true if the event was handled, false if not recognized.
 */
export declare function handleWebhook(rawBody: string, signature: string): Promise<{
    handled: boolean;
    event?: string;
}>;
