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
import type * as fileStore from "./store.js";

let stripe: Stripe | null = null;
let S: typeof fileStore | null = null;

/** Set the backing store so billing can persist webhook results. */
export function setBillingStore(store: typeof fileStore): void {
  S = store;
}

export function initBilling(): boolean {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    log.info("No STRIPE_SECRET_KEY — billing disabled");
    return false;
  }
  stripe = new Stripe(key);
  log.info("Stripe billing initialized");
  return true;
}

export function isBillingEnabled(): boolean {
  return stripe !== null;
}

// --- Credit Packs ---

const CREDIT_PACKS: Record<string, { credits: number; priceId: string }> = {};

/**
 * Initialize credit packs from env. Format: STRIPE_CREDIT_PACK_<N>=<credits>:<stripe_price_id>
 * Example: STRIPE_CREDIT_PACK_1=100:price_abc123
 *          STRIPE_CREDIT_PACK_2=500:price_def456
 * Or use a single default: STRIPE_CREDIT_PRICE_ID for 100 credits.
 */
function loadCreditPacks(): void {
  // Default pack
  const defaultPrice = process.env.STRIPE_CREDIT_PRICE_ID;
  if (defaultPrice) {
    CREDIT_PACKS["100"] = { credits: 100, priceId: defaultPrice };
  }
  // Numbered packs
  for (let i = 1; i <= 5; i++) {
    const val = process.env[`STRIPE_CREDIT_PACK_${i}`];
    if (val) {
      const [credits, priceId] = val.split(":");
      if (credits && priceId) {
        CREDIT_PACKS[credits] = { credits: parseInt(credits, 10), priceId };
      }
    }
  }
}

/**
 * Create a Stripe Checkout session to buy credits.
 */
export async function createCheckoutSession(params: {
  workspaceId: string;
  userId: string;
  email?: string;
  credits?: number;
  successUrl: string;
  cancelUrl: string;
}): Promise<{ url: string }> {
  if (!stripe || !S) throw new Error("Billing not configured");

  loadCreditPacks();

  const requestedCredits = String(params.credits || 100);
  const pack = CREDIT_PACKS[requestedCredits];
  if (!pack) {
    const available = Object.keys(CREDIT_PACKS).join(", ");
    throw new Error(`No credit pack for ${requestedCredits} credits. Available: ${available || "none configured"}`);
  }

  const workspace = await S.getWorkspace(params.workspaceId);
  let customerId: string | undefined;
  if (workspace?.stripeCustomerId) {
    customerId = workspace.stripeCustomerId;
  }

  const sessionParams: any = {
    mode: "payment",
    line_items: [{ price: pack.priceId, quantity: 1 }],
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    metadata: {
      workspace_id: params.workspaceId,
      user_id: params.userId,
      credits: String(pack.credits),
    },
  };

  if (customerId) {
    sessionParams.customer = customerId;
  } else {
    sessionParams.customer_email = params.email;
  }

  const session = await stripe.checkout.sessions.create(sessionParams);
  return { url: session.url! };
}

/**
 * Create a Stripe Billing Portal session for managing subscription.
 */
export async function createPortalSession(params: {
  customerId: string;
  returnUrl: string;
}): Promise<{ url: string }> {
  if (!stripe) throw new Error("Billing not configured");

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
export async function recordTaskUsage(params: {
  workspaceId: string;
  taskId: string;
  steps: number;
  inputTokens: number;
  outputTokens: number;
}): Promise<void> {
  if (!stripe || !S) return;

  const meterId = process.env.STRIPE_API_METER_ID;
  if (!meterId) return;

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
  } catch (err: any) {
    log.error("Failed to record usage", { taskId: params.taskId }, { error: err.message });
  }
}

// --- Webhooks ---

/**
 * Handle Stripe webhook events.
 * Returns true if the event was handled, false if not recognized.
 */
export async function handleWebhook(
  rawBody: string,
  signature: string
): Promise<{ handled: boolean; event?: string }> {
  if (!stripe) return { handled: false };

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) return { handled: false };

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err: any) {
    log.error("Webhook signature verification failed", undefined, { error: err.message });
    return { handled: false };
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const workspaceId = session.metadata?.workspace_id;
      const credits = parseInt(session.metadata?.credits || "0", 10);
      if (workspaceId && S) {
        try {
          // Persist Stripe customer ID
          await S.updateWorkspaceBilling(workspaceId, {
            stripeCustomerId: session.customer as string,
          });
          // Add purchased credits
          if (credits > 0) {
            const newBalance = await S.addCredits(workspaceId, credits);
            log.info("Credits purchased", { workspaceId }, { credits, newBalance });
          }
        } catch (err: any) {
          log.error("Failed to persist checkout result", { workspaceId }, { error: err.message });
        }
      }
      return { handled: true, event: event.type };
    }

    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const subscription = event.data.object as Stripe.Subscription;
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
        } catch (err: any) {
          log.error("Failed to persist subscription update", { workspaceId }, { error: err.message });
        }
      }
      return { handled: true, event: event.type };
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      // Find workspace by Stripe customer ID — requires iterating or a reverse lookup.
      // For now, log the failure. The subscription.updated webhook will handle the status change.
      log.warn("Payment failed", undefined, { customer: String(invoice.customer) });
      return { handled: true, event: event.type };
    }

    default:
      return { handled: false, event: event.type };
  }
}
