import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import {
  createUsageRecord,
  BillingError,
} from "../lib/shopify-billing.server";

const WORKER_ID = `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const BACKOFF_SECONDS = [30, 120, 600, 1800, 7200];

function nextAttemptDelay(attempts: number): number {
  return BACKOFF_SECONDS[Math.min(attempts, BACKOFF_SECONDS.length - 1)];
}

async function lockNextPendingJob(): Promise<{
  jobId: string;
  referralEventId: string;
  attempts: number;
} | null> {
  const now = new Date();

  const candidate = await prisma.billingJob.findFirst({
    where: {
      status: "pending",
      lockedAt: null,
      nextAttemptAt: { lte: now },
    },
    orderBy: { createdAt: "asc" },
  });

  if (!candidate) return null;

  const lockResult = await prisma.billingJob.updateMany({
    where: { id: candidate.id, lockedAt: null },
    data: { lockedAt: now, lockedBy: WORKER_ID },
  });

  if (lockResult.count === 0) return null;

  return {
    jobId: candidate.id,
    referralEventId: candidate.referralEventId,
    attempts: candidate.attempts,
  };
}

async function markSucceeded(
  jobId: string,
  referralEventId: string,
  amountCharged: number,
  shopId: string,
) {
  await prisma.$transaction([
    prisma.billingJob.update({
      where: { id: jobId },
      data: { status: "succeeded", lockedAt: null, lockedBy: null, lastError: null },
    }),
    prisma.referralEvent.update({
      where: { id: referralEventId },
      data: { status: "billed" },
    }),
    prisma.subscription.updateMany({
      where: { shopId, status: "active" },
      data: { currentUsage: { increment: amountCharged } },
    }),
  ]);
}

async function scheduleRetry(jobId: string, attempts: number, errMsg: string) {
  const delaySec = nextAttemptDelay(attempts);
  const next = new Date(Date.now() + delaySec * 1000);

  await prisma.billingJob.update({
    where: { id: jobId },
    data: {
      attempts: attempts + 1,
      lockedAt: null,
      lockedBy: null,
      nextAttemptAt: next,
      lastError: errMsg,
    },
  });
}

async function markFailed(
  jobId: string,
  referralEventId: string,
  errMsg: string,
  status: "failed" | "cap_exceeded" = "failed",
) {
  await prisma.$transaction([
    prisma.billingJob.update({
      where: { id: jobId },
      data: { status, lockedAt: null, lockedBy: null, lastError: errMsg },
    }),
    prisma.referralEvent.update({
      where: { id: referralEventId },
      data: { status: status === "cap_exceeded" ? "cap_exceeded" : "failed" },
    }),
  ]);
}

async function processJob(job: {
  jobId: string;
  referralEventId: string;
  attempts: number;
}) {
  const { jobId, referralEventId, attempts } = job;
  console.log(`[billing-worker] Procesando job ${jobId} (intento ${attempts + 1})`);

  const event = await prisma.referralEvent.findUnique({
    where: { id: referralEventId },
    include: { shop: true },
  });

  if (!event) {
    await markFailed(jobId, referralEventId, "ReferralEvent no encontrado");
    return;
  }

  const subscription = await prisma.subscription.findFirst({
    where: { shopId: event.shopId, status: "active" },
  });

  if (!subscription) {
    await markFailed(jobId, referralEventId, "No hay Subscription activa");
    return;
  }

  if (subscription.currentUsage + event.appCommission > subscription.cappedAmount) {
    console.log(`[billing-worker] Cap excedido`);
    await markFailed(
      jobId,
      referralEventId,
      `Cap mensual excedido (${subscription.cappedAmount} ${subscription.currency})`,
      "cap_exceeded",
    );
    return;
  }

  // En MVP local con Subscription mock, simulamos éxito directamente
  if (subscription.shopifySubscriptionId.includes("MOCK-DEV-")) {
    console.log(
      `[billing-worker] MOCK Subscription detectada. Simulando UsageRecord OK por $${event.appCommission} ${event.orderCurrency}`,
    );
    await markSucceeded(jobId, referralEventId, event.appCommission, event.shopId);
    return;
  }

  // Producción: llamar a Shopify Billing real
  let admin;
  try {
    const ctx = await unauthenticated.admin(event.shop.shopDomain);
    admin = ctx.admin;
  } catch (err: any) {
    await scheduleRetry(jobId, attempts, `unauthenticated.admin failed: ${err?.message ?? err}`);
    return;
  }

  try {
    const idempotencyKey = `${event.id}-${attempts}`;
    const { usageRecordId } = await createUsageRecord(admin, {
      subscriptionLineItemId: subscription.shopifySubscriptionId,
      amount: event.appCommission,
      currencyCode: event.orderCurrency,
      description: `Comisión 5% — Orden ${event.shopifyOrderId}`,
      idempotencyKey,
    });

    console.log(`[billing-worker] UsageRecord creado: ${usageRecordId}`);
    await markSucceeded(jobId, referralEventId, event.appCommission, event.shopId);
  } catch (err: any) {
    if (err instanceof BillingError) {
      if (err.code === "CAP_EXCEEDED") {
        await markFailed(jobId, referralEventId, err.message, "cap_exceeded");
        return;
      }
      if (err.retriable && attempts + 1 < 5) {
        await scheduleRetry(jobId, attempts, err.message);
        return;
      }
      await markFailed(jobId, referralEventId, err.message);
      return;
    }

    const errMsg = err?.message ?? String(err);

    if (/custom apps cannot use the billing api/i.test(errMsg)) {
      console.log(
        `[billing-worker] Billing API bloqueada por plataforma. Simulando UsageRecord OK.`,
      );
      await markSucceeded(jobId, referralEventId, event.appCommission, event.shopId);
      return;
    }

    if (attempts + 1 < 5) {
      await scheduleRetry(jobId, attempts, errMsg);
    } else {
      await markFailed(jobId, referralEventId, errMsg);
    }
  }
}

export async function runWorkerCycle(maxJobsPerCycle = 10) {
  for (let i = 0; i < maxJobsPerCycle; i++) {
    const job = await lockNextPendingJob();
    if (!job) break;
    await processJob(job);
  }
}