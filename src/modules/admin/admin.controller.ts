import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { type AuthUser, CurrentUser, Roles } from '../../common/auth.js';
import {
  AssignKeywordDto,
  BrandDto,
  IgnoreKeywordDto,
  CreateProjectDto,
  MemberDto,
  UpdateBrandDto,
  UpdateProjectDto,
  UpdateUserDto,
} from './admin.dto.js';
import { AdminService } from './admin.service.js';

/** Superadmin: projects, brands, who is in which project and what they may do there. */
@ApiTags('admin')
@Roles('SUPERADMIN')
@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('permissions')
  catalog() {
    return this.admin.catalog();
  }

  @Get('projects')
  projects() {
    return this.admin.listProjects();
  }

  @Post('projects')
  createProject(@Body() dto: CreateProjectDto) {
    return this.admin.createProject(dto);
  }

  @Get('projects/:projectId')
  project(@Param('projectId', ParseIntPipe) projectId: number) {
    return this.admin.getProject(projectId);
  }

  @Patch('projects/:projectId')
  updateProject(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Body() dto: UpdateProjectDto,
  ) {
    return this.admin.updateProject(projectId, dto);
  }

  /** Deletes the project with all its mentions, brands, uploads, insights and GEO data. */
  @Delete('projects/:projectId')
  @HttpCode(204)
  async deleteProject(@Param('projectId', ParseIntPipe) projectId: number) {
    await this.admin.deleteProject(projectId);
  }

  @Post('projects/:projectId/brands')
  addBrand(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Body() dto: BrandDto,
  ) {
    return this.admin.addBrand(projectId, dto);
  }

  @Patch('projects/:projectId/brands/:brandId')
  updateBrand(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Param('brandId', ParseIntPipe) brandId: number,
    @Body() dto: UpdateBrandDto,
  ) {
    return this.admin.updateBrand(projectId, brandId, dto);
  }

  /** ?mergeInto=<brandId> moves its keywords and tags to another brand; ?ignoreKeywords=1 marks them "not a brand". */
  @Delete('projects/:projectId/brands/:brandId')
  deleteBrand(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Param('brandId', ParseIntPipe) brandId: number,
    @Query('mergeInto', new ParseIntPipe({ optional: true }))
    mergeInto?: number,
    @Query('ignoreKeywords') ignoreKeywords?: string,
  ) {
    return this.admin.deleteBrand(projectId, brandId, {
      mergeInto,
      ignoreKeywords: ignoreKeywords === '1' || ignoreKeywords === 'true',
    });
  }

  /** Brand tags of all existing mentions recomputed from their stored keywords. */
  @Post('projects/:projectId/brands/retag')
  retag(@Param('projectId', ParseIntPipe) projectId: number) {
    return this.admin.retagAll(projectId);
  }

  /** Keywords seen in the project's data and which brand (if any) they map to. */
  @Get('projects/:projectId/keywords')
  keywords(@Param('projectId', ParseIntPipe) projectId: number) {
    return this.admin.keywords(projectId);
  }

  @Post('projects/:projectId/keywords/assign')
  assignKeyword(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Body() dto: AssignKeywordDto,
  ) {
    return this.admin.assignKeyword(projectId, dto.brandId, dto.keyword);
  }

  @Post('projects/:projectId/keywords/ignore')
  @HttpCode(204)
  async ignoreKeyword(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Body() dto: IgnoreKeywordDto,
  ) {
    await this.admin.setIgnored(projectId, dto.keyword, dto.ignored);
  }

  /** Add a user to a project or change their permissions there. */
  @Put('projects/:projectId/members/:userId')
  @HttpCode(204)
  async setMember(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Param('userId', ParseIntPipe) userId: number,
    @Body() dto: MemberDto,
  ) {
    await this.admin.setMember(projectId, userId, dto.permissions ?? null);
  }

  @Delete('projects/:projectId/members/:userId')
  @HttpCode(204)
  async removeMember(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Param('userId', ParseIntPipe) userId: number,
  ) {
    await this.admin.removeMember(projectId, userId);
  }

  /** Users with their role and project memberships. */
  @Get('users/access')
  users() {
    return this.admin.listUsers();
  }

  @Patch('users/:userId')
  @HttpCode(204)
  async updateUser(
    @CurrentUser() actor: AuthUser,
    @Param('userId', ParseIntPipe) userId: number,
    @Body() dto: UpdateUserDto,
  ) {
    await this.admin.updateUser(actor.id, userId, dto);
  }
}
