/**
 * HMAC validation para autenticar peticiones del Web Pixel.
 *
 * Usa SHA-256 con un secreto compartido entre el pixel y el backend.
 * El pixel firma el body del POST, el backend recalcula y compara.
 *
 * En producción, el secreto se inyecta al pixel via `settings.accountID`
 * o un endpoint de bootstrap, y se rota periódicamente.
 */

import crypto from "node:crypto";

/**
 * Calcula HMAC SHA-256 del payload.
 */
export function computeHmac(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

/**
 * Verifica que el HMAC recibido coincida con el calculado.
 * Usa timingSafeEqual para evitar timing attacks.
 */
export function verifyHmac(
  payload: string,
  receivedHmac: string,
  secret: string,
): boolean {
  if (!receivedHmac || !secret) return false;

  const expected = computeHmac(payload, secret);

  // Comparación de tiempo constante (resistente a timing attacks)
  const expectedBuf = Buffer.from(expected, "hex");
  const receivedBuf = Buffer.from(receivedHmac, "hex");

  if (expectedBuf.length !== receivedBuf.length) return false;

  return crypto.timingSafeEqual(expectedBuf, receivedBuf);
}