import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { PageQueryDto } from '../../common/pagination.js';
import { MentionFilterDto } from './mention-filter.js';
import { type MentionSort, MentionsService } from './mentions.service.js';

class MentionQueryDto extends MentionFilterDto {
  @IsOptional()
  @IsIn(['latest', 'engagements', 'reach'])
  sort?: MentionSort = 'latest';
}

@ApiTags('mentions')
@Controller('projects/:projectId/mentions')
export class MentionsController {
  constructor(private readonly mentions: MentionsService) {}

  @Get()
  search(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Query() q: MentionQueryDto,
    @Query() page: PageQueryDto,
  ) {
    return this.mentions.search(projectId, q, {
      page: page.page,
      pageSize: page.pageSize,
      sort: q.sort ?? 'latest',
    });
  }
}
