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

  // AI via an OpenAI-compatible gateway (9Router, OpenRouter, LiteLLM...). When AI_BASE_URL is set
  // it is used instead of Gemini. AI_MODEL is the gateway's model or combo name.
  AI_BASE_URL: z.string().url().optional(),
  AI_API_KEY: z.string().optional(),
  AI_MODEL: z.string().optional(),
  AI_FALLBACK_MODEL: z.string().optional(),

  // Gemini direct (used when AI_BASE_URL is not set). Without a model, the assistant answers 503.
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().optional(),
  // Used for a few minutes when GEMINI_MODEL answers "high demand" / overloaded.
  GEMINI_FALLBACK_MODEL: z.string().optional(),

  // GEO Intelligence through SumoPod (OpenAI-compatible). Each model has its own API key; a model
  // without a key is not offered. Keys stay on the server and are never logged or returned.
  SUMOPOD_BASE_URL: z.string().url().default('https://ai.sumopod.com/v1'),
  SUMOPOD_GEMINI_API_KEY: z.string().optional(),
  SUMOPOD_GEMINI_MODEL: z.string().default('gemini/gemini-3.8-flash'),
  SUMOPOD_GPT_API_KEY: z.string().optional(),
  SUMOPOD_GPT_MODEL: z.string().default('gpt-6-luna'),
  GEO_EVALUATOR: z.enum(['gemini', 'gpt']).default('gemini'), // model that classifies answers
  GEO_MAX_TOKENS: z.coerce.number().int().positive().default(4000), // reasoning models need room
  GEO_TIMEOUT_MS: z.coerce.number().int().positive().default(90_000),
  GEO_TIME_BUDGET_MS: z.coerce.number().int().positive().optional(), // Vercel: pause and resume

  // Shown to users whose daily AI credits ran out (e-mail, WhatsApp link or phone number).
  ACCOUNT_MANAGER_CONTACT: z.string().optional(),

  // Summary report e-mail (SMTP). Without SMTP_HOST the e-mail buttons answer with a clear error.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_SECURE: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(), // default: true only for port 465
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().optional(), // e.g. "Creacon Social Listening <report@creacon.id>"
  APP_URL: z.string().url().optional(), // dashboard link in e-mails, e.g. https://social-listening.creacon.id
  CRON_SECRET: z.string().min(16).optional(), // Vercel Cron sends it as a Bearer token

  // Zanroo Listening webhook: Zanroo sends it as `Authorization: Bearer <secret>` or `X-Webhook-Secret`.
  ZANROO_WEBHOOK_SECRET: z.string().min(16).optional(),

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
