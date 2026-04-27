import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, data } from "react-router";
import {
  Page,
  Card,
  Text,
  Badge,
  IndexTable,
  EmptyState,
  Box,
  BlockStack,
  InlineStack,
  Banner,
} from "@shopify/polaris";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getOrCreateShop } from "../lib/shop.server";

/**
 * Home / Dashboard del merchant.
 *
 * Muestra las 3 métricas que pide la sección 3.A de la prueba:
 *   - Total de ventas referidas
 *   - Total de comisiones generadas para la App (5%)
 *   - Total de comisiones a pagar a afiliados
 *
 * Más una tabla con las últimas 10 ventas referidas y un resumen de la Subscription.
 */

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getOrCreateShop(session);

  // 3 queries agregadas en paralelo (multi-tenant: filtran por shopId)
  const [eventCount, sums, recentEvents, subscription] = await Promise.all([
    prisma.referralEvent.count({ where: { shopId: shop.id } }),
    prisma.referralEvent.aggregate({
      where: { shopId: shop.id },
      _sum: {
        orderTotal: true,
        appCommission: true,
        affiliateCommission: true,
      },
    }),
    prisma.referralEvent.findMany({
      where: { shopId: shop.id },
      orderBy: { createdAt: "desc" },
      take: 10,
      include: { affiliate: true },
    }),
    prisma.subscription.findFirst({
      where: { shopId: shop.id, status: "active" },
    }),
  ]);

  return data({
    metrics: {
      totalReferralSales: eventCount,
      totalOrderVolume: sums._sum.orderTotal ?? 0,
      totalAppCommission: sums._sum.appCommission ?? 0,
      totalAffiliateCommission: sums._sum.affiliateCommission ?? 0,
    },
    subscription: subscription
      ? {
          cappedAmount: subscription.cappedAmount,
          currentUsage: subscription.currentUsage,
          currency: subscription.currency,
          status: subscription.status,
        }
      : null,
    recentEvents: recentEvents.map((e) => ({
      id: e.id,
      shopifyOrderId: e.shopifyOrderId,
      affiliateCode: e.affiliate.code,
      affiliateName: e.affiliate.name,
      orderTotal: e.orderTotal,
      orderCurrency: e.orderCurrency,
      appCommission: e.appCommission,
      affiliateCommission: e.affiliateCommission,
      status: e.status,
      createdAt: e.createdAt.toISOString(),
    })),
  });
};

function formatCurrency(amount: number, currency: string = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(amount);
}

function statusBadge(status: string) {
  switch (status) {
    case "billed":
      return <Badge tone="success">Cobrado</Badge>;
    case "pending":
      return <Badge tone="attention">Pendiente</Badge>;
    case "failed":
      return <Badge tone="critical">Fallido</Badge>;
    case "cap_exceeded":
      return <Badge tone="warning">Cap excedido</Badge>;
    default:
      return <Badge>{status}</Badge>;
  }
}

export default function DashboardPage() {
  const { metrics, subscription, recentEvents } = useLoaderData<typeof loader>();

  const usagePercent = subscription
    ? Math.min(100, Math.round((subscription.currentUsage / subscription.cappedAmount) * 100))
    : 0;

  return (
    <Page title="Dashboard">
      <BlockStack gap="500">
        {/* Banner de Subscription */}
        {!subscription ? (
          <Banner tone="warning" title="Subscription no activa">
            <p>
              No hay una suscripción de Billing activa para este shop. La app
              no podrá cobrar comisiones hasta que se configure el plan Capped
              Amount.
            </p>
          </Banner>
        ) : (
          <Banner
            tone={usagePercent >= 90 ? "warning" : "info"}
            title={`Plan activo: ${formatCurrency(subscription.cappedAmount, subscription.currency)} / mes`}
          >
            <p>
              Uso actual:{" "}
              <strong>
                {formatCurrency(subscription.currentUsage, subscription.currency)}
              </strong>{" "}
              ({usagePercent}% del cap mensual).
            </p>
          </Banner>
        )}

        {/* 3 Métricas principales */}
        <InlineStack gap="400" wrap={false} align="start" blockAlign="stretch">
          <Box width="100%">
            <Card>
              <BlockStack gap="200">
                <Text variant="bodyMd" tone="subdued" as="span">
                  Total ventas referidas
                </Text>
                <Text variant="heading2xl" as="p">
                  {metrics.totalReferralSales}
                </Text>
                <Text variant="bodySm" tone="subdued" as="span">
                  Volumen total: {formatCurrency(metrics.totalOrderVolume)}
                </Text>
              </BlockStack>
            </Card>
          </Box>

          <Box width="100%">
            <Card>
              <BlockStack gap="200">
                <Text variant="bodyMd" tone="subdued" as="span">
                  Comisiones de la App (5%)
                </Text>
                <Text variant="heading2xl" as="p">
                  {formatCurrency(metrics.totalAppCommission)}
                </Text>
                <Text variant="bodySm" tone="subdued" as="span">
                  Cobrado al merchant via UsageRecords
                </Text>
              </BlockStack>
            </Card>
          </Box>

          <Box width="100%">
            <Card>
              <BlockStack gap="200">
                <Text variant="bodyMd" tone="subdued" as="span">
                  Comisiones de afiliados
                </Text>
                <Text variant="heading2xl" as="p">
                  {formatCurrency(metrics.totalAffiliateCommission)}
                </Text>
                <Text variant="bodySm" tone="subdued" as="span">
                  Total a pagar a afiliados
                </Text>
              </BlockStack>
            </Card>
          </Box>
        </InlineStack>

        {/* Tabla de últimas ventas */}
        <Card>
          <Box padding="400">
            <Text variant="headingMd" as="h2">
              Últimas ventas referidas
            </Text>
          </Box>

          {recentEvents.length === 0 ? (
            <EmptyState
              heading="Aún no hay ventas referidas"
              image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
            >
              <p>
                Cuando un cliente complete una compra usando un link de afiliado,
                aparecerá aquí.
              </p>
            </EmptyState>
          ) : (
            <IndexTable
              resourceName={{ singular: "venta", plural: "ventas" }}
              itemCount={recentEvents.length}
              headings={[
                { title: "Orden" },
                { title: "Afiliado" },
                { title: "Total" },
                { title: "Comisión App" },
                { title: "Comisión Afiliado" },
                { title: "Estado" },
              ]}
              selectable={false}
            >
              {recentEvents.map((e, idx) => (
                <IndexTable.Row id={e.id} key={e.id} position={idx}>
                  <IndexTable.Cell>
                    <Text variant="bodyMd" fontWeight="bold" as="span">
                      {e.shopifyOrderId}
                    </Text>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <BlockStack gap="050">
                      <Text variant="bodyMd" as="span">
                        {e.affiliateCode}
                      </Text>
                      <Text variant="bodySm" tone="subdued" as="span">
                        {e.affiliateName}
                      </Text>
                    </BlockStack>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    {formatCurrency(e.orderTotal, e.orderCurrency)}
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    {formatCurrency(e.appCommission, e.orderCurrency)}
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    {formatCurrency(e.affiliateCommission, e.orderCurrency)}
                  </IndexTable.Cell>
                  <IndexTable.Cell>{statusBadge(e.status)}</IndexTable.Cell>
                </IndexTable.Row>
              ))}
            </IndexTable>
          )}
        </Card>
      </BlockStack>
    </Page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};