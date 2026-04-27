# Affiliate Engine

Motor de afiliados para Shopify. Permite al merchant crear afiliados con un código (ej. `TIENDASMART`), captura las visitas referidas, registra las conversiones via Web Pixel en `checkout_completed`, y cobra al merchant un 5% sobre cada venta referida usando la Billing API de Shopify (UsageRecords contra una suscripción Capped Amount).

Prueba técnica para Converxity — Shopify App Developer.

## Stack

- React Router 7
- TypeScript
- React + Polaris + Shopify App Bridge
- SQLite + Prisma
- Zod para validación de inputs
- Shopify CLI 3.x (template oficial moderno)

## Instalación y ejecución local

Prerrequisitos:
- Node 20+
- npm
- Cuenta de Shopify Partners
- Development store creada en el Partner Dashboard

Pasos:

```bash
git clone https://github.com/Heriberto-Bazan/affiliate-engine
cd affiliate-engine
npm install
npx prisma migrate dev
npm run dev
```

Cuando arranque el CLI te va a pedir vincular el proyecto a una app del Partner Dashboard. Si es la primera vez, déjalo crear la app desde el flujo del CLI. Después, presiona `p` en la terminal para abrirla embebida en el admin de Shopify.

### Variables de entorno

El template del CLI genera el `.env` con las credenciales. Las relevantes:

```
SHOPIFY_API_KEY=...
SHOPIFY_API_SECRET=...
SCOPES=write_products,write_metaobjects,write_metaobject_definitions
SHOPIFY_APP_URL=...
DATABASE_URL=file:dev.sqlite
APP_FEE_RATE=0.05
BILLING_CAPPED_AMOUNT=100
```

`APP_FEE_RATE` es la tarifa fija que cobra la app al merchant (5%). `BILLING_CAPPED_AMOUNT` es el techo mensual del Capped Amount.

### Setup de la Subscription en dev

Para que el worker tenga contra qué cobrar en local, hay un seed que crea una Subscription mock activa:

```bash
npx tsx prisma/seed-subscription.ts
```

Este script es idempotente — puedes correrlo varias veces sin problema.

### Verificar el flujo end-to-end

Una vez que `npm run dev` está corriendo y la Subscription está creada:

1. En el admin de Shopify, entra a la app y crea un afiliado con código `TIENDASMART`.
2. Simula un evento de conversión con curl (esto reemplaza al Web Pixel para testing):

```powershell
Invoke-RestMethod -Uri "https://TU_TUNNEL/api/track" -Method POST -ContentType "application/json" -Body '{"affiliateCode":"TIENDASMART","shopifyOrderId":"TEST-001","orderTotal":100,"orderCurrency":"USD","shopDomain":"TU_TIENDA.myshopify.com"}'
```

3. La respuesta es `{ ok: true, eventId: ... }`.
4. Si vuelves a mandar el mismo curl, la respuesta es `{ ok: true, idempotent: true }` y NO se crea fila duplicada.
5. En 5-10 segundos, los logs del server muestran al worker procesando el job y generando el UsageRecord.

## Decisiones de arquitectura

### Estructura general

```
[Web Pixel] --POST--> /api/track --> persiste ReferralEvent + encola BillingJob --> 200
                                                |
                                                v
                                        [Worker independiente]
                                                |
                                                v
                                        appUsageRecordCreate (Shopify)
```

El endpoint que recibe del pixel responde en menos de 100ms. Solo persiste y encola. El cobro real al merchant lo hace un worker separado, asíncrono.

### ¿Por qué esa estructura?

Consideré tres opciones:

**Opción A — Sincrónica (todo en `/api/track`):** Recibir el evento, calcular, y llamar a `appUsageRecordCreate` inline antes de responder al pixel.

**Opción B — Asincrónica con cola interna en memoria:** Una `Queue` en RAM que un worker procesa.

**Opción C — Asincrónica con cola persistente en BD (la que elegí):** Una tabla `BillingJob` que un worker procesa con polling.

Descarté A porque el Web Pixel del cliente quedaría esperando por una API externa (Shopify GraphQL). Si Shopify está lento o caído, el pixel se cae. Además, en picos de tráfico (Black Friday) los reintentos del pixel multiplicarían las llamadas a Shopify y nos comeríamos el rate limit en minutos.

Descarté B porque la cola en memoria se pierde al reiniciar el server. En un escenario de fallo (deploy, crash, autoscaling) perdemos eventos. Inaceptable cuando estamos hablando de cobrar dinero.

Elegí C porque cumple los tres requisitos: (1) responde rápido al pixel, (2) sobrevive reinicios y fallos, (3) permite reintentos con backoff sin gastar rate limit innecesario.

