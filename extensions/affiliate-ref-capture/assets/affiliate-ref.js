/**
 * Affiliate Ref Capture
 *
 * Detecta cuando un cliente visita la tienda con ?ref=CODIGO en la URL.
 * Persiste el código en cart.attributes._ref vía la API de Shopify.
 * El Web Pixel lo recupera de ahí cuando se completa el checkout.
 *
 * Storage:
 *   - cart.attributes._ref: persistente durante toda la sesión de compra,
 *     sobrevive cross-domain entre storefront y checkout.
 *   - localStorage como fallback para detección posterior antes de añadir al cart.
 */

(function () {
  "use strict";

  const REF_PARAM = "ref";
  const REF_ATTR_KEY = "_ref";
  const STORAGE_KEY = "affiliate_ref";

  function getRefFromUrl() {
    try {
      const params = new URLSearchParams(window.location.search);
      return params.get(REF_PARAM);
    } catch {
      return null;
    }
  }

  function getStoredRef() {
    try {
      return window.localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  }

  function storeRef(ref) {
    try {
      window.localStorage.setItem(STORAGE_KEY, ref);
    } catch {
      // localStorage bloqueado (modo privado, etc.) — no bloqueamos el flujo
    }
  }

  /**
   * Persiste el código en cart.attributes._ref.
   * Esto sobrevive cross-domain entre storefront y checkout, que es lo que
   * el Web Pixel lee cuando se dispara checkout_completed.
   */
  async function persistRefToCart(ref) {
    try {
      const response = await fetch("/cart/update.js", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          attributes: {
            [REF_ATTR_KEY]: ref,
          },
        }),
      });

      if (!response.ok) {
        console.warn("[affiliate-ref] Cart update no-OK:", response.status);
      }
    } catch (err) {
      console.warn("[affiliate-ref] Error actualizando cart:", err);
    }
  }

  function init() {
    // 1. ¿Hay ref en la URL? Tiene prioridad sobre cualquier ref previo.
    const urlRef = getRefFromUrl();

    if (urlRef && urlRef.length > 0 && urlRef.length <= 64) {
      const cleanRef = urlRef.toUpperCase().replace(/[^A-Z0-9_-]/g, "");
      if (cleanRef.length >= 3) {
        storeRef(cleanRef);
        persistRefToCart(cleanRef);
        return;
      }
    }

    // 2. Si no hay ref en URL pero sí en localStorage (visita previa), lo
    //    re-aplicamos al cart por si acaso es la primera adición de producto.
    const storedRef = getStoredRef();
    if (storedRef) {
      persistRefToCart(storedRef);
    }
  }

  // Esperamos a que el DOM esté listo
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();