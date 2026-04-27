import type { Session } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";

/**
 * Resuelve el Shop asociado a la sesión actual.
 * Si no existe, lo crea (auto-provisión lazy).
 */
export async function getOrCreateShop(session: Session) {
  const shopDomain = session.shop;

  const existing = await prisma.shop.findUnique({
    where: { shopDomain },
  });

  if (existing) return existing;

  return prisma.shop.create({
    data: { shopDomain },
  });
}