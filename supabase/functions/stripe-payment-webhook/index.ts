import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@14?target=denonext";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, stripe-signature, x-client-info, apikey, content-type",
};

const DEFAULT_PAYMENTS_TABLE = "app_payments";
const STRIPE_API_VERSION: Stripe.LatestApiVersion = "2024-11-20";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function normalizeDeviceId(value: unknown): string {
  const safeValue = String(value ?? "").trim();
  return /^[A-Za-z0-9_-]{12,128}$/.test(safeValue) ? safeValue : "";
}

function getWebhookSecrets(): string[] {
  return [
    Deno.env.get("STRIPE_WEBHOOK_SECRET") || "",
    Deno.env.get("STRIPE_WEBHOOK_SECRET_TEST") || "",
    Deno.env.get("STRIPE_WEBHOOK_SECRET_LIVE") || "",
  ]
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value, index, list) => list.indexOf(value) === index);
}

function getPaymentsTableNames(): string[] {
  return [
    Deno.env.get("PAYMENT_RECORDS_TABLE") || "",
    DEFAULT_PAYMENTS_TABLE,
  ]
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value, index, list) => list.indexOf(value) === index);
}

function isRelationMissingError(error: unknown) {
  const message = String((error as { message?: string } | null)?.message || "").toLowerCase();
  return message.includes("relation") && message.includes("does not exist");
}

function createStripeClient() {
  const apiKey = String(Deno.env.get("STRIPE_API_KEY") || "sk_test_placeholder").trim();
  return new Stripe(apiKey, {
    apiVersion: STRIPE_API_VERSION,
  });
}

function createAdminClient() {
  const supabaseUrl = String(Deno.env.get("SUPABASE_URL") || "").trim();
  const serviceRoleKey = String(
    Deno.env.get("SERVICE_ROLE_KEY")
    || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
    || "",
  ).trim();

  if (!supabaseUrl || !serviceRoleKey) return null;

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

async function constructVerifiedEvent(
  body: string,
  signature: string,
): Promise<Stripe.Event | null> {
  const stripe = createStripeClient();
  const webhookSecrets = getWebhookSecrets();
  if (webhookSecrets.length === 0) {
    throw new Error("Missing Stripe webhook signing secret.");
  }

  const cryptoProvider = Stripe.createSubtleCryptoProvider();
  for (const secret of webhookSecrets) {
    try {
      return await stripe.webhooks.constructEventAsync(
        body,
        signature,
        secret,
        undefined,
        cryptoProvider,
      );
    } catch (_error) {}
  }

  return null;
}

async function upsertPaidDeviceRecord(
  admin: ReturnType<typeof createAdminClient>,
  values: {
    deviceId: string;
    paidAt: string;
    livemode: boolean;
    checkoutSessionId: string | null;
    paymentLinkId: string | null;
    customerEmail: string | null;
    currency: string | null;
    amountTotal: number | null;
    eventId: string | null;
  },
) {
  let lastError: unknown = null;

  for (const tableName of getPaymentsTableNames()) {
    const { error } = await admin!
      .from(tableName)
      .upsert({
        device_id: values.deviceId,
        payment_status: "paid",
        paid_at: values.paidAt,
        livemode: values.livemode,
        checkout_session_id: values.checkoutSessionId,
        payment_link_id: values.paymentLinkId,
        customer_email: values.customerEmail,
        currency: values.currency,
        amount_total: values.amountTotal,
        raw_event_id: values.eventId,
      }, { onConflict: "device_id" });

    if (!error) return { tableName };
    lastError = error;
    if (!isRelationMissingError(error)) break;
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError || "Failed to store payment."));
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed." }, 405);
  }

  try {
    const signature = String(req.headers.get("stripe-signature") || "").trim();
    if (!signature) {
      return jsonResponse({ error: "Missing Stripe-Signature header." }, 400);
    }

    const rawBody = await req.text();
    const event = await constructVerifiedEvent(rawBody, signature);
    if (!event) {
      console.error("Stripe webhook signature verification failed.");
      return jsonResponse({ error: "Invalid Stripe signature." }, 400);
    }

    if (
      event.type !== "checkout.session.completed"
      && event.type !== "checkout.session.async_payment_succeeded"
    ) {
      return jsonResponse({ received: true, ignored: true, eventType: event.type });
    }

    const session = event.data.object as Stripe.Checkout.Session;
    const deviceId = normalizeDeviceId(session.client_reference_id);
    if (!deviceId) {
      console.warn("Stripe webhook ignored because client_reference_id was missing or invalid.", {
        eventId: event.id,
        eventType: event.type,
      });
      return jsonResponse({ received: true, ignored: true, reason: "missing_client_reference_id" });
    }

    const paymentStatus = String(session.payment_status || "").trim().toLowerCase();
    if (paymentStatus !== "paid" && event.type !== "checkout.session.async_payment_succeeded") {
      return jsonResponse({
        received: true,
        ignored: true,
        reason: "session_not_paid",
        paymentStatus,
      });
    }

    const admin = createAdminClient();
    if (!admin) {
      console.error("Stripe webhook missing Supabase admin secrets.");
      return jsonResponse({ error: "Server not configured." }, 500);
    }

    const paidAt = Number.isFinite(Number(event.created))
      ? new Date(Number(event.created) * 1000).toISOString()
      : new Date().toISOString();
    const stored = await upsertPaidDeviceRecord(admin, {
      deviceId,
      paidAt,
      livemode: Boolean(event.livemode),
      checkoutSessionId: session.id ? String(session.id) : null,
      paymentLinkId: session.payment_link ? String(session.payment_link) : null,
      customerEmail: session.customer_details?.email
        ? String(session.customer_details.email)
        : (session.customer_email ? String(session.customer_email) : null),
      currency: session.currency ? String(session.currency).toLowerCase() : null,
      amountTotal: typeof session.amount_total === "number" ? session.amount_total : null,
      eventId: event.id ? String(event.id) : null,
    });

    console.log("Stripe payment recorded.", {
      tableName: stored.tableName,
      eventId: event.id,
      eventType: event.type,
      deviceId,
      livemode: Boolean(event.livemode),
    });

    return jsonResponse({
      received: true,
      paid: true,
      deviceId,
      eventId: event.id,
      tableName: stored.tableName,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error.";
    console.error("Stripe webhook failed.", message);
    return jsonResponse({ error: message }, 500);
  }
});
