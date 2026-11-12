import { RequirePermission } from '../../common/permissions.js';
import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsOptional, ValidateNested } from 'class-validator';
import { type AuthUser, CurrentUser } from '../../common/auth.js';
import { RateLimit } from '../../common/rate-limit.js';
import { MentionFilterDto } from '../mentions/mention-filter.js';
import { InsightsService } from './insights.service.js';

class GenerateInsightDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => MentionFilterDto)
  filter: MentionFilterDto = { range: '7d' };
}

@ApiTags('insights')
@Controller('projects/:projectId/insights')
export class InsightsController {
  constructor(private readonly insights: InsightsService) {}

  @Get()
  @RequirePermission('insights.view')
  list(@Param('projectId', ParseIntPipe) projectId: number) {
    return this.insights.list(projectId);
  }

  @Get(':insightId')
  @RequirePermission('insights.view')
  get(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Param('insightId', ParseIntPipe) insightId: number,
  ) {
    return this.insights.get(projectId, insightId);
  }

  /** Generates a briefing for the filter's period (20-60 s). Viewers can read, not generate. */
  @Post()
  @RequirePermission('insights.generate')
  @RateLimit(10)
  generate(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Body() dto: GenerateInsightDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.insights.generate(projectId, dto.filter, user.id);
  }
}
