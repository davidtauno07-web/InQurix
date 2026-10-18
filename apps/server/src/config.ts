import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().default(4100),
  APP_URL: z.string().url().default('http://localhost:4100'),
  SECRET_KEY: z.string().min(32, 'SECRET_KEY must be at least 32 characters (base64 of 32 random bytes)'),
  ENTITLEMENT_PRIVATE_KEY: z.string().default(''),
  ENTITLEMENT_PUBLIC_KEY: z.string().default(''),
  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  SMTP_URL: z.string().default(''),
  MAIL_FROM: z.string().default('InQurix <no-reply@localhost>'),
  PADDLE_ENV: z.enum(['sandbox', 'production']).default('sandbox'),
  PADDLE_API_KEY: z.string().default(''),
  PADDLE_WEBHOOK_SECRET: z.string().default(''),
  PADDLE_PRICE_PRO_MONTHLY: z.string().default(''),
  PADDLE_PRICE_BUSINESS_MONTHLY: z.string().default(''),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const r = schema.safeParse(env);
  if (!r.success) throw new Error(`Invalid server configuration: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return r.data;
}

export const config = loadConfig();
export const secureCookies = config.APP_URL.startsWith('https://');
