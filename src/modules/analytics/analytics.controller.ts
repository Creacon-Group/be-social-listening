import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { MentionFilterDto } from '../mentions/mention-filter.js';
import { AnalyticsService } from './analytics.service.js';

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
}
