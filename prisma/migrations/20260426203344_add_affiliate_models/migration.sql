-- CreateTable
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopDomain" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "cappedAmount" REAL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Affiliate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "commissionRate" REAL NOT NULL DEFAULT 10.0,
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Affiliate_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ReferralEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopId" TEXT NOT NULL,
    "affiliateId" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "orderTotal" REAL NOT NULL,
    "orderCurrency" TEXT NOT NULL DEFAULT 'USD',
    "appCommission" REAL NOT NULL,
    "affiliateCommission" REAL NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "processedAt" DATETIME,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ReferralEvent_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ReferralEvent_affiliateId_fkey" FOREIGN KEY ("affiliateId") REFERENCES "Affiliate" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BillingJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "referralEventId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "nextAttemptAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "lockedAt" DATETIME,
    "lockedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BillingJob_referralEventId_fkey" FOREIGN KEY ("referralEventId") REFERENCES "ReferralEvent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopId" TEXT NOT NULL,
    "shopifySubscriptionId" TEXT NOT NULL,
    "cappedAmount" REAL NOT NULL,
    "currentUsage" REAL NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "currentPeriodStart" DATETIME,
    "currentPeriodEnd" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Subscription_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Shop_shopDomain_key" ON "Shop"("shopDomain");

-- CreateIndex
CREATE INDEX "Affiliate_shopId_deletedAt_idx" ON "Affiliate"("shopId", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Affiliate_shopId_code_key" ON "Affiliate"("shopId", "code");

-- CreateIndex
CREATE INDEX "ReferralEvent_shopId_status_idx" ON "ReferralEvent"("shopId", "status");

-- CreateIndex
CREATE INDEX "ReferralEvent_shopId_createdAt_idx" ON "ReferralEvent"("shopId", "createdAt");

-- CreateIndex
CREATE INDEX "ReferralEvent_affiliateId_idx" ON "ReferralEvent"("affiliateId");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralEvent_shopId_shopifyOrderId_key" ON "ReferralEvent"("shopId", "shopifyOrderId");

-- CreateIndex
CREATE INDEX "BillingJob_status_nextAttemptAt_idx" ON "BillingJob"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "BillingJob_referralEventId_idx" ON "BillingJob"("referralEventId");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_shopifySubscriptionId_key" ON "Subscription"("shopifySubscriptionId");

-- CreateIndex
CREATE INDEX "Subscription_shopId_status_idx" ON "Subscription"("shopId", "status");
