import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  Form,
  redirect,
  useActionData,
  useNavigation,
  useNavigate,
  useLocation,
  data,
} from "react-router";
import {
  Page,
  Card,
  FormLayout,
  TextField,
  Button,
  Banner,
  InlineStack,
  BlockStack,
} from "@shopify/polaris";
import { useState } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getOrCreateShop } from "../lib/shop.server";
import { affiliateSchema } from "../lib/validators";

export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.admin(request);
  return null;
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = await getOrCreateShop(session);

  const formData = await request.formData();
  const raw = {
    code: String(formData.get("code") ?? ""),
    name: String(formData.get("name") ?? ""),
    email: String(formData.get("email") ?? ""),
    commissionRate: Number(formData.get("commissionRate") ?? 0),
  };

  const result = affiliateSchema.safeParse(raw);

  if (!result.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of result.error.issues) {
      const field = String(issue.path[0]);
      if (!fieldErrors[field]) fieldErrors[field] = issue.message;
    }
    return data({ fieldErrors, values: raw }, { status: 400 });
  }

  try {
    await prisma.affiliate.create({
      data: {
        shopId: shop.id,
        code: result.data.code,
        name: result.data.name,
        email: result.data.email,
        commissionRate: result.data.commissionRate,
      },
    });
  } catch (err: any) {
    if (err?.code === "P2002") {
      return data(
        {
          fieldErrors: {
            code: "Ya existe un afiliado con ese código en esta tienda",
          } as Record<string, string>,
          values: raw,
        },
        { status: 400 },
      );
    }
    throw err;
  }

  // Preservamos los query params al redirigir para mantener la sesión Shopify
  const url = new URL(request.url);
  const search = url.search;
  return redirect(`/app/affiliates${search}`);
}

export default function NewAffiliatePage() {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const location = useLocation();
  const isSubmitting = navigation.state === "submitting";

  // Navegación client-side via React Router preservando query params Shopify
  const navigateTo = (path: string) => {
    navigate(`${path}${location.search}`);
  };

  const [code, setCode] = useState(actionData?.values?.code ?? "");
  const [name, setName] = useState(actionData?.values?.name ?? "");
  const [email, setEmail] = useState(actionData?.values?.email ?? "");
  const [commissionRate, setCommissionRate] = useState(
    actionData?.values?.commissionRate?.toString() ?? "10",
  );

  const fieldErrors: Record<string, string> = actionData?.fieldErrors ?? {};

  return (
    <Page
      title="Crear afiliado"
      backAction={{
        content: "Afiliados",
        onAction: () => navigateTo("/app/affiliates"),
      }}
    >
      <Card>
        <Form method="post">
          <BlockStack gap="400">
            {Object.keys(fieldErrors).length > 0 && (
              <Banner tone="critical" title="Revisa los campos">
                <p>Hay errores en el formulario. Corrígelos para continuar.</p>
              </Banner>
            )}

            <FormLayout>
              <TextField
                label="Código del afiliado"
                name="code"
                value={code}
                onChange={setCode}
                autoComplete="off"
                helpText="Identificador único usado en los enlaces (?ref=CODIGO). Solo mayúsculas, números, guiones y guiones bajos."
                error={fieldErrors.code}
                requiredIndicator
              />
              <TextField
                label="Nombre"
                name="name"
                value={name}
                onChange={setName}
                autoComplete="off"
                error={fieldErrors.name}
                requiredIndicator
              />
              <TextField
                label="Email (opcional)"
                name="email"
                type="email"
                value={email}
                onChange={setEmail}
                autoComplete="email"
                error={fieldErrors.email}
              />
              <TextField
                label="Comisión (%)"
                name="commissionRate"
                type="number"
                value={commissionRate}
                onChange={setCommissionRate}
                autoComplete="off"
                helpText="Porcentaje de la venta que recibirá el afiliado. Entre 0 y 100."
                min={0}
                max={100}
                step={0.01}
                error={fieldErrors.commissionRate}
                requiredIndicator
              />
            </FormLayout>

            <InlineStack gap="200" align="end">
              <Button onClick={() => navigateTo("/app/affiliates")}>
                Cancelar
              </Button>
              <Button submit variant="primary" loading={isSubmitting}>
                Guardar
              </Button>
            </InlineStack>
          </BlockStack>
        </Form>
      </Card>
    </Page>
  );
}