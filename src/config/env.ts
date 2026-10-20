import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  PORT: z.coerce.number().int().default(3001),

  DATABASE_URL: z.string().startsWith('mysql://'),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 60 * 12),

  // Comma-separated list of allowed browser origins (only needed when the FE calls the BE cross-origin).
  CORS_ORIGINS: z.string().default('http://localhost:3000'),

  // Gemini. When GEMINI_API_KEY is missing, the assistant endpoints answer 503.
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().optional(),

  // Excel ingestion.
  UPLOAD_DIR: z.string().default('./uploads'), // Docker/PM2 mode: multipart uploads land here
  BLOB_HOST_SUFFIX: z.string().default('.blob.vercel-storage.com'),
  BLOB_READ_WRITE_TOKEN: z.string().optional(), // needed to read files from a private Blob store
  INGESTION_TIME_BUDGET_MS: z.coerce.number().int().positive().optional(),

  // Set automatically by Vercel.
  VERCEL: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid environment: ${issues}`);
  }
  return parsed.data;
}
