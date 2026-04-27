/**
 * Helper para interactuar con la Billing API de Shopify.
 *
 * Encapsula las dos operaciones críticas del modelo de monetización:
 *   1. Crear una suscripción "Capped Amount" al instalar (techo mensual).
 *   2. Crear UsageRecords (cobros de uso) cada vez que hay una venta referida.
 *
 * Diseño:
 *   - Stateless: cada llamada recibe el `admin` GraphQL client de la sesión.
 *   - Type-safe: tipos explícitos en inputs y outputs.
 *   - Error-aware: lanza errores clasificados que el worker puede inspeccionar.
 */

// Tipo del cliente admin que provee Shopify
type AdminGraphQLClient = {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

// Errores clasificados que el worker puede manejar de forma diferenciada
export class BillingError extends Error {
  constructor(
    message: string,
    public code: "THROTTLED" | "CAP_EXCEEDED" | "NO_SUBSCRIPTION" | "GRAPHQL_ERROR" | "UNKNOWN",
    public retriable: boolean,
  ) {
    super(message);
    this.name = "BillingError";
  }
}

/**
 * Crea una suscripción "Capped Amount" en Shopify.
 * El merchant DEBE aprobarla en la URL devuelta para que quede activa.
 *
 * @returns { subscriptionId, confirmationUrl, lineItemId }
 */
export async function createCappedSubscription(
  admin: AdminGraphQLClient,
  params: {
    name: string;
    cappedAmount: number;
    currencyCode?: string;
    returnUrl: string;
    test?: boolean;
  },
) {
  const { name, cappedAmount, currencyCode = "USD", returnUrl, test = true } = params;

  const mutation = `
    mutation appSubscriptionCreate(
      $name: String!,
      $returnUrl: URL!,
      $test: Boolean,
      $lineItems: [AppSubscriptionLineItemInput!]!
    ) {
      appSubscriptionCreate(
        name: $name,
        returnUrl: $returnUrl,
        test: $test,
        lineItems: $lineItems
      ) {
        userErrors { field message }
        confirmationUrl
        appSubscription {
          id
          status
          lineItems { id plan { pricingDetails { __typename } } }
        }
      }
    }
  `;

  const response = await admin.graphql(mutation, {
    variables: {
      name,
      returnUrl,
      test,
      lineItems: [
        {
          plan: {
            appUsagePricingDetails: {
              cappedAmount: { amount: cappedAmount, currencyCode },
              terms: `Tarifa de servicio del 5% por cada venta referida (cap mensual de ${cappedAmount} ${currencyCode}).`,
            },
          },
        },
      ],
    },
  });

  const json = (await response.json()) as any;
  const result = json?.data?.appSubscriptionCreate;

  if (!result || result.userErrors?.length > 0) {
    throw new BillingError(
      `appSubscriptionCreate userErrors: ${JSON.stringify(result?.userErrors)}`,
      "GRAPHQL_ERROR",
      false,
    );
  }

  const subscriptionId = result.appSubscription?.id;
  const lineItemId = result.appSubscription?.lineItems?.[0]?.id;
  const confirmationUrl = result.confirmationUrl;

  if (!subscriptionId || !lineItemId || !confirmationUrl) {
    throw new BillingError("Respuesta inválida de Shopify", "GRAPHQL_ERROR", false);
  }

  return { subscriptionId, lineItemId, confirmationUrl };
}

/**
 * Crea un UsageRecord (cobro de uso) contra una suscripción activa.
 * Útil para el modelo "5% por venta referida".
 *
 * @returns { usageRecordId } si la creación fue exitosa
 * @throws BillingError clasificado según el tipo de fallo
 */
export async function createUsageRecord(
  admin: AdminGraphQLClient,
  params: {
    subscriptionLineItemId: string;
    amount: number;
    currencyCode?: string;
    description: string;
    idempotencyKey?: string;
  },
) {
  const {
    subscriptionLineItemId,
    amount,
    currencyCode = "USD",
    description,
    idempotencyKey,
  } = params;

  const mutation = `
    mutation appUsageRecordCreate(
      $subscriptionLineItemId: ID!,
      $price: MoneyInput!,
      $description: String!,
      $idempotencyKey: String
    ) {
      appUsageRecordCreate(
        subscriptionLineItemId: $subscriptionLineItemId,
        price: $price,
        description: $description,
        idempotencyKey: $idempotencyKey
      ) {
        userErrors { field message code }
        appUsageRecord { id price { amount currencyCode } createdAt }
      }
    }
  `;

  const response = await admin.graphql(mutation, {
    variables: {
      subscriptionLineItemId,
      price: { amount, currencyCode },
      description,
      idempotencyKey,
    },
  });

  // 429 desde la API REST/GraphQL = throttling
  if (response.status === 429) {
    throw new BillingError("Shopify GraphQL throttled (429)", "THROTTLED", true);
  }

  const json = (await response.json()) as any;
  const result = json?.data?.appUsageRecordCreate;

  // Inspect throttling también desde el body GraphQL (Shopify a veces responde 200 con error inside)
  const errors: any[] = json?.errors ?? [];
  const isThrottled = errors.some(
    (e) => e?.extensions?.code === "THROTTLED" || /throttled|rate limit/i.test(e?.message ?? ""),
  );
  if (isThrottled) {
    throw new BillingError("Shopify GraphQL throttled", "THROTTLED", true);
  }

  // userErrors clasificados
  if (result?.userErrors?.length > 0) {
    const userErrorString = JSON.stringify(result.userErrors);
    const isCapExceeded = result.userErrors.some(
      (e: any) =>
        /cap.*exceed|exceed.*cap|capped/i.test(e.message ?? "") ||
        e.code === "CAPPED_AMOUNT_EXCEEDED",
    );

    if (isCapExceeded) {
      throw new BillingError(`Cap exceeded: ${userErrorString}`, "CAP_EXCEEDED", false);
    }

    throw new BillingError(`appUsageRecordCreate userErrors: ${userErrorString}`, "GRAPHQL_ERROR", false);
  }

  const usageRecordId = result?.appUsageRecord?.id;
  if (!usageRecordId) {
    throw new BillingError("UsageRecord no creado, sin ID", "UNKNOWN", false);
  }

  return { usageRecordId };
}

/**
 * Obtiene la suscripción activa actual del merchant.
 * Útil para descubrir el lineItemId y el cap restante.
 */
export async function getActiveSubscription(admin: AdminGraphQLClient) {
  const query = `
    query {
      currentAppInstallation {
        activeSubscriptions {
          id
          name
          status
          lineItems {
            id
            plan {
              pricingDetails {
                __typename
                ... on AppUsagePricing {
                  balanceUsed { amount currencyCode }
                  cappedAmount { amount currencyCode }
                }
              }
            }
          }
        }
      }
    }
  `;

  const response = await admin.graphql(query);
  const json = (await response.json()) as any;
  const subs = json?.data?.currentAppInstallation?.activeSubscriptions ?? [];

  // Devolvemos la primera ACTIVE (en MVP solo hay una)
  return subs.find((s: any) => s.status === "ACTIVE") ?? null;
}