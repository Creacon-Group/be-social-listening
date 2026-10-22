import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Res,
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
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import type { Response } from 'express';
import { Public, Roles } from '../../common/auth.js';
import { RateLimit } from '../../common/rate-limit.js';
import type { Env } from '../../config/env.js';
import { MentionFilterDto } from '../mentions/mention-filter.js';
import { ReportsService } from './reports.service.js';

class SendReportDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => MentionFilterDto)
  filter: MentionFilterDto = { range: '30d' };

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  recipients?: string[];
}

class ReportSettingsDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  clientName?: string | null;

  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  recipients!: string[];

  @IsBoolean()
  monthlyEnabled!: boolean;

  @IsInt()
  @Min(1)
  @Max(28)
  monthlyDay!: number;
}

const download = (
  res: Response,
  file: { buffer: Buffer; fileName: string },
  type: string,
) => {
  res.setHeader('Content-Type', type);
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${file.fileName}"`,
  );
  res.setHeader('Cache-Control', 'no-store');
  res.end(file.buffer);
};

@ApiTags('reports')
@Controller('projects/:projectId/reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('pdf')
  @RateLimit(10)
  async pdf(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Query() filter: MentionFilterDto,
    @Res() res: Response,
  ) {
    download(res, await this.reports.pdf(projectId, filter), 'application/pdf');
  }

  @Get('excel')
  @RateLimit(10)
  async excel(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Query() filter: MentionFilterDto,
    @Res() res: Response,
  ) {
    download(
      res,
      await this.reports.excel(projectId, filter),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
  }

  @Post('email')
  @Roles('ADMIN', 'ANALYST')
  @RateLimit(5)
  email(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Body() dto: SendReportDto,
  ) {
    return this.reports.sendEmail(projectId, dto.filter, dto.recipients);
  }

  @Get('settings')
  settings(@Param('projectId', ParseIntPipe) projectId: number) {
    return this.reports.settings(projectId);
  }

  @Put('settings')
  @Roles('ADMIN')
  updateSettings(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Body() dto: ReportSettingsDto,
  ) {
    return this.reports.updateSettings(projectId, dto);
  }
}

/** Called by Vercel Cron (vercel.json) once a day with "Authorization: Bearer $CRON_SECRET". */
@ApiTags('reports')
@Controller('cron')
export class ReportsCronController {
  constructor(
    private readonly reports: ReportsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Public()
  @Get('monthly-reports')
  monthly(@Headers('authorization') auth?: string) {
    const secret = this.config.get('CRON_SECRET', { infer: true });
    if (!secret)
      throw new ServiceUnavailableException('CRON_SECRET belum diisi');
    if (auth !== `Bearer ${secret}`) throw new UnauthorizedException();
    return this.reports.runMonthly();
  }
}