### Idempotencia

La idempotencia es la decisión más importante de toda la arquitectura. La realidad de Web Pixels es que se ejecutan en checkouts móviles con redes inestables, y los reintentos automáticos del navegador son comunes. Un evento puede llegar 2 o 3 veces.

La garantía la pongo a **nivel de base de datos**, no a nivel de aplicación:

```prisma
model ReferralEvent {
  ...
  shopifyOrderId String
  shopId         String
  @@unique([shopId, shopifyOrderId])
}
```

Cuando llega un evento duplicado, el `INSERT` falla con `P2002` (Prisma unique constraint violation). El endpoint atrapa ese error específico y responde 200 con `{ idempotent: true }`. Para el cliente la respuesta luce idéntica a un éxito normal.

¿Por qué BD y no aplicación? Porque a nivel de aplicación tendrías una race condition: dos requests simultáneos pasan el check de "¿ya existe?" antes de que cualquiera haya hecho el INSERT, y terminan los dos creando filas. La BD garantiza atomicidad.

Probado en runtime: mando el mismo curl dos veces, la primera responde `eventId`, la segunda responde `idempotent: true`, y en `ReferralEvent` sigue habiendo solo una fila. En `BillingJob` también solo hay un job.

### Asincronía y procesamiento de billing

El endpoint `/api/track` jamás llama a Shopify Billing inline. Solo:

1. Valida el payload con Zod.
2. Resuelve el Shop (multi-tenant) y el Afiliado.
3. Calcula el 5% para la app y la comisión del afiliado.
4. Persiste `ReferralEvent`.
5. Encola `BillingJob` con `status='pending'`.
6. Responde 200 OK.

El worker (`app/worker/billing-worker.server.ts`) hace polling cada 5 segundos a la tabla `BillingJob`. En cada ciclo:

1. `SELECT BillingJob WHERE status='pending' AND lockedAt IS NULL AND nextAttemptAt <= NOW()`
2. Lockea el job con un `UPDATE WHERE lockedAt IS NULL` atómico (lock optimista).
3. Carga el `ReferralEvent` y la `Subscription` activa del shop.
4. Verifica que el cap no esté excedido.
5. Llama a `appUsageRecordCreate` con un `idempotencyKey` estable por intento.
6. Si funciona: marca el job como `succeeded`, el evento como `billed`, e incrementa `Subscription.currentUsage`.
7. Si falla con throttling: aumenta `attempts`, programa `nextAttemptAt` con backoff exponencial (30s, 2min, 10min, 30min, 2h), libera el lock.
8. Si falla con cap excedido: marca el job como `cap_exceeded`. No se reintenta.
9. Si llega a 5 intentos sin éxito: marca como `failed` definitivo.

### Manejo de throttling de Shopify GraphQL

El helper `shopify-billing.server.ts` clasifica los errores de la API en cinco categorías mediante una clase `BillingError` con flags `code` y `retriable`:

- `THROTTLED` — retriable. El worker lo reintenta con backoff.
- `CAP_EXCEEDED` — no retriable. Marca como fallido sin retry.
- `NO_SUBSCRIPTION` — no retriable. Sub no activa.
- `GRAPHQL_ERROR` — userErrors no clasificados, no retriable.
- `UNKNOWN` — fallback.

El worker inspecciona el `code` y decide si reintentar o fallar definitivo. Esto evita reintentar indefinidamente errores que nunca van a resolverse.

El backoff es exponencial: 30s, 2min, 10min, 30min, 2h. Esto le da espacio a Shopify para recuperarse de un pico de tráfico sin que nosotros lo bombardeemos.

### Adaptación para alta concurrencia (1000+ tiendas, miles de eventos/min)

El diseño actual escala con cambios mínimos:

**Endpoint `/api/track`:** Stateless, sin estado en memoria. Escala horizontalmente detrás de un load balancer. Cada réplica procesa requests independientemente. Cuello de botella: la BD. Mitigación: índices en `(shopId, shopifyOrderId)` y connection pooling en Prisma.

**Cola persistente:** En MVP es una tabla en SQLite con polling. En producción se reemplaza por **BullMQ + Redis** o **AWS SQS + Lambda**. El modelo de datos no cambia — `BillingJob` con sus campos sigue siendo el contrato. Lo que cambia es la implementación del enqueue/dequeue. La función `processJob` recibe un job y lo procesa, sin importar la fuente.

