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
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { type AuthUser, CurrentUser, Roles } from '../../common/auth.js';
import {
  BrandDto,
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

  @Delete('projects/:projectId/brands/:brandId')
  @HttpCode(204)
  async deleteBrand(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Param('brandId', ParseIntPipe) brandId: number,
  ) {
    await this.admin.deleteBrand(projectId, brandId);
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
