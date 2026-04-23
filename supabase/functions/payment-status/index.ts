import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const DEFAULT_PAYMENTS_TABLE = "app_payments";

type PaymentRow = {
  device_id?: string | null;
  payment_status?: string | null;
  paid_at?: string | null;
  livemode?: boolean | null;
  checkout_session_id?: string | null;
  payment_link_id?: string | null;
  customer_email?: string | null;
  currency?: string | null;
  amount_total?: number | null;
};

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

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
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

async function readPaymentRow(
  admin: ReturnType<typeof createAdminClient>,
  deviceId: string,
) {
  let lastError: unknown = null;

  for (const tableName of getPaymentsTableNames()) {
    const result = await admin!
      .from(tableName)
      .select("device_id, payment_status, paid_at, livemode, checkout_session_id, payment_link_id, customer_email, currency, amount_total")
      .eq("device_id", deviceId)
      .maybeSingle<PaymentRow>();

    if (!result.error) {
      return {
        tableName,
        data: result.data || null,
      };
    }

    lastError = result.error;
    if (!isRelationMissingError(result.error)) break;
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError || "Failed to load payment status."));
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const payload = req.method === "GET"
      ? { deviceId: new URL(req.url).searchParams.get("deviceId") }
      : asObject(await req.json().catch(() => ({})));

    const deviceId = normalizeDeviceId(payload.deviceId);
    if (!deviceId) {
      return jsonResponse({ error: "Missing device id." }, 400);
    }

    const admin = createAdminClient();
    if (!admin) {
      return jsonResponse({ error: "Server not configured." }, 500);
    }

    const { tableName, data } = await readPaymentRow(admin, deviceId);
    return jsonResponse({
      paid: data?.payment_status === "paid",
      deviceId,
      paidAt: data?.paid_at ?? "",
      livemode: Boolean(data?.livemode),
      sessionId: data?.checkout_session_id ?? "",
      paymentLinkId: data?.payment_link_id ?? "",
      customerEmail: data?.customer_email ?? "",
      currency: data?.currency ?? "",
      amountTotal: typeof data?.amount_total === "number" ? data.amount_total : null,
      tableName,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error.";
    console.error("Payment status lookup failed.", message);
    return jsonResponse({ error: message }, 500);
  }
});
