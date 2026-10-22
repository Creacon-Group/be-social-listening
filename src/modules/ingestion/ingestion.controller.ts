import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiTags } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';
import { type AuthUser, CurrentUser, Roles } from '../../common/auth.js';
import { PageQueryDto } from '../../common/pagination.js';
import { IngestionBatchRepository } from './application/ingestion-batch.repository.js';
import { IngestionService } from './application/ingestion.service.js';
import type { ExcelSourceInput } from './adapters/excel/excel-ingestion.source.js';
import { FileStore } from './adapters/excel/file-store.js';

class StartExcelIngestionDto {
  @IsString() @MaxLength(1000) fileUrl!: string; // Vercel Blob URL from a direct browser upload
  @IsString() @MaxLength(255) fileName!: string;
}

const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

@ApiTags('ingestion')
@Controller('projects/:projectId/ingestion')
export class IngestionController {
  constructor(
    private readonly ingestion: IngestionService,
    private readonly batches: IngestionBatchRepository,
    private readonly files: FileStore,
  ) {}

  /** Vercel flow: the file is already in Blob storage; start a batch from its URL. */
  @Post('excel')
  @Roles('ADMIN', 'ANALYST')
  @HttpCode(HttpStatus.ACCEPTED)
  startExcel(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Body() dto: StartExcelIngestionDto,
    @CurrentUser() user: AuthUser,
  ) {
    if (dto.fileUrl.startsWith('local:'))
      throw new BadRequestException('Use the upload endpoint for local files');
    this.files.assertTrusted(dto.fileUrl);
    return this.ingestion.start({
      type: 'EXCEL_UPLOAD',
      projectId,
      userId: user.id,
      label: dto.fileName,
      input: { fileUrl: dto.fileUrl } satisfies ExcelSourceInput,
    });
  }

  /** Docker/PM2 flow (and local dev): multipart upload straight to this server. On Vercel the body limit is 4.5 MB. */
  @Post('excel/upload')
  @Roles('ADMIN', 'ANALYST')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file'))
  uploadExcel(
    @Param('projectId', ParseIntPipe) projectId: number,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    if (!file) throw new BadRequestException('The "file" field is required');
    if (
      file.mimetype !== XLSX_MIME &&
      !file.originalname.toLowerCase().endsWith('.xlsx')
    ) {
      void this.files.discard(this.files.localRef(file.filename));
      throw new BadRequestException('The file must be an .xlsx workbook');
    }
    return this.ingestion.start({
      type: 'EXCEL_UPLOAD',
      projectId,
      userId: user.id,
      label: file.originalname,
      input: {
        fileUrl: this.files.localRef(file.filename),
      } satisfies ExcelSourceInput,
    });
  }

  @Get('batches')
  list(@Param('projectId', ParseIntPipe) projectId: number) {
    return this.batches.listForProject(projectId);
  }

  @Get('batches/:batchId')
  get(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Param('batchId', ParseIntPipe) batchId: number,
  ) {
    return this.batches.findForProject(projectId, batchId);
  }

  @Post('batches/:batchId/resume')
  @Roles('ADMIN', 'ANALYST')
  @HttpCode(HttpStatus.ACCEPTED)
  resume(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Param('batchId', ParseIntPipe) batchId: number,
  ) {
    return this.ingestion.resume(projectId, batchId);
  }

  @Get('batches/:batchId/errors')
  errors(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Param('batchId', ParseIntPipe) batchId: number,
    @Query() q: PageQueryDto,
  ) {
    return this.batches.listErrors(projectId, batchId, q.page, q.pageSize);
  }
}
