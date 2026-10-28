import { Injectable } from '@nestjs/common';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { PrismaService } from '../../database/prisma.service.js';
import { Channel, SentimentLabel } from '../../generated/prisma/enums.js';

export type DateRangePreset = 'today' | '7d' | '30d' | 'custom';

const csv = ({ value }: { value: unknown }) =>
  typeof value === 'string'
    ? value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : value;

/** Shared by the dashboard, the mentions feed and the AI tools: one filter, one set of numbers. */
export class MentionFilterDto {
  @IsOptional()
  @IsIn(['today', '7d', '30d', 'custom'])
  range?: DateRangePreset = '7d';

  @ValidateIf((o: MentionFilterDto) => o.range === 'custom')
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from?: string; // YYYY-MM-DD (WIB)

  @ValidateIf((o: MentionFilterDto) => o.range === 'custom')
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to?: string; // YYYY-MM-DD (WIB), inclusive

  @IsOptional()
  @Transform(csv)
  @IsEnum(Channel, { each: true })
  channels?: Channel[]; // ?channels=X,TIKTOK

  @IsOptional()
  @Transform(csv)
  @IsEnum(SentimentLabel, { each: true })
  sentiments?: SentimentLabel[];

  @IsOptional()
  @Transform((p) => (csv(p) as string[] | undefined)?.map(Number))
  @IsInt({ each: true })
  brandIds?: number[];

  /** Topic categories; 0 means "no category". */
  @IsOptional()
  @Transform((p) => (csv(p) as string[] | undefined)?.map(Number))
  @IsInt({ each: true })
  categoryIds?: number[];

  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string; // keyword search (LIKE) on content
}

export interface ResolvedFilter {
  projectId: number;
  from: Date; // UTC, inclusive
  to: Date; // UTC, exclusive
  channels?: Channel[];
  sentiments?: SentimentLabel[];
  brandIds?: number[];
  categoryIds?: number[];
  q?: string;
}

export const WIB_OFFSET_H = 7; // Indonesia has no DST; a "day" is a WIB calendar day
const DAY_MS = 86_400_000;
const wibDayStart = (ymd: string) => new Date(`${ymd}T00:00:00+07:00`);
export const toWibYmd = (d: Date) =>
  new Date(d.getTime() + WIB_OFFSET_H * 3_600_000).toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY_MS);

@Injectable()
export class FilterResolver {
  constructor(private readonly prisma: PrismaService) {}

  /** Latest mention date in the project: the anchor for Today / 7 / 30 day presets (data arrives in monthly batches). */
  async dataAsOf(projectId: number): Promise<Date | null> {
    const r = await this.prisma.mention.aggregate({
      where: { projectId },
      _max: { publishedAt: true },
    });
    return r._max.publishedAt;
  }

  async resolve(
    projectId: number,
    dto: MentionFilterDto,
  ): Promise<ResolvedFilter> {
    let from: Date;
    let to: Date;
    if (dto.range === 'custom' && dto.from && dto.to) {
      from = wibDayStart(dto.from);
      to = addDays(wibDayStart(dto.to), 1);
      if (to <= from) [from, to] = [addDays(to, -1), addDays(from, 1)];
    } else {
      const asOf = (await this.dataAsOf(projectId)) ?? new Date();
      const days = dto.range === 'today' ? 1 : dto.range === '30d' ? 30 : 7;
      to = addDays(wibDayStart(toWibYmd(asOf)), 1);
      from = addDays(to, -days);
    }
    const nonEmpty = <T>(a?: T[]) => (a?.length ? a : undefined);
    return {
      projectId,
      from,
      to,
      channels: nonEmpty(dto.channels),
      sentiments: nonEmpty(dto.sentiments),
      brandIds: nonEmpty(dto.brandIds),
      categoryIds: nonEmpty(dto.categoryIds),
      q: dto.q?.trim() || undefined,
    };
  }
}

/** Period as shown to users: WIB dates, `to` inclusive. */
export const periodOf = (f: ResolvedFilter) => ({
  from: toWibYmd(f.from),
  to: toWibYmd(addDays(f.to, -1)),
});
