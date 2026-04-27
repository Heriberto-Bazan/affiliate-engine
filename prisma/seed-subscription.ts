import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // Encontramos el primer Shop (en MVP solo hay uno)
  const shop = await prisma.shop.findFirst();
  if (!shop) {
    console.error("❌ No hay Shop en BD. Crea uno primero.");
    process.exit(1);
  }

  const SUBSCRIPTION_ID = "gid://shopify/AppSubscription/MOCK-DEV-001";
  const CAPPED = 100;

  // Upsert de Subscription (idempotente: si ya existe, la actualiza)
  const sub = await prisma.subscription.upsert({
    where: { shopifySubscriptionId: SUBSCRIPTION_ID },
    update: {
      status: "active",
      cappedAmount: CAPPED,
      currentUsage: 0,
    },
    create: {
      shopId: shop.id,
      shopifySubscriptionId: SUBSCRIPTION_ID,
      cappedAmount: CAPPED,
      currentUsage: 0,
      currency: "USD",
      status: "active",
    },
  });

  // Linkeamos en Shop
  await prisma.shop.update({
    where: { id: shop.id },
    data: {
      subscriptionId: SUBSCRIPTION_ID,
      cappedAmount: CAPPED,
    },
  });

  console.log("Subscription creada/actualizada:");
  console.log("shopId:", sub.shopId);
  console.log("shopifySubscriptionId:", sub.shopifySubscriptionId);
  console.log("cappedAmount:", sub.cappedAmount);
  console.log("status:", sub.status);
  console.log("Shop actualizado con subscriptionId");
}

main()
  .catch((err) => {
    console.error("Error en seed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });