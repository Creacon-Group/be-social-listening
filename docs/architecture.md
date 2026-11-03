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
| Net Sentiment | (positive − negative) ÷ total × 100, from labels. Per project (`projects.nssIncludeNeutral = false`): ÷ (positive + negative) instead |
| Owned / earned | Owned = Zanroo tag `Brand Voice` or an author marked `OFFICIAL` in `account_profiles`; earned = all other mentions |
| Account type | Manual (`account_profiles.accountType`) wins; else Brand Voice → OFFICIAL, Online News/Blog → MEDIA, Zanroo influencer tier tag (Nano…Mega) → KOL, else OTHER |
| Paid / organic | Only from `account_profiles.isPaid`, set by analysts (bulk via `PUT /projects/:id/accounts`); applies to every mention of that author |
| Engagement | Zanroo `Engagements` column (includes video views); breakdown from Likes/Comments/Shares/Views/Bookmarks and reactions in `extra.reactions` |
| Growth | Change against the previous period of the same length; Net Sentiment change in points |
| ratioToOwn | Brand volume ÷ own unique mentions (pending confirmation of the "Ratio" column definition) |

Trends take `?interval=hour|day|week|month|quarter|year` (WIB buckets, weeks start Monday; hourly only up to 31 days). Keywords (`extra.keywords`) keep the raw Zanroo Keyword values, so campaign keywords such as "Activation Tri" can be filtered (`keywords=`) and ranked (`/analytics/keywords`). Re-uploading a file backfills `keywords`, `keywordType` and `reactions` on existing rows.

Date presets (`today`, `7d`, `30d`, `90d`, `365d`) count back from the latest mention in the project, because data arrives in monthly files. Days are WIB calendar days; timestamps are stored in UTC.

## AI Brand Assistant

`POST /projects/:id/assistant/sessions/:sessionId/chat` streams an AI SDK UI message stream (SSE). The model can call three tools that wrap `AnalyticsService` and `MentionsService`: `get_overview`, `compare_brands`, `top_mentions`. The project id is fixed by the server; the dashboard filter is the default and the model may override range/channels/sentiments. History is read from the database (last 20 text messages). Every answer stores `toolCalls`, `filtersSnapshot`, model and token counts.

`top_mentions` sends up to 10 mention texts (280 characters each) to Google. Check the data-use terms of your Gemini key tier before using client data.

## GEO Intelligence (AI visibility)

Module `src/modules/geo`. Measures how AI models answer consumer questions about the category, through SumoPod (OpenAI-compatible, `POST {SUMOPOD_BASE_URL}/chat/completions`).

- **Models**: Gemini and GPT, one API key each (`SUMOPOD_GEMINI_*`, `SUMOPOD_GPT_*`); a model without a key is not run. Capabilities verified on 2026-11-03: Gemini supports `web_search_options` and returns `message.annotations[].url_citation` (title = domain, url = Google redirect); GPT returns no annotations, so it runs in knowledge mode only. `max_tokens` defaults to 4000 because GPT spends most output tokens on reasoning.
- **Modes**: `KNOWLEDGE` (plain chat) and `SEARCH` (Gemini with web search). Results are never combined across modes.
- **Benchmark**: one per project = all `APPROVED` prompts. Editing a prompt adds an immutable version; runs keep the version they used.
- **Once a month**: `geo_batches` is unique on `(projectId, period)` (WIB `YYYY-MM`). Vercel Cron calls `/api/cron/geo` daily; it starts the month's batch on/after `projects.geoRunDay` when `geoEnabled`, and resumes paused batches. Admins can start the month's batch by hand if it has not run; a second batch in the same month answers 409. Failed runs can be retried inside the batch.
- **Execution**: runs (prompt version × model × mode × run number) are processed 3 at a time with a time budget, then paused and resumed (same pattern as Excel ingestion). Transient errors (timeout, network, 429, 5xx, empty answer) are retried twice; invalid model / auth errors fail the run at once. The raw provider response is stored and never modified. API keys are never logged or returned.
- **Evaluation** (`v1`, versioned, re-runnable without new generations): mentions by whole-word alias match (target = all own brands as one group, competitors = other brands); position only from a numbered list in the answer; recommendation and sentiment from the evaluator model (`GEO_EVALUATOR`), kept only when its evidence quote appears in the answer, otherwise `UNCLEAR`. Answers that name no tracked brand skip the evaluator call. Analysts can correct a result.
- **KPIs** (valid answers only): mention rate, recommendation rate, average and normalised position (first = 100, last = 0, single-item list = N/A), AI share of voice (each brand once per answer), any / owned-domain citation rate (null = unavailable, not 0%).
