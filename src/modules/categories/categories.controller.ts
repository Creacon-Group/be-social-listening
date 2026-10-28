import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Put,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';
import { Roles } from '../../common/auth.js';
import { CategoriesService } from './categories.service.js';

class CategoryRulesDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @MaxLength(150, { each: true })
  zanrooTags?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @Length(2, 60, { each: true })
  keywords?: string[];
}

class CategoryDto extends CategoryRulesDto {
  @IsString()
  @Length(1, 80)
  name!: string;

  @IsOptional()
  @Matches(/^#[0-9a-fA-F]{6}$/)
  color?: string | null;
}

@ApiTags('categories')
@Controller('projects/:projectId/categories')
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Get()
  list(@Param('projectId', ParseIntPipe) projectId: number) {
    return this.categories.list(projectId);
  }

  @Get('zanroo-tags')
  zanrooTags(@Param('projectId', ParseIntPipe) projectId: number) {
    return this.categories.zanrooTags(projectId);
  }

  @Post('preview')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.OK)
  preview(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Body() dto: CategoryRulesDto,
  ) {
    return this.categories.preview(projectId, dto);
  }

  @Post()
  @Roles('ADMIN')
  create(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Body() dto: CategoryDto,
  ) {
    return this.categories.create(projectId, dto);
  }

  @Put(':categoryId')
  @Roles('ADMIN')
  update(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Param('categoryId', ParseIntPipe) categoryId: number,
    @Body() dto: CategoryDto,
  ) {
    return this.categories.update(projectId, categoryId, dto);
  }

  @Delete(':categoryId')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Param('categoryId', ParseIntPipe) categoryId: number,
  ) {
    return this.categories.remove(projectId, categoryId);
  }
}
