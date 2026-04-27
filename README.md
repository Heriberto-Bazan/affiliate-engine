# Affiliate Engine

Motor de afiliados embebido para Shopify.

Prueba técnica para Converxity — Shopify App Developer.

Para sustentación técnica, decisiones de arquitectura, sustentación de base de datos y DevOps, ver [`ARCHITECTURE.md`](./ARCHITECTURE.md).

---

## Stack

- React Router 7
- TypeScript
- React + Polaris + Shopify App Bridge
- SQLite + Prisma
- Zod
- Shopify CLI 3.x

---

## Prerrequisitos

- Node 20+
- npm
- Cuenta de Shopify Partners
- Development store
- Git

---

## Instalación

```bash
git clone https://github.com/Heriberto-Bazan/affiliate-engine
cd affiliate-engine
npm install
```

---

## Variables de entorno

Crear un archivo `.env` en la raíz del proyecto con el siguiente contenido:

```
WEB_PIXEL_HMAC_SECRET=dev_secret_change_in_production_a8f3k9d2m4n6
APP_FEE_RATE=0.05
BILLING_CAPPED_AMOUNT=100
```

Las credenciales de Shopify (`SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, `SCOPES`) las gestiona automáticamente el Shopify CLI vía `shopify.app.toml`.

---

## Migraciones de base de datos

```bash
npx prisma migrate dev
```

---

## Seed de la Subscription mock para desarrollo

```bash
npx tsx prisma/seed-subscription.ts
```

Este script es idempotente. Crea una Subscription activa simulada para que el worker tenga contra qué cobrar en local.

---

## Levantar la app

```bash
npm run dev
```

El CLI de Shopify pide vincular el proyecto con una app del Partner Dashboard la primera vez. Después de arrancar, presionar `p` en la terminal abre la app embebida en el admin de Shopify.

---

## Probar el endpoint `/api/track` con HMAC

```powershell
$body = '{"affiliateCode":"TIENDASMART","shopifyOrderId":"TEST-001","orderTotal":100,"orderCurrency":"USD","shopDomain":"TU_TIENDA.myshopify.com"}'
$secret = "dev_secret_change_in_production_a8f3k9d2m4n6"
$hmac = New-Object System.Security.Cryptography.HMACSHA256
$hmac.Key = [Text.Encoding]::UTF8.GetBytes($secret)
$signature = [BitConverter]::ToString($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($body))).Replace("-","").ToLower()

Invoke-RestMethod -Uri "https://TU_TUNNEL/api/track" -Method POST -ContentType "application/json" -Body $body -Headers @{"x-pixel-signature"=$signature}
```

Reemplazar `TU_TUNNEL` por la URL del túnel de Cloudflare que muestra `npm run dev` (línea `Using URL: https://...`) y `TU_TIENDA` por el dominio de la dev store.

---

## Cómo probar el flujo end-to-end

### A) Crear un afiliado desde la UI

1. En el admin de la app, click en "Afiliados" en el menú lateral.
2. Click en "Crear afiliado".
3. Llenar el formulario:
   - Código: `TIENDASMART`
   - Nombre: `Tienda Smart`
   - Comisión: `10`
4. Guardar.

El afiliado aparece en la tabla.

### B) Simular un evento de venta referida con HMAC

En **otra terminal** (PowerShell), ejecutar el bloque de la sección "Probar el endpoint `/api/track` con HMAC".

Respuesta esperada:

```
   ok eventId
   -- -------
True clxxxxxx...
```

### C) Probar idempotencia

Ejecutar el mismo comando de B) una segunda vez. Respuesta esperada:

```
   ok idempotent
   -- ----------
True       True
```

El sistema detecta el duplicado y no procesa el evento dos veces.

### D) Probar que HMAC bloquea peticiones sin firma

Ejecutar el mismo POST pero sin el header `x-pixel-signature`:

```powershell
Invoke-RestMethod -Uri "https://TU_TUNNEL/api/track" -Method POST -ContentType "application/json" -Body '{"affiliateCode":"TIENDASMART","shopifyOrderId":"TEST-002","orderTotal":100,"orderCurrency":"USD","shopDomain":"TU_TIENDA.myshopify.com"}'
```

Respuesta esperada:

```
Invoke-RestMethod : Error en el servidor remoto: (401) No autorizado.
```

### E) Ver al worker procesar la cola

En la terminal donde corre `npm run dev`, esperar 5-10 segundos después del paso B. Aparecen logs:

```
[billing-worker] Procesando job ... (intento 1)
[billing-worker] MOCK Subscription detectada. Simulando UsageRecord OK por $5 USD
```

### F) Ver el dashboard actualizado

Volver al admin de la app, navegar a la home (Dashboard). Las 3 métricas se actualizan con el evento procesado:

- Total ventas referidas
- Comisiones generadas para la app (5%)
- Comisiones a pagar a afiliados

### G) Inspeccionar la BD con Prisma Studio (opcional)

```bash
npx prisma studio
```

Abre una GUI en `http://localhost:5555` para inspeccionar todas las tablas (`Affiliate`, `ReferralEvent`, `BillingJob`, `Subscription`, `Shop`).

---

## Estructura del proyecto

```
app/
├── routes/
│   ├── app._index.tsx              # dashboard
│   ├── app.tsx                     # layout embedded
│   ├── app.affiliates._index.tsx   # listado afiliados
│   ├── app.affiliates.new.tsx      # crear afiliado
│   ├── app.affiliates.$id.tsx      # editar afiliado
│   ├── app.billing.setup.tsx       # crear Subscription
│   └── api.track.tsx               # endpoint del Web Pixel
├── lib/
│   ├── shop.server.ts
│   ├── validators.ts
│   ├── hmac.server.ts
│   └── shopify-billing.server.ts
├── worker/
│   ├── billing-worker.server.ts
│   └── start-worker.server.ts
└── shopify.server.ts
extensions/
├── affiliate-tracker/              # Web Pixel
└── affiliate-ref-capture/          # Theme app extension (?ref capture)
prisma/
├── schema.prisma
├── migrations/
└── seed-subscription.ts
```

---

## Comandos útiles

```bash
npx prisma studio                   # GUI para inspeccionar la BD
npx prisma migrate dev              # crear nueva migración
npx prisma migrate deploy           # aplicar migraciones (producción)
npm run dev                         # levantar app + worker
shopify app deploy                  # desplegar config y extensiones
```

---

## Repositorio

https://github.com/Heriberto-Bazan/affiliate-engine