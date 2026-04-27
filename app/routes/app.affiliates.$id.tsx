import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  Form,
  redirect,
  useActionData,
  useLoaderData,
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

/**
 * Edición de un afiliado existente.
 *
 * Loader: carga el afiliado por id verificando que pertenezca al shop actual.
 * Action: valida con Zod, actualiza, captura P2002 si el código colisiona.
 */

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = await getOrCreateShop(session);

  const id = params.id;
  if (!id) {
    throw new Response("ID requerido", { status: 400 });
  }

  const affiliate = await prisma.affiliate.findFirst({
    where: { id, shopId: shop.id },
  });

  if (!affiliate) {
    throw new Response("Afiliado no encontrado", { status: 404 });
  }

  return data({ affiliate });
}

export async function action({ request, params }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = await getOrCreateShop(session);

  const id = params.id;
  if (!id) {
    return data({ error: "ID requerido" }, { status: 400 });
  }

  const existing = await prisma.affiliate.findFirst({
    where: { id, shopId: shop.id },
  });

  if (!existing) {
    return data({ error: "Afiliado no encontrado" }, { status: 404 });
  }

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
    await prisma.affiliate.update({
      where: { id },
      data: {
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
            code: "Ya existe otro afiliado con ese código en esta tienda",
          } as Record<string, string>,
          values: raw,
        },
        { status: 400 },
      );
    }
    throw err;
  }

  // Preservamos los query params al redirigir
  const url = new URL(request.url);
  return redirect(`/app/affiliates${url.search}`);
}

export default function EditAffiliatePage() {
  const { affiliate } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const location = useLocation();
  const isSubmitting = navigation.state === "submitting";

  const navigateTo = (path: string) => {
    navigate(`${path}${location.search}`);
  };

  // Type narrowing: el action puede devolver { error } o { fieldErrors, values }.
  // Solo extraemos values y fieldErrors si la respuesta es del tipo de validación.
  const formError =
    actionData && "fieldErrors" in actionData ? actionData : null;
  const previousValues = formError?.values;
  const fieldErrors: Record<string, string> = formError?.fieldErrors ?? {};

  const [code, setCode] = useState(previousValues?.code ?? affiliate.code);
  const [name, setName] = useState(previousValues?.name ?? affiliate.name);
  const [email, setEmail] = useState(
    previousValues?.email ?? affiliate.email ?? "",
  );
  const [commissionRate, setCommissionRate] = useState(
    previousValues?.commissionRate?.toString() ??
      affiliate.commissionRate.toString(),
  );

  return (
    <Page
      title={`Editar afiliado: ${affiliate.code}`}
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
                Guardar cambios
              </Button>
            </InlineStack>
          </BlockStack>
        </Form>
      </Card>
    </Page>
  );
}