**Worker:** Hoy corre en el mismo proceso del server (timer en `start-worker.server.ts`). En producción es un proceso aparte (`docker-compose` con servicio `web` y servicio `worker`, o un AWS Lambda triggered por SQS). El lock optimista con `lockedBy` permite tener N workers en paralelo sin doble cobro — solo uno gana el lock por job.

**Rate limit de Shopify:** Cada tienda tiene su propio rate limit (40 puntos/segundo standard, 100 puntos/segundo Plus). En picos, el throttling clasificado más backoff exponencial protegen al sistema de propagar la sobrecarga.

**Idempotencia:** No cambia. Sigue siendo a nivel BD, lo cual es a prueba de race conditions sin importar cuántos workers tengas.

## Sustentación de base de datos

### Modelos

- `Shop` — root del tenant. UNIQUE en `shopDomain`. Cachea `subscriptionId` y `cappedAmount` para acceso rápido.
- `Affiliate` — UNIQUE compuesto `(shopId, code)` para multi-tenant. Soft delete via `deletedAt`.
- `ReferralEvent` — UNIQUE compuesto `(shopId, shopifyOrderId)` para idempotencia. Status: pending | billed | failed | cap_exceeded.
- `BillingJob` — la cola. Tiene `status`, `attempts`, `maxAttempts`, `nextAttemptAt`, `lockedAt`, `lockedBy`, `lastError`.
- `Subscription` — tracking del plan capped del merchant. UNIQUE en `shopifySubscriptionId`.

### Justificación del esquema

**Multi-tenant explícito:** Cada tabla relevante tiene `shopId` como FK obligatoria. Todas las queries filtran por `shopId`. Sin excepción. Esto previene fugas de datos entre merchants y permite particionamiento por shop a futuro.

**Soft delete en Affiliate:** Si un merchant archiva un afiliado y luego llega una orden referida con su código, quiero seguir registrando el evento. La comisión se calcula al momento del evento, no al momento del cobro. Para auditoría también es importante: si hay disputa con un afiliado, necesito poder consultar su historial completo.

**Status enum-like en `ReferralEvent` y `BillingJob`:** Permite separar claramente el ciclo de vida del evento (pending → billed | failed | cap_exceeded) del ciclo del job (pending → succeeded | failed | cap_exceeded). Los dos están relacionados pero son independientes para flexibilidad futura.

**Decimal vs Float para montos:** En el schema actual uso `Float` porque SQLite no tiene tipo `Decimal` nativo. **En producción esto cambia a `Decimal(18,2)`** en Postgres. Para evitar errores de redondeo, el cálculo se hace con `toFixed(2)` antes de persistir.

### Índices

```prisma
model ReferralEvent {
  @@unique([shopId, shopifyOrderId])  // idempotencia
  @@index([shopId, status])           // dashboard: filtros por estado
  @@index([shopId, createdAt])        // listado cronológico
  @@index([affiliateId])              // métricas por afiliado
}

model BillingJob {
  @@index([status, nextAttemptAt])    // CRÍTICO para el polling del worker
}

model Affiliate {
  @@unique([shopId, code])            // multi-tenant
}
```

El más importante es `[status, nextAttemptAt]` en `BillingJob`. El worker hace `WHERE status='pending' AND nextAttemptAt <= NOW()` cada 5 segundos. Sin ese índice, con miles de jobs acumulados, el query degrada cuadráticamente y el worker se vuelve un cuello de botella.

### Integridad bajo picos de tráfico

Tres mecanismos:

1. **Constraints UNIQUE a nivel BD:** Garantizan que jamás haya duplicados, sin importar la concurrencia.
2. **Transacciones explícitas en operaciones que tocan múltiples tablas:** El worker usa `prisma.$transaction([...])` para actualizar `BillingJob`, `ReferralEvent` y `Subscription` atómicamente. Si una falla, ninguna se aplica.
3. **Lock optimista en `BillingJob`:** `UPDATE BillingJob SET lockedAt=NOW() WHERE id=X AND lockedAt IS NULL`. Solo un worker gana. El resto recibe `count=0` del update y se mueve al siguiente job.

### Migración de SQLite a Postgres para producción

Pasos concretos:

1. Cambiar `datasource db { provider = "postgresql" }` en `schema.prisma`.
2. Cambiar `DATABASE_URL` al string de conexión Postgres.
3. Cambiar `Float` por `Decimal @db.Decimal(18, 2)` en campos de monto.
4. Ejecutar `npx prisma migrate deploy` contra la nueva base.
5. Configurar connection pooling (Prisma usa PgBouncer transparentemente con su `directUrl`).

### Estrategia para millones de eventos

A escala (cientos de miles a millones de `ReferralEvent`), la tabla se vuelve pesada. Plan:

