import { runWorkerCycle } from "./billing-worker.server";

const POLL_INTERVAL_MS = 5000;
let started = false;

export function startBillingWorker() {
  if (started) return;
  started = true;

  console.log("[billing-worker] Worker iniciado, polling cada 5s");

  const tick = async () => {
    try {
      await runWorkerCycle();
    } catch (err) {
      console.error("[billing-worker] Error en cycle:", err);
    } finally {
      setTimeout(tick, POLL_INTERVAL_MS);
    }
  };

  setTimeout(tick, 2000);
}