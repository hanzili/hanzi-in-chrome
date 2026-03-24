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
import Stripe from "stripe";
import { log } from "./log.js";
let stripe = null;
let S = null;
/** Set the backing store so billing can persist webhook results. */
export function setBillingStore(store) {
    S = store;
}
export function initBilling() {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) {
        log.info("No STRIPE_SECRET_KEY — billing disabled");
        return false;
    }
    stripe = new Stripe(key);
    log.info("Stripe billing initialized");
    return true;
}
export function isBillingEnabled() {
    return stripe !== null;
}
// --- Checkout ---
/**
 * Create a Stripe Checkout session for managed subscription.
 */
export async function createCheckoutSession(params) {
    if (!stripe || !S)
        throw new Error("Billing not configured");
    const priceId = process.env.STRIPE_MANAGED_PRICE_ID;
    if (!priceId)
        throw new Error("STRIPE_MANAGED_PRICE_ID not set");
    // Reuse existing Stripe customer if workspace already has one
    const workspace = await S.getWorkspace(params.workspaceId);
    let customerId;
    if (workspace?.stripeCustomerId) {
        customerId = workspace.stripeCustomerId;
    }
    const sessionParams = {
        mode: "subscription",
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: params.successUrl,
        cancel_url: params.cancelUrl,
        metadata: {
            workspace_id: params.workspaceId,
            user_id: params.userId,
        },
        subscription_data: {
            metadata: {
                workspace_id: params.workspaceId,
            },
        },
    };
    if (customerId) {
        sessionParams.customer = customerId;
    }
    else {
        sessionParams.customer_email = params.email;
    }
    const session = await stripe.checkout.sessions.create(sessionParams);
    return { url: session.url };
}
/**
 * Create a Stripe Billing Portal session for managing subscription.
 */
export async function createPortalSession(params) {
    if (!stripe)
        throw new Error("Billing not configured");
    const session = await stripe.billingPortal.sessions.create({
        customer: params.customerId,
        return_url: params.returnUrl,
    });
    return { url: session.url };
}
// --- Usage Metering ---
/**
 * Record a completed API task for usage-based billing.
 * Uses Stripe's Billing Meter Events API.
 */
export async function recordTaskUsage(params) {
    if (!stripe || !S)
        return;
    const meterId = process.env.STRIPE_API_METER_ID;
    if (!meterId)
        return;
    // Look up the workspace's Stripe customer ID
    const workspace = await S.getWorkspace(params.workspaceId);
    if (!workspace?.stripeCustomerId) {
        log.warn("Cannot meter usage — workspace has no Stripe customer ID", { workspaceId: params.workspaceId, taskId: params.taskId });
        return;
    }
    try {
        await stripe.billing.meterEvents.create({
            event_name: "browser_task_completed",
            payload: {
                stripe_customer_id: workspace.stripeCustomerId,
                value: "1",
            },
        });
    }
    catch (err) {
        log.error("Failed to record usage", { taskId: params.taskId }, { error: err.message });
    }
}
// --- Webhooks ---
/**
 * Handle Stripe webhook events.
 * Returns true if the event was handled, false if not recognized.
 */
export async function handleWebhook(rawBody, signature) {
    if (!stripe)
        return { handled: false };
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret)
        return { handled: false };
    let event;
    try {
        event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    }
    catch (err) {
        log.error("Webhook signature verification failed", undefined, { error: err.message });
        return { handled: false };
    }
    switch (event.type) {
        case "checkout.session.completed": {
            const session = event.data.object;
            const workspaceId = session.metadata?.workspace_id;
            if (workspaceId && S) {
                try {
                    await S.updateWorkspaceBilling(workspaceId, {
                        stripeCustomerId: session.customer,
                        plan: "pro",
                        subscriptionId: session.subscription,
                        subscriptionStatus: "active",
                    });
                    log.info("Checkout completed — workspace upgraded", { workspaceId });
                }
                catch (err) {
                    log.error("Failed to persist checkout result", { workspaceId }, { error: err.message });
                }
            }
            return { handled: true, event: event.type };
        }
        case "customer.subscription.updated":
        case "customer.subscription.deleted": {
            const subscription = event.data.object;
            const workspaceId = subscription.metadata?.workspace_id;
            const status = subscription.status;
            if (workspaceId && S) {
                const plan = status === "active" ? "pro" : "free";
                const subStatus = status === "active" ? "active"
                    : status === "canceled" ? "cancelled"
                        : status === "past_due" ? "past_due"
                            : "cancelled";
                try {
                    await S.updateWorkspaceBilling(workspaceId, {
                        plan,
                        subscriptionStatus: subStatus,
                    });
                    log.info("Subscription updated", { workspaceId }, { event: event.type, plan, status: subStatus });
                }
                catch (err) {
                    log.error("Failed to persist subscription update", { workspaceId }, { error: err.message });
                }
            }
            return { handled: true, event: event.type };
        }
        case "invoice.payment_failed": {
            const invoice = event.data.object;
            // Find workspace by Stripe customer ID — requires iterating or a reverse lookup.
            // For now, log the failure. The subscription.updated webhook will handle the status change.
            log.warn("Payment failed", undefined, { customer: String(invoice.customer) });
            return { handled: true, event: event.type };
        }
        default:
            return { handled: false, event: event.type };
    }
}