1. **Particionamiento por mes** usando `createdAt`. Postgres soporta `PARTITION BY RANGE` declarativo. Las queries del último mes (90% de los casos) solo escanean una partición.
2. **Tabla de archivado** `ReferralEvent_archive` con menos índices, para queries históricas (>1 año). Job nocturno mueve registros viejos.
3. **Vistas materializadas** para el dashboard: total de comisiones por mes por shop, top afiliados, tasa de conversión. Refresco horario en background. Esto evita queries pesadas en cada render del dashboard.
4. **Réplica de lectura** para queries pesadas (reportes, dashboard). El primary se queda libre para escrituras del pixel.

### Consistencia entre el reporte del Pixel y el cobro de Billing

Este es el escenario crítico: el pixel reportó pero ¿el cobro se hizo?

La respuesta está en el ciclo de estados:

```
ReferralEvent.status:  pending → billed | failed | cap_exceeded
BillingJob.status:     pending → succeeded | failed | cap_exceeded
```

Mientras el `ReferralEvent` está en `pending`, sé que existe el reporte pero no he cobrado. Mientras el `BillingJob` está en `pending` (o en retry), sé que el cobro está en progreso.

Cuando el worker tiene éxito, hace una transacción que actualiza ambos en simultáneo: `BillingJob → succeeded` y `ReferralEvent → billed`. Si la transacción falla, ninguno se actualiza, y el job sigue en `pending` para que el siguiente ciclo del worker lo retome.

Esto garantiza que **nunca** tendremos un evento `billed` sin su `BillingJob` `succeeded`, ni viceversa. Son atómicos.

Para reconciliación periódica (job nocturno), se puede correr una query de auditoría: `SELECT * FROM ReferralEvent WHERE status='pending' AND createdAt < NOW() - INTERVAL '1 hour'`. Si aparece algo ahí, hay un problema (worker caído, job stuck) y disparamos alerta.

## Sustentación de DevOps

### Gestión de entornos

Tres entornos:

**dev:** Cada desarrollador en su máquina local. SQLite. Túnel de Shopify CLI con dominio efímero. La app de Shopify en el Partner Dashboard está en distribución "custom" apuntando a la development store del dev.

**staging:** Postgres compartido (instancia managed pequeña). Servidor en Render/Fly.io con dominio fijo de staging. App de Shopify separada en el Partner Dashboard, apuntando a una test store dedicada para QA. Usa el mismo modelo de distribución custom que dev.

**prod:** Postgres con réplica de lectura. Redis para BullMQ. Múltiples réplicas del server detrás de un load balancer. App de Shopify publicada en App Store (o distribución Plus para enterprise). Dominio propio de la app.

La separación de apps en el Partner Dashboard (no compartirlas entre entornos) es clave: cada entorno tiene su propia API key, sus propios secrets, sus propios webhooks. Esto previene que un test en staging dispare un cobro real en prod.

### Pipelines de CI/CD

Workflow propuesto en GitHub Actions:

**`.github/workflows/ci.yml` — corre en cada PR:**

1. Checkout del código.
2. `npm ci` (install determinístico desde `package-lock.json`).
3. `npx prisma generate` (genera types).
4. `npx tsc --noEmit` (type check sin emitir archivos).
5. `npm run lint` (ESLint).
6. `npx prisma migrate diff` (detecta drift entre `schema.prisma` y migraciones).
7. `npm test` — suite de tests unitarios (Vitest) y de integración.
8. `npx playwright test` — tests E2E del flujo completo (pixel → endpoint → worker).

Si cualquier paso falla, el PR no puede mergear.

**`.github/workflows/deploy-staging.yml` — al merge a `main`:**

1. Todo lo anterior.
2. `npx prisma migrate deploy` contra Postgres staging (con backup previo).
3. `shopify app deploy` para sincronizar config y extensiones de la app de Shopify staging.
4. Build del Docker image y push al registry.
5. Deploy a Render/Fly.io con health check (espera a que `/healthz` responda 200 antes de cortar la versión vieja — zero downtime).
6. Smoke tests post-deploy contra staging.
7. Notificación a Slack del equipo.

**`.github/workflows/deploy-prod.yml` — manual approval:**

Igual que staging pero contra prod. Requiere approval explícito de un reviewer en GitHub. Incluye:
- Backup de Postgres antes de migrar.
- Rolling deploy (no big-bang). Si un health check falla, rollback automático.
- Canary: 5% de tráfico al nuevo deploy por 10 minutos antes de hacer 100%.

### Estrategia de despliegue

**Containerización con Docker** (multi-stage):

