import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// DATABASE_URL is optional so `prisma generate` also works in CI/Docker builds without a database.
// Migrate commands still require it.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  ...(process.env.DATABASE_URL ? { datasource: { url: process.env.DATABASE_URL } } : {}),
});
