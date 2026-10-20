# be-social-listening

API for the Social Listening & Brand Intelligence dashboard: Excel ingestion of Zanroo exports, filtered analytics (volume, SOV, net sentiment), a mentions feed, and an AI Brand Assistant (Gemini) that answers from the same numbers.

Stack: NestJS 12 (ESM) · Prisma 7 + MySQL (`@prisma/adapter-mariadb`) · AI SDK 7 + `@ai-sdk/google` · exceljs.

## Local setup

Requires Node 20+ and npm 11 (npm 10.9 fails on this dependency tree with `Cannot read properties of null (reading 'edgesOut')`).

```bash
cp .env.example .env            # fill JWT_SECRET, SEED_ADMIN_*; DATABASE_URL points at local MySQL
docker compose up -d mysql      # or any MySQL 8
npm install                     # also runs `prisma generate`
npm run db:migrate -- --name init   # first time only: creates prisma/migrations; commit it
npm run db:seed                 # project, 5 brands with keyword aliases, admin user
npm run start:dev               # http://localhost:3001, Swagger at /api/docs
```

Upload the monthly file (local/VPS mode):

```bash
curl -X POST localhost:3001/api/projects/1/ingestion/excel/upload \
  -H "authorization: Bearer <token from /api/auth/login>" \
  -F "file=@All_Brand_Hutchison_september_2026.xlsx"
# then poll GET /api/projects/1/ingestion/batches/<id>
```

## Scripts

| Script | What it does |
|---|---|
| `npm run start:dev` | Watch mode |
| `npm run build` / `npm start` | Production build / run |
| `npm test` | Unit tests (vitest) |
| `npm run typecheck`, `npm run lint` | tsc, oxlint |
| `npm run db:migrate` / `db:deploy` / `db:seed` | Prisma migrate dev / deploy / seed |
| `npm run openapi` | Writes `docs/api-spec/openapi.json` (the FE contract) |

## Deploy

**Vercel (MVP).** Import the repo; Vercel detects NestJS. Set env vars from `.env.example` (`DATABASE_URL` with `?ssl=true` for PlanetScale/TiDB, `JWT_SECRET`, `GEMINI_API_KEY`, `GEMINI_MODEL`). Run `npm run db:deploy` against the production database from CI or your machine, never at runtime. Large Excel files are uploaded by the browser straight to Vercel Blob and the API receives the URL (`POST /ingestion/excel`), because function request bodies are capped at 4.5 MB. Long files pause near the time limit and are resumed with `POST /ingestion/batches/:id/resume`.

**VPS (Biznet).** `docker compose --profile vps up -d --build`, or PM2 with `ecosystem.config.cjs`. Uses the multipart upload endpoint; no time budget applies.

## Layout

```
prisma/            schema.prisma, seed.ts (brand aliases), migrations/
src/config/        env validation
src/database/      PrismaService (MySQL via mariadb adapter)
src/common/        auth decorators, global guards (JWT, roles, project membership)
src/modules/
  ingestion/       domain (ports) · application (core) · adapters/excel
  mentions/        shared filter, mentions feed, MentionWriter
  analytics/       aggregate SQL: overview, competitors (SOV, net sentiment, ratio), trend
  assistant/       Gemini tools over AnalyticsService, chat history
docs/              architecture.md, api-spec/openapi.json
```

See `docs/architecture.md` for the ingestion design and metric definitions.
