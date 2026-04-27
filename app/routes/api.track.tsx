import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { data } from "react-router";
import { z } from "zod";
import prisma from "../db.server";
import { verifyHmac } from "../lib/hmac.server";

/**
 * Endpoint /api/track
 *
 * Recibe POSTs del Web Pixel cuando se completa un checkout referido.
 * Diseñado para responder en < 100ms:
 *   1. Valida HMAC de origen (sección 4 — seguridad).
 *   2. Valida el payload con Zod.
 *   3. Resuelve el Shop por dominio.
 *   4. Resuelve el Affiliate por code.
 *   5. Crea ReferralEvent con idempotencia (UNIQUE shopId+shopifyOrderId).
 *   6. Encola un BillingJob para procesamiento asíncrono.
 *   7. Responde 200 al pixel.
 *
 * El cálculo de UsageRecord en Shopify Billing lo hace el worker, NO este endpoint.
 */

const APP_FEE_RATE = Number(process.env.APP_FEE_RATE ?? "0.05");
const HMAC_SECRET = process.env.WEB_PIXEL_HMAC_SECRET ?? "";
const HMAC_HEADER = "x-pixel-signature";

const trackSchema = z.object({
  affiliateCode: z.string().min(1).max(64),
  shopifyOrderId: z.string().min(1),
  orderTotal: z.number().positive(),
  orderCurrency: z.string().length(3).default("USD"),
  shopDomain: z.string().min(1),
  timestamp: z.union([z.string(), z.number()]).optional(),
});

export async function loader(_args: LoaderFunctionArgs) {
  return data({ error: "Method not allowed" }, { status: 405 });
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return data({ error: "Method not allowed" }, { status: 405 });
  }

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-pixel-signature",
  };

  // Leemos el body como texto para poder verificar el HMAC sobre el raw payload
  const rawBody = await request.text();

  // === HMAC Validation ===
  // En producción, este header lo manda el Web Pixel firmando el body con un
  // secreto compartido. Si no coincide, rechazamos con 401.
  // En dev, si la variable no está seteada, permitimos la request (warn).
  const signature = request.headers.get(HMAC_HEADER) ?? "";

  if (HMAC_SECRET) {
    const isValid = verifyHmac(rawBody, signature, HMAC_SECRET);
    if (!isValid) {
      console.warn(
        `[api/track] HMAC inválido (signature header: ${signature ? "presente" : "ausente"})`,
      );
      return data(
        { error: "Invalid signature" },
        { status: 401, headers: corsHeaders },
      );
    }
  } else {
    console.warn(
      "[api/track] WEB_PIXEL_HMAC_SECRET no configurado. Skipping HMAC validation (solo dev).",
    );
  }

  // === Parse JSON ===
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return data(
      { error: "Invalid JSON body" },
      { status: 400, headers: corsHeaders },
    );
  }

  // === Validación con Zod ===
  const parsed = trackSchema.safeParse(body);
  if (!parsed.success) {
    return data(
      { error: "Invalid payload", issues: parsed.error.issues },
      { status: 400, headers: corsHeaders },
    );
  }

  const payload = parsed.data;

  const shopDomain = payload.shopDomain
    .replace(/^https?:\/\//, "")
    .toLowerCase();

  const shop = await prisma.shop.findUnique({ where: { shopDomain } });
  if (!shop) {
    return data(
      { error: `Shop not found: ${shopDomain}` },
      { status: 404, headers: corsHeaders },
    );
  }

  const affiliate = await prisma.affiliate.findUnique({
    where: {
      shopId_code: {
        shopId: shop.id,
        code: payload.affiliateCode.toUpperCase(),
      },
    },
  });

  if (!affiliate || affiliate.deletedAt) {
    return data(
      { error: "Affiliate not found or archived" },
      { status: 404, headers: corsHeaders },
    );
  }

  const appCommission = Number((payload.orderTotal * APP_FEE_RATE).toFixed(2));
  const affiliateCommission = Number(
    (payload.orderTotal * (affiliate.commissionRate / 100)).toFixed(2),
  );

  try {
    const event = await prisma.referralEvent.create({
      data: {
        shopId: shop.id,
        affiliateId: affiliate.id,
        shopifyOrderId: payload.shopifyOrderId,
        orderTotal: payload.orderTotal,
        orderCurrency: payload.orderCurrency,
        appCommission,
        affiliateCommission,
        status: "pending",
      },
    });

    await prisma.billingJob.create({
      data: {
        referralEventId: event.id,
        status: "pending",
      },
    });

    return data(
      { ok: true, eventId: event.id },
      { status: 200, headers: corsHeaders },
    );
  } catch (err: any) {
    if (err?.code === "P2002") {
      return data(
        { ok: true, idempotent: true },
        { status: 200, headers: corsHeaders },
      );
    }
    console.error("[api/track] Error inesperado:", err);
    return data(
      { error: "Internal server error" },
      { status: 500, headers: corsHeaders },
    );
  }
}