# Architecture

## Ingestion: ports and adapters

The core only understands `NormalizedMention`. A data source is an adapter implementing `IngestionSource`:

```
Excel upload (now)          Cron / webhook (later)
        │                            │
 IngestionController ────────┬───────┘
                             ▼
                    IngestionService          core: batch, validation, brand mapping, chunked writes
        ┌────────────────────┼────────────────────┐
        ▼                    ▼                    ▼
 IngestionSource      MentionValidator      MentionWriter (port)
 ├ ExcelIngestionSource   BrandResolver       └ PrismaMentionWriter
 └ ApiIngestionSource (phase 2)
```

Adding API ingestion = one new class implementing `IngestionSource`, registered in `ingestion.module.ts`, plus a trigger (cron or webhook) that calls `IngestionService.start({ type: 'API_PULL', ... })`. Core, schema, analytics and FE do not change.

Behaviour:

- Rows are written in chunks of 500. `(projectId, externalId)` is unique and inserts use `INSERT IGNORE`, so re-uploading the same file is safe: duplicates are counted as `skippedRows`.
- Rows without any brand are stored; their keywords are counted in `unmappedKeywords` on the batch.
- On Vercel a batch pauses after `INGESTION_TIME_BUDGET_MS` (default 240 s) with `processedRows` saved; `resume` re-reads the file and skips persisted rows. A `PROCESSING` batch untouched for 5 minutes is considered dead and can be resumed.
- Measured locally (MySQL 8, same machine): the September 2026 file, 77,456 rows / 33 MB, was ingested in 87 s with 0 failed rows.

## Brand mapping

Zanroo exports have no brand column. Brands are derived from the `Keyword` column: exact, case-insensitive match against each brand's name and `aliases`. A keyword may belong to two brands (e.g. "Indosat Ooredoo Hutchison" → Indosat and Tri; "XLSmart" → XL and Smartfren). Aliases are seeded in `prisma/seed.ts` and editable via `PUT /projects/:id/brands/:brandId/aliases` (future uploads only).

## Metrics

| Metric | Definition |
|---|---|
| Volume (brand) | Mentions naming the brand; a mention naming two brands counts for both |
| SOV (brand) | Brand volume ÷ sum of all brand volumes × 100 |
| Own brands | Indosat + Tri as one group, unique mentions |
| Own SOV | Own unique mentions ÷ unique mentions naming any brand × 100 |
| Net Sentiment | (positive − negative) ÷ total × 100, from labels |
| ratioToOwn | Brand volume ÷ own unique mentions (pending confirmation of the "Ratio" column definition) |

Date presets (`today`, `7d`, `30d`) count back from the latest mention in the project, because data arrives in monthly files. Days are WIB calendar days; timestamps are stored in UTC.

## AI Brand Assistant

`POST /projects/:id/assistant/sessions/:sessionId/chat` streams an AI SDK UI message stream (SSE). The model can call three tools that wrap `AnalyticsService` and `MentionsService`: `get_overview`, `compare_brands`, `top_mentions`. The project id is fixed by the server; the dashboard filter is the default and the model may override range/channels/sentiments. History is read from the database (last 20 text messages). Every answer stores `toolCalls`, `filtersSnapshot`, model and token counts.

`top_mentions` sends up to 10 mention texts (280 characters each) to Google. Check the data-use terms of your Gemini key tier before using client data.
