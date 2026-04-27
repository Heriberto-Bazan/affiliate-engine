import { z } from "zod";

export const affiliateSchema = z.object({
  code: z
    .string()
    .trim()
    .min(3, "El código debe tener al menos 3 caracteres")
    .max(32, "El código no puede exceder 32 caracteres")
    .regex(/^[A-Z0-9_-]+$/, "Solo letras mayúsculas, números, guiones y guiones bajos")
    .transform((val) => val.toUpperCase()),

  name: z
    .string()
    .trim()
    .min(2, "El nombre debe tener al menos 2 caracteres")
    .max(100, "El nombre no puede exceder 100 caracteres"),

  email: z
    .string()
    .trim()
    .email("Email inválido")
    .optional()
    .or(z.literal("").transform(() => undefined)),

  commissionRate: z
    .number({ error: "La comisión debe ser un número" })
    .min(0, "La comisión no puede ser negativa")
    .max(100, "La comisión no puede ser mayor al 100%")
    .multipleOf(0.01, "Máximo 2 decimales"),
});

export type AffiliateInput = z.infer<typeof affiliateSchema>;