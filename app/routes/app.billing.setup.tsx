import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { authenticate } from "../shopify.server";
import { getOrCreateShop } from "../lib/shop.server";
import { createCappedSubscription, getActiveSubscription } from "../lib/shopify-billing.server";
import prisma from "../db.server";

/**
 * Endpoint /app/billing/setup
 *
 * Crea la suscripción "Capped Amount" del merchant.
 * Si ya existe una activa, la persiste localmente y retorna OK.
 * Si no existe, crea una nueva y redirige al merchant a la URL de aprobación de Shopify.
 *
 * Esto materializa la sección 3.D de la prueba:
 * "Al instalar, la app debe solicitar al merchant un plan Capped Amount (ej: $100 USD)."
 *
 * En MVP se invoca manualmente. En producción se llamaría al primer login.
 */

const CAPPED_AMOUNT_USD = Number(process.env.BILLING_CAPPED_AMOUNT ?? "100");

export async function loader({ request }: LoaderFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const shop = await getOrCreateShop(session);

  // 1. ¿Ya existe una suscripción ACTIVE en Shopify?
  const existing = await getActiveSubscription(admin);

  if (existing) {
    // Persistimos localmente (puede que sea la primera vez que vemos esta sub)
    const balanceUsed = Number(
      existing.lineItems?.[0]?.plan?.pricingDetails?.balanceUsed?.amount ?? 0,
    );
    const cappedAmount = Number(
      existing.lineItems?.[0]?.plan?.pricingDetails?.cappedAmount?.amount ?? 0,
    );

    await prisma.subscription.upsert({
      where: { shopifySubscriptionId: existing.id },
      update: {
        status: "active",
        currentUsage: balanceUsed,
        cappedAmount,
      },
      create: {
        shopId: shop.id,
        shopifySubscriptionId: existing.id,
        cappedAmount,
        currentUsage: balanceUsed,
        currency: "USD",
        status: "active",
      },
    });

    // Cacheamos también el subscriptionId en Shop para acceso rápido
    await prisma.shop.update({
      where: { id: shop.id },
      data: { subscriptionId: existing.id, cappedAmount },
    });

    return new Response(
      JSON.stringify({
        ok: true,
        message: "Subscription ya activa",
        subscriptionId: existing.id,
        cappedAmount,
        currentUsage: balanceUsed,
        lineItemId: existing.lineItems?.[0]?.id,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  // 2. No hay sub activa: creamos una nueva
  const url = new URL(request.url);
  const returnUrl = `${url.origin}/app/billing/setup`; // tras aprobar, vuelve aquí

  const { subscriptionId, lineItemId, confirmationUrl } = await createCappedSubscription(
    admin,
    {
      name: "Affiliate Engine — Plan de Uso (5%)",
      cappedAmount: CAPPED_AMOUNT_USD,
      currencyCode: "USD",
      returnUrl,
      test: true, 
    },
  );

  // Persistimos en BD como "pending" hasta que el merchant apruebe
  await prisma.subscription.create({
    data: {
      shopId: shop.id,
      shopifySubscriptionId: subscriptionId,
      cappedAmount: CAPPED_AMOUNT_USD,
      currentUsage: 0,
      currency: "USD",
      status: "pending",
    },
  });

  await prisma.shop.update({
    where: { id: shop.id },
    data: {
      subscriptionId,
      cappedAmount: CAPPED_AMOUNT_USD,
    },
  });

  // Redirigimos al merchant a la URL de aprobación de Shopify
  return redirect(confirmationUrl);
}