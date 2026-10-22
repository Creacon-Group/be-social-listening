import { Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { IngestionSourceType } from '../../../../generated/prisma/enums.js';
import type {
  IngestionSource,
  SourceRecord,
} from '../../domain/normalized-mention.js';
import { type ExcelHeader, mapHeaders } from './excel-columns.js';
import {
  asList,
  asNumber,
  asString,
  categoriesOf,
  followersFor,
  parseChannel,
  parsePublishedAt,
  parseSentimentLabel,
  unwrap,
} from './excel-parsers.js';
import { FileStore } from './file-store.js';

/** Zanroo puts several image URLs in one cell, separated by ", ". Keep a few https links. */
const imageLinks = (v: unknown) =>
  String(v ?? '')
    .split(/,\s*(?=https?:\/\/)/)
    .map((u) => u.trim())
    .filter((u) => u.startsWith('https://'))
    .slice(0, 4);

export interface ExcelSourceInput {
  fileUrl: string; // Vercel Blob URL, or "local:<name>" in Docker/PM2 mode
}

/**
 * ADAPTER: Zanroo Excel export -> NormalizedMention.
 * Streams the first sheet, so a 33 MB file is never loaded into memory at once.
 */
@Injectable()
export class ExcelIngestionSource implements IngestionSource<ExcelSourceInput> {
  readonly type = IngestionSourceType.EXCEL_UPLOAD;

  constructor(private readonly files: FileStore) {}

  async *read(input: ExcelSourceInput): AsyncIterable<SourceRecord> {
    const stream = await this.files.open(input.fileUrl);
    try {
      const reader = new ExcelJS.stream.xlsx.WorkbookReader(stream, {
        worksheets: 'emit',
        sharedStrings: 'cache',
        hyperlinks: 'ignore',
        styles: 'ignore',
      });

      for await (const sheet of reader) {
        let header: ExcelHeader | undefined;

        for await (const row of sheet) {
          const cells = (row.values as unknown[]).map(unwrap); // index starts at 1

          if (!header) {
            header = mapHeaders(cells);
            if (header.missing.length) {
              yield {
                ok: false,
                fatal: true,
                ref: 'header',
                message: `Missing required columns: ${header.missing.join(', ')}`,
              };
              return;
            }
            continue;
          }
          if (cells.every((c) => c === null || c === undefined || c === ''))
            continue; // blank row
          yield this.toRecord(row.number, cells, header);
        }
        return; // first sheet only
      }
      yield {
        ok: false,
        fatal: true,
        ref: 'file',
        message: 'The file has no sheet',
      };
    } finally {
      stream.destroy();
    }
  }

  async cleanup(input: ExcelSourceInput) {
    await this.files.discard(input.fileUrl);
  }

  private toRecord(
    rowNo: number,
    cells: unknown[],
    h: ExcelHeader,
  ): SourceRecord {
    const ref = `row ${rowNo}`;
    const raw: Record<string, unknown> = {};
    h.columns.forEach((idx, key) => (raw[key] = cells[idx]));
    const n = (v: unknown) => asNumber(v) ?? 0;

    try {
      const externalId = asString(raw.id);
      if (!externalId) throw new Error('MID is empty');
      const channel = parseChannel(raw.channel);
      const tags = asList(raw.tag);
      return {
        ok: true,
        ref,
        mention: {
          externalId,
          channel,
          postType: asString(raw.post_type),
          title: asString(raw.title),
          content: asString(raw.content),
          url: asString(raw.url),
          publishedAt: parsePublishedAt(raw.date, raw.time, raw.tz),
          author: {
            handle: asString(raw.author_handle),
            name: asString(raw.author_name),
            followers: followersFor(channel, raw),
            verified: asString(raw.verified) === 'Verified',
          },
          engagement: {
            likes: n(raw.likes),
            shares: n(raw.shares),
            comments: n(raw.comments),
            views: n(raw.views),
            reach: n(raw.reach),
            total: n(raw.total),
          },
          sentiment: { label: parseSentimentLabel(raw.sentiment) },
          brandKeywords: [...new Set(asList(raw.keyword))], // Zanroo keywords often repeat
          location: asString(raw.location),
          tags: tags.length ? [...new Set(tags)] : undefined,
          extra: {
            where: asString(raw.source_name),
            country: asString(raw.country),
            types: asString(raw.types),
            categories: categoriesOf(cells, h.categories),
            gender: asString(raw.gender),
            hasc: asString(raw.hasc), // e.g. ID.JI.BW: country.province.regency
            preview: {
              images: imageLinks(raw.image_link),
              userLink: asString(raw.user_link),
              bookmarks: n(raw.bookmarks),
            },
          },
        },
      };
    } catch (e) {
      return {
        ok: false,
        ref,
        message: (e as Error).message,
        raw: { mid: asString(raw.id) },
      };
    }
  }
}
