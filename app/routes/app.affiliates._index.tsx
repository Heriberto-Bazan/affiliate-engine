import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useFetcher, useNavigate, useLocation, data } from "react-router";
import {
  Page,
  Card,
  IndexTable,
  Text,
  Badge,
  Button,
  EmptyState,
  Checkbox,
  BlockStack,
  InlineStack,
  Box,
} from "@shopify/polaris";
import { useState } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getOrCreateShop } from "../lib/shop.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = await getOrCreateShop(session);

  const url = new URL(request.url);
  const showArchived = url.searchParams.get("archived") === "true";

  const affiliates = await prisma.affiliate.findMany({
    where: {
      shopId: shop.id,
      ...(showArchived ? {} : { deletedAt: null }),
    },
    orderBy: { createdAt: "desc" },
  });

  return data({ affiliates, showArchived });
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = await getOrCreateShop(session);

  const formData = await request.formData();
  const intent = formData.get("intent");
  const affiliateId = formData.get("id") as string;

  if (!affiliateId) {
    return data({ error: "ID requerido" }, { status: 400 });
  }

  const affiliate = await prisma.affiliate.findFirst({
    where: { id: affiliateId, shopId: shop.id },
  });

  if (!affiliate) {
    return data({ error: "Afiliado no encontrado" }, { status: 404 });
  }

  if (intent === "archive") {
    await prisma.affiliate.update({
      where: { id: affiliateId },
      data: { deletedAt: new Date() },
    });
    return data({ ok: true });
  }

  if (intent === "restore") {
    await prisma.affiliate.update({
      where: { id: affiliateId },
      data: { deletedAt: null },
    });
    return data({ ok: true });
  }

  return data({ error: "Acción inválida" }, { status: 400 });
}

export default function AffiliatesPage() {
  const { affiliates, showArchived } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();
  const navigate = useNavigate();
  const location = useLocation();
  const [archivedFilter, setArchivedFilter] = useState(showArchived);

  const isEmpty = affiliates.length === 0;

  // Navegación client-side via React Router preservando query params Shopify
  const navigateTo = (path: string) => {
    navigate(`${path}${location.search}`);
  };

  const handleArchiveToggle = (newValue: boolean) => {
    setArchivedFilter(newValue);
    const params = new URLSearchParams(location.search);
    if (newValue) {
      params.set("archived", "true");
    } else {
      params.delete("archived");
    }
    navigate(`${location.pathname}?${params.toString()}`);
  };

  const handleAction = (intent: "archive" | "restore", id: string) => {
    fetcher.submit({ intent, id }, { method: "post" });
  };

  if (isEmpty && !showArchived) {
    return (
      <Page
        title="Afiliados"
        primaryAction={{
          content: "Crear afiliado",
          onAction: () => navigateTo("/app/affiliates/new"),
        }}
      >
        <Card>
          <EmptyState
            heading="Aún no tienes afiliados"
            action={{
              content: "Crear primer afiliado",
              onAction: () => navigateTo("/app/affiliates/new"),
            }}
            image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
          >
            <p>Crea tu primer afiliado para comenzar a rastrear ventas referidas.</p>
          </EmptyState>
        </Card>
      </Page>
    );
  }

  return (
    <Page
      title="Afiliados"
      primaryAction={{
        content: "Crear afiliado",
        onAction: () => navigateTo("/app/affiliates/new"),
      }}
    >
      <BlockStack gap="400">
        <Card>
          <Box padding="400">
            <Checkbox
              label="Mostrar archivados"
              checked={archivedFilter}
              onChange={handleArchiveToggle}
            />
          </Box>

          <IndexTable
            resourceName={{ singular: "afiliado", plural: "afiliados" }}
            itemCount={affiliates.length}
            headings={[
              { title: "Código" },
              { title: "Nombre" },
              { title: "Email" },
              { title: "Comisión" },
              { title: "Estado" },
              { title: "Acciones" },
            ]}
            selectable={false}
          >
            {affiliates.map((aff, index) => (
              <IndexTable.Row id={aff.id} key={aff.id} position={index}>
                <IndexTable.Cell>
                  <Text variant="bodyMd" fontWeight="bold" as="span">
                    {aff.code}
                  </Text>
                </IndexTable.Cell>
                <IndexTable.Cell>{aff.name}</IndexTable.Cell>
                <IndexTable.Cell>{aff.email ?? "—"}</IndexTable.Cell>
                <IndexTable.Cell>{aff.commissionRate}%</IndexTable.Cell>
                <IndexTable.Cell>
                  {aff.deletedAt ? (
                    <Badge tone="critical">Archivado</Badge>
                  ) : (
                    <Badge tone="success">Activo</Badge>
                  )}
                </IndexTable.Cell>
                <IndexTable.Cell>
                  <InlineStack gap="200">
                    <Button
                      size="slim"
                      onClick={() => navigateTo(`/app/affiliates/${aff.id}`)}
                    >
                      Editar
                    </Button>
                    {aff.deletedAt ? (
                      <Button
                        size="slim"
                        onClick={() => handleAction("restore", aff.id)}
                        loading={fetcher.state !== "idle"}
                      >
                        Restaurar
                      </Button>
                    ) : (
                      <Button
                        size="slim"
                        tone="critical"
                        onClick={() => handleAction("archive", aff.id)}
                        loading={fetcher.state !== "idle"}
                      >
                        Archivar
                      </Button>
                    )}
                  </InlineStack>
                </IndexTable.Cell>
              </IndexTable.Row>
            ))}
          </IndexTable>
        </Card>
      </BlockStack>
    </Page>
  );
}