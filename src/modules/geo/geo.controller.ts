import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  type AuthUser,
  CurrentUser,
  Public,
  Roles,
} from '../../common/auth.js';
import { RateLimit } from '../../common/rate-limit.js';
import { bearer, sameSecret } from '../../common/secret.js';
import type { Env } from '../../config/env.js';
import {
  GeoPromptCategory,
  GeoPromptStatus,
} from '../../generated/prisma/enums.js';
import { GeoAnalyticsService } from './geo-analytics.service.js';
import { GeoService } from './geo.service.js';

class ProfileDto {
  @IsOptional() @IsString() @MaxLength(120) targetName?: string;
  @IsOptional() @IsString() @MaxLength(120) industry?: string;
  @IsOptional() @IsString() @MaxLength(120) market?: string;
  @IsOptional() @IsIn(['id', 'en']) language?: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
}

class BrandDomainsDto {
  @IsInt() brandId!: number;
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  domains!: string[];
}

class SettingsDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(28) runDay?: number;
  @IsOptional() @IsInt() @Min(1) @Max(3) runsPerPrompt?: number;
  @IsOptional() @ValidateNested() @Type(() => ProfileDto) profile?: ProfileDto;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => BrandDomainsDto)
  brandDomains?: BrandDomainsDto[];
}

class CreatePromptDto {
  @IsString() @MinLength(5) @MaxLength(1000) text!: string;
  @IsEnum(GeoPromptCategory) category!: GeoPromptCategory;
  @IsOptional() @IsBoolean() branded?: boolean;
  @IsOptional() @IsIn(['id', 'en']) language?: string;
  @IsOptional() @IsEnum(GeoPromptStatus) status?: GeoPromptStatus;
}

class UpdatePromptDto {
  @IsOptional() @IsString() @MinLength(5) @MaxLength(1000) text?: string;
  @IsOptional() @IsEnum(GeoPromptCategory) category?: GeoPromptCategory;
  @IsOptional() @IsBoolean() branded?: boolean;
  @IsOptional() @IsIn(['id', 'en']) language?: string;
  @IsOptional() @IsEnum(GeoPromptStatus) status?: GeoPromptStatus;
}

class CorrectDto {
  @IsOptional() @IsBoolean() mentioned?: boolean;
  @IsOptional()
  @IsIn([
    'RECOMMENDED',
    'POSITIVE',
    'NEUTRAL',
    'NEGATIVE',
    'NOT_MENTIONED',
    'UNCLEAR',
  ])
  recommendation?: string;
}

const optInt = (v?: string) =>
  v && Number.isInteger(Number(v)) ? Number(v) : undefined;

@ApiTags('geo')
@Controller('projects/:projectId/geo')
export class GeoController {
  constructor(
    private readonly geo: GeoService,
    private readonly analytics: GeoAnalyticsService,
  ) {}

  @Get('settings')
  settings(@Param('projectId', ParseIntPipe) projectId: number) {
    return this.geo.settings(projectId);
  }

  @Put('settings')
  @Roles('ADMIN')
  updateSettings(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Body() dto: SettingsDto,
  ) {
    return this.geo.updateSettings(projectId, dto);
  }

  @Get('prompts')
  prompts(@Param('projectId', ParseIntPipe) projectId: number) {
    return this.geo.prompts(projectId);
  }

  @Post('prompts')
  @Roles('ADMIN', 'ANALYST')
  async createPrompt(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Body() dto: CreatePromptDto,
    @CurrentUser() user: AuthUser,
  ) {
    return { id: await this.geo.createPrompt(projectId, user.id, dto) };
  }

  @Patch('prompts/:id')
  @Roles('ADMIN', 'ANALYST')
  async updatePrompt(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdatePromptDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.geo.updatePrompt(projectId, id, user.id, dto);
    return { ok: true };
  }

  /** AI-written draft prompts; they do not run until approved. */
  @Post('prompts/suggest')
  @Roles('ADMIN', 'ANALYST')
  @RateLimit(5)
  suggest(
    @Param('projectId', ParseIntPipe) projectId: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.geo.suggestPrompts(projectId, user.id);
  }

  @Get('estimate')
  estimate(@Param('projectId', ParseIntPipe) projectId: number) {
    return this.geo.estimate(projectId);
  }

  @Get('batches')
  batches(@Param('projectId', ParseIntPipe) projectId: number) {
    return this.geo.batches(projectId);
  }

  /** Start this month's benchmark. Refused (409) when the month already has a batch. */
  @Post('batches')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.ACCEPTED)
  start(
    @Param('projectId', ParseIntPipe) projectId: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.geo.start(projectId, 'manual', user.id);
  }

  @Get('batches/:batchId')
  batch(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Param('batchId', ParseIntPipe) batchId: number,
  ) {
    return this.geo.batch(projectId, batchId);
  }

  @Post('batches/:batchId/resume')
  @Roles('ADMIN', 'ANALYST')
  @HttpCode(HttpStatus.ACCEPTED)
  resume(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Param('batchId', ParseIntPipe) batchId: number,
  ) {
    return this.geo.resume(projectId, batchId);
  }

  @Post('batches/:batchId/retry-failed')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.ACCEPTED)
  retryFailed(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Param('batchId', ParseIntPipe) batchId: number,
  ) {
    return this.geo.retryFailed(projectId, batchId);
  }

  @Post('batches/:batchId/reevaluate')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.ACCEPTED)
  reevaluate(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Param('batchId', ParseIntPipe) batchId: number,
  ) {
    return this.geo.reevaluate(projectId, batchId);
  }

  @Get('overview')
  overview(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Query('batchId') batchId?: string,
    @Query('category') category?: string,
  ) {
    return this.analytics.overview(
      projectId,
      optInt(batchId),
      category || undefined,
    );
  }

  @Get('runs')
  runs(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Query('batchId') batchId?: string,
    @Query('model') model?: string,
    @Query('mode') mode?: string,
    @Query('status') status?: string,
    @Query('mentioned') mentioned?: string,
    @Query('page') page?: string,
  ) {
    return this.analytics.runs(projectId, {
      batchId: optInt(batchId),
      model,
      mode,
      status,
      mentioned,
      page: optInt(page),
    });
  }

  @Get('runs/:runId')
  run(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Param('runId', ParseIntPipe) runId: number,
  ) {
    return this.analytics.run(projectId, runId);
  }

  /** Analyst correction of an evaluation result. */
  @Patch('results/:resultId')
  @Roles('ADMIN', 'ANALYST')
  correct(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Param('resultId', ParseIntPipe) resultId: number,
    @Body() dto: CorrectDto,
  ) {
    return this.geo.correct(projectId, resultId, dto);
  }
}

@ApiTags('geo')
@Controller('cron')
export class GeoCronController {
  constructor(
    private readonly geo: GeoService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Vercel Cron, daily: starts each project's monthly run on its run day and resumes paused runs. */
  @Public()
  @Get('geo')
  run(@Headers('authorization') auth?: string) {
    const secret = this.config.get('CRON_SECRET', { infer: true });
    if (!secret)
      throw new ServiceUnavailableException('CRON_SECRET is not set');
    const given = bearer(auth);
    if (!given || !sameSecret(given, secret)) throw new UnauthorizedException();
    return this.geo.cron();
  }
}