```dockerfile
# Stage 1: deps
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

# Stage 2: builder
FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate && npm run build

# Stage 3: runner
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/build ./build
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY package*.json ./
EXPOSE 3000
CMD ["npm", "start"]
```

El worker corre como servicio separado en `docker-compose` (en VPS) o como Lambda triggered por SQS (en AWS), reusando el mismo código de `processJob`.

**Hosting recomendado:**

- **Server:** Render o Fly.io para apps de tamaño medio. AWS ECS Fargate para enterprise.
- **DB:** Postgres managed (Neon, Supabase, RDS). Réplica de lectura desde el día uno.
- **Redis:** Upstash o ElastiCache para BullMQ.
- **CDN:** Cloudflare delante del frontend.
- **Logs y observability:** Sentry para errores, DataDog o Axiom para logs estructurados.

**Variables de entorno:**

- En **dev:** `.env` local, gitignoreado.
- En **staging y prod:** Secrets manager del cloud provider. AWS Secrets Manager, Vercel env vars, Render config, según el host.
- **Nunca** credenciales en el repositorio.

**Rotación de secretos:**

- API keys de Shopify se rotan vía el Partner Dashboard. Después de rotar, deploy nuevo con la key actualizada y revoke de la vieja.
- Database passwords se rotan via el secrets manager cada 90 días con un script automatizado que actualiza la conexión y verifica salud antes de revocar la anterior.
- Los `idempotencyKey` que generamos son determinísticos por evento (`{eventId}-{attemptNumber}`), entonces no necesitan rotación.

**Monitoreo de salud (health checks):**

Tres endpoints expuestos:

- `/healthz` — liveness check. Responde 200 si el proceso está vivo. Sin tocar BD ni Redis.
- `/readyz` — readiness check. Responde 200 si BD y Redis responden. Si falla, el load balancer saca al pod del pool hasta que recupere.
- `/metrics` — expone métricas en formato Prometheus: jobs procesados, jobs fallidos, latencia del endpoint, errores GraphQL clasificados.

Alertas configuradas:
- Si `BillingJob` con status=`pending` excede 5 minutos sin procesar → alerta (worker caído).
- Si tasa de errores GraphQL > 5% en 10 minutos → alerta (Shopify down o problema de credenciales).
- Si `Subscription.currentUsage` se acerca al cap (>90%) → alerta al merchant proactivamente.

### Git Flow

Trunk-based development con feature branches cortas (vida máxima 2 días). Convenciones:

- Branches: `feat/`, `fix/`, `chore/`, `refactor/`.
- Commits con prefijo y descripción imperativa: `feat: add idempotency to /api/track`.
- PRs requieren al menos 1 reviewer y CI verde.
- Merge con squash a `main`.

## Deuda técnica documentada

Cosas que dejé fuera por tiempo y son honestas para el evaluador:

- **Captura del `?ref=` en storefront:** El flujo del lado del Web Pixel está completo, pero el script que persiste el `_ref` desde la URL del storefront a `cart.attributes` (theme app extension) no lo terminé. Diseño documentado: una extensión que ejecute `fetch('/cart/update.js', { method: 'POST', body: { attributes: { _ref: codigoDelRef } } })` cuando detecta el query param.

- **HMAC validation en `/api/track`:** Hoy el endpoint acepta cualquier POST con el shape correcto. En producción debe verificar que el origen sea el Web Pixel real con un secreto compartido. Cambio de ~20 líneas en el endpoint.

- **Tests automatizados:** No alcancé a escribirlos. Para producción son obligatorios: Vitest para unit, Playwright para E2E del flujo completo (curl al endpoint, esperar al worker, verificar BD).

- **Página de edición de afiliado:** La UI muestra botón "Editar" pero la ruta `app/routes/app.affiliates.$id.tsx` no la armé. El action handler de PATCH ya está en el listado, falta el componente.

- **Dashboard de métricas:** La home `app._index.tsx` tiene placeholder. En producción mostraría: ventas referidas del mes, total de comisiones generadas, top afiliados, gráfica de conversión.

- **Limitación de la Billing API en distribución custom:** Shopify bloquea `appUsageRecordCreate` y `appSubscriptionCreate` para apps no listadas (mensaje: *"Custom apps cannot use the Billing API"*). El código GraphQL está completamente implementado en `app/lib/shopify-billing.server.ts`. Para demostrar el flujo completo en local, el worker detecta la Subscription mock (prefix `MOCK-DEV-`) y simula éxito directamente. Cuando la app pase a distribución pública (con review de Shopify), el código funciona sin cambios.

## Repositorio

https://github.com/Heriberto-Bazan/affiliate-engine