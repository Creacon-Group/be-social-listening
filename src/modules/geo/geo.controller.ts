import { RequirePermission } from '../../common/permissions.js';
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
import { SumoPodClient } from './sumopod.client.js';

class ProfileDto {
  @IsOptional() @IsString() @MaxLength(120) targetName?: string;
  @IsOptional() @IsString() @MaxLength(120) industry?: string;
  @IsOptional() @IsString() @MaxLength(120) market?: string;
  @IsOptional() @IsIn(['id', 'en', 'both']) language?: string; // prompt language(s)
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

class NewPromptDto {
  @IsString() @MinLength(5) @MaxLength(1000) text!: string;
  @IsEnum(GeoPromptCategory) category!: GeoPromptCategory;
  @IsOptional() @IsBoolean() branded?: boolean;
  @IsOptional() @IsIn(['id', 'en']) language?: string;
}

class AdhocRunDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsInt({ each: true })
  promptIds?: number[];
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => NewPromptDto)
  newPrompts?: NewPromptDto[];
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
    private readonly sumopod: SumoPodClient,
  ) {}

  /** Remaining AI gateway budget per model. Superadmin only (spend is account-wide, not per project). */
  @Get('budget')
  @Roles('SUPERADMIN')
  budget() {
    return this.sumopod.budgets();
  }

  @Get('settings')
  @RequirePermission('geo.view')
  settings(@Param('projectId', ParseIntPipe) projectId: number) {
    return this.geo.settings(projectId);
  }

  @Put('settings')
  @RequirePermission('settings.manage')
  updateSettings(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Body() dto: SettingsDto,
  ) {
    return this.geo.updateSettings(projectId, dto);
  }

  @Get('prompts')
  @RequirePermission('geo.view')
  prompts(@Param('projectId', ParseIntPipe) projectId: number) {
    return this.geo.prompts(projectId);
  }

  @Post('prompts')
  @RequirePermission('geo.manage')
  async createPrompt(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Body() dto: CreatePromptDto,
    @CurrentUser() user: AuthUser,
  ) {
    return { id: await this.geo.createPrompt(projectId, user.id, dto) };
  }

  @Patch('prompts/:id')
  @RequirePermission('geo.manage')
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
  @RequirePermission('geo.manage')
  @RateLimit(5)
  suggest(
    @Param('projectId', ParseIntPipe) projectId: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.geo.suggestPrompts(projectId, user.id);
  }

  @Get('estimate')
  @RequirePermission('geo.view')
  estimate(@Param('projectId', ParseIntPipe) projectId: number) {
    return this.geo.estimate(projectId);
  }

  @Get('batches')
  @RequirePermission('geo.view')
  batches(@Param('projectId', ParseIntPipe) projectId: number) {
    return this.geo.batches(projectId);
  }

  /** Start this month's benchmark. Refused (409) when the month already has a batch. */
  @Post('batches')
  @RequirePermission('settings.manage')
  @HttpCode(HttpStatus.ACCEPTED)
  start(
    @Param('projectId', ParseIntPipe) projectId: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.geo.start(projectId, 'manual', user.id);
  }

  /** Manual run outside the monthly schedule; costs one AI credit per prompt (429 when not enough). */
  @Post('adhoc-runs')
  @RequirePermission('geo.manage')
  @RateLimit(5)
  @HttpCode(HttpStatus.ACCEPTED)
  adhoc(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Body() dto: AdhocRunDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.geo.startAdhoc(projectId, user, dto);
  }

  @Get('batches/:batchId')
  @RequirePermission('geo.view')
  batch(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Param('batchId', ParseIntPipe) batchId: number,
  ) {
    return this.geo.batch(projectId, batchId);
  }

  @Post('batches/:batchId/resume')
  @RequirePermission('geo.manage')
  @HttpCode(HttpStatus.ACCEPTED)
  resume(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Param('batchId', ParseIntPipe) batchId: number,
  ) {
    return this.geo.resume(projectId, batchId);
  }

  @Post('batches/:batchId/retry-failed')
  @RequirePermission('settings.manage')
  @HttpCode(HttpStatus.ACCEPTED)
  retryFailed(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Param('batchId', ParseIntPipe) batchId: number,
  ) {
    return this.geo.retryFailed(projectId, batchId);
  }

  @Post('batches/:batchId/reevaluate')
  @RequirePermission('settings.manage')
  @HttpCode(HttpStatus.ACCEPTED)
  reevaluate(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Param('batchId', ParseIntPipe) batchId: number,
  ) {
    return this.geo.reevaluate(projectId, batchId);
  }

  /** Compact AI visibility for the dashboard: latest monthly run not after `to` (YYYY-MM-DD). */
  @Get('summary')
  @RequirePermission('overview.view', 'insights.view', 'competitors.view', 'geo.view')
  summary(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Query('to') to?: string,
  ) {
    return this.analytics.summaryFor(
      projectId,
      to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? to : undefined,
    );
  }

  @Get('overview')
  @RequirePermission('geo.view')
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
  @RequirePermission('geo.view')
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
  @RequirePermission('geo.view')
  run(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Param('runId', ParseIntPipe) runId: number,
  ) {
    return this.analytics.run(projectId, runId);
  }

  /** Analyst correction of an evaluation result. */
  @Patch('results/:resultId')
  @RequirePermission('geo.manage')
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
