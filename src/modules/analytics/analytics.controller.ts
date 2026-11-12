import { RequirePermission } from '../../common/permissions.js';
import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { MentionFilterDto } from '../mentions/mention-filter.js';
import { INTERVALS, type Interval } from './analytics.repository.js';
import {
  type AccountTypeName,
  AnalyticsService,
  type InfluencerSort,
} from './analytics.service.js';

const TYPES: AccountTypeName[] = ['KOL', 'MEDIA', 'OFFICIAL', 'OTHER'];
const intervalOf = (v?: string) =>
  INTERVALS.includes(v as Interval) ? (v as Interval) : undefined;

@ApiTags('analytics')
@Controller('projects/:projectId/analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  /** Latest data date: the FilterBar uses it to label presets ("Last 7 Days (24–30 Sep)"). */
  @Get('data-as-of')
  dataAsOf(@Param('projectId', ParseIntPipe) projectId: number) {
    return this.analytics.dataAsOf(projectId);
  }

  @Get('overview')
  @RequirePermission('overview.view')
  overview(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Query() filter: MentionFilterDto,
  ) {
    return this.analytics.overview(projectId, filter);
  }

  @Get('competitors')
  @RequirePermission('overview.view', 'competitors.view')
  competitors(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Query() filter: MentionFilterDto,
    @Query('interval') interval?: string,
  ) {
    return this.analytics.competitors(projectId, filter, {
      interval: intervalOf(interval),
    });
  }

  /** ?interval=hour|day|week|month|quarter|year (hour only up to 31 days). */
  @Get('trend')
  @RequirePermission('overview.view', 'insights.view')
  trend(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Query() filter: MentionFilterDto,
    @Query('interval') interval?: string,
  ) {
    return this.analytics.trend(projectId, filter, intervalOf(interval));
  }

  @Get('channels')
  @RequirePermission('channels.view')
  channels(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Query() filter: MentionFilterDto,
  ) {
    return this.analytics.channels(projectId, filter);
  }

  @Get('heatmap')
  @RequirePermission('demographics.view')
  heatmap(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Query() filter: MentionFilterDto,
  ) {
    return this.analytics.heatmap(projectId, filter);
  }

  @Get('keywords')
  keywords(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Query() filter: MentionFilterDto,
  ) {
    return this.analytics.keywords(projectId, filter);
  }

  @Get('influencers')
  @RequirePermission('overview.view', 'influencers.view')
  influencers(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Query() filter: MentionFilterDto,
    @Query('sort') sort?: string,
    @Query('types') types?: string,
    @Query('limit') limit?: string,
  ) {
    const s: InfluencerSort =
      sort === 'engagements' || sort === 'mentions' ? sort : 'reach';
    const t = (types ?? '')
      .split(',')
      .filter((x): x is AccountTypeName =>
        TYPES.includes(x as AccountTypeName),
      );
    const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
    return this.analytics.influencers(projectId, filter, {
      sort: s,
      types: t.length ? t : undefined,
      limit: n,
    });
  }

  @Get('demographics')
  @RequirePermission('demographics.view')
  demographics(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Query() filter: MentionFilterDto,
  ) {
    return this.analytics.demographics(projectId, filter);
  }

  @Get('topics')
  @RequirePermission('overview.view', 'topics.view')
  topics(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Query() filter: MentionFilterDto,
  ) {
    return this.analytics.categoryTopics(projectId, filter);
  }

  @Get('hashtags')
  @RequirePermission('hashtags.view')
  hashtags(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Query() filter: MentionFilterDto,
  ) {
    return this.analytics.hashtags(projectId, filter);
  }
}
