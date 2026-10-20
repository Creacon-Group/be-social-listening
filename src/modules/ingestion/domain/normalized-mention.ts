import type {
  Channel,
  IngestionSourceType,
  SentimentLabel,
} from '../../../generated/prisma/client.js';

/** The only shape the ingestion core understands. Every source (Excel now, API later) maps to it. */
export interface NormalizedMention {
  externalId: string; // Zanroo MID / API id
  channel: Channel;
  postType?: string;
  title?: string;
  content?: string;
  url?: string;
  publishedAt: Date; // UTC
  author: {
    handle?: string;
    name?: string;
    followers?: number;
    verified?: boolean;
  };
  engagement: {
    likes: number;
    shares: number;
    comments: number;
    views: number;
    reach: number;
    total: number;
  };
  sentiment: { label: SentimentLabel; score?: number };
  brandKeywords: string[]; // raw keywords; resolved to brand ids by the core
  location?: string;
  tags?: string[];
  extra?: Record<string, unknown>;
}

export interface IngestionContext {
  projectId: number;
  batchId: number;
  sourceType: IngestionSourceType;
}

/** One item read from a source: normalized, or failed to parse. */
export type SourceRecord =
  | { ok: true; ref: string; mention: NormalizedMention }
  | { ok: false; ref: string; message: string; raw?: unknown; fatal?: boolean }; // fatal: stop the whole batch

/** PORT: the single contract for every data source. */
export interface IngestionSource<TInput = unknown> {
  readonly type: IngestionSourceType;
  read(input: TInput, ctx: IngestionContext): AsyncIterable<SourceRecord>;
  /** Optional: release the input (e.g. delete a temporary file) once the batch has ended. */
  cleanup?(input: TInput): Promise<void>;
}

export const INGESTION_SOURCES = Symbol('INGESTION_SOURCES');

export interface ResolvedMention {
  mention: NormalizedMention;
  brandIds: number[];
}
