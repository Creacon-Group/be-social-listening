import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Put,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsString, MaxLength } from 'class-validator';
import {
  type AuthUser,
  CurrentUser,
  Roles,
  seesAllProjects,
} from '../../common/auth.js';
import { PrismaService } from '../../database/prisma.service.js';

class UpdateAliasesDto {
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  aliases!: string[];
}

@ApiTags('projects')
@Controller('projects')
export class ProjectsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(@CurrentUser() user: AuthUser) {
    return this.prisma.project.findMany({
      where: seesAllProjects(user.role)
        ? {}
        : { members: { some: { userId: user.id } } },
      select: { id: true, name: true, slug: true, description: true },
      orderBy: { name: 'asc' },
    });
  }

  @Get(':projectId/brands')
  brands(@Param('projectId', ParseIntPipe) projectId: number) {
    return this.prisma.brand.findMany({
      where: { projectId },
      select: { id: true, name: true, isOwn: true, color: true, aliases: true },
      orderBy: [{ isOwn: 'desc' }, { name: 'asc' }],
    });
  }

  /** Replace a brand's keyword aliases. Applies to future uploads; existing mentions are not re-tagged. */
  @Put(':projectId/brands/:brandId/aliases')
  @Roles('ADMIN')
  async updateAliases(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Param('brandId', ParseIntPipe) brandId: number,
    @Body() dto: UpdateAliasesDto,
  ) {
    const aliases = [
      ...new Set(dto.aliases.map((a) => a.trim()).filter(Boolean)),
    ];
    await this.prisma.brand.updateMany({
      where: { id: brandId, projectId },
      data: { aliases },
    });
    return this.prisma.brand.findFirstOrThrow({
      where: { id: brandId, projectId },
    });
  }
}
