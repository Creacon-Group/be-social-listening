import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { MentionFilterDto } from '../mentions/mention-filter.js';
import { AnalyticsService, type InfluencerSort } from './analytics.service.js';

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
  overview(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Query() filter: MentionFilterDto,
  ) {
    return this.analytics.overview(projectId, filter);
  }

  @Get('competitors')
  competitors(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Query() filter: MentionFilterDto,
  ) {
    return this.analytics.competitors(projectId, filter);
  }

  @Get('trend')
  trend(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Query() filter: MentionFilterDto,
  ) {
    return this.analytics.trend(projectId, filter);
  }

  @Get('influencers')
  influencers(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Query() filter: MentionFilterDto,
    @Query('sort') sort?: string,
  ) {
    const s: InfluencerSort =
      sort === 'engagements' || sort === 'mentions' ? sort : 'reach';
    return this.analytics.influencers(projectId, filter, { sort: s });
  }

  @Get('demographics')
  demographics(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Query() filter: MentionFilterDto,
  ) {
    return this.analytics.demographics(projectId, filter);
  }

  @Get('hashtags')
  hashtags(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Query() filter: MentionFilterDto,
  ) {
    return this.analytics.hashtags(projectId, filter);
  }
}
