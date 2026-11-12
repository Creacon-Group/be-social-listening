import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import {
  effectivePermissions,
  PERMISSION_CATALOG,
  ROLE_PRESETS,
} from '../../common/permissions.js';
import type {
  BrandDto,
  CreateProjectDto,
  UpdateBrandDto,
  UpdateProjectDto,
  UpdateUserDto,
} from './admin.dto.js';

const cleanAliases = (a?: string[]) =>
  a ? [...new Set(a.map((s) => s.trim()).filter(Boolean))] : undefined;

/** Unique-constraint violation → 409 with a readable message. */
function conflict(e: unknown, message: string): never {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
    throw new ConflictException(message);
  throw e;
}

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  catalog() {
    return { permissions: PERMISSION_CATALOG, presets: ROLE_PRESETS };
  }

  // ───────── Projects ─────────

  listProjects() {
    return this.prisma.project.findMany({
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        clientName: true,
        createdAt: true,
        _count: { select: { members: true, brands: true } },
      },
    });
  }

  async createProject(dto: CreateProjectDto) {
    const ownCount = dto.brands.filter((b) => b.isOwn).length;
    if (dto.brands.length && !ownCount)
      throw new BadRequestException('Mark at least one brand as your own');
    try {
      const project = await this.prisma.project.create({
        data: {
          name: dto.name.trim(),
          slug: dto.slug,
          description: dto.description?.trim() || null,
          clientName: dto.clientName?.trim() || null,
          brands: {
            create: dto.brands.map((b) => ({
              name: b.name.trim(),
              isOwn: b.isOwn,
              color: b.color ?? null,
              aliases: cleanAliases(b.aliases) ?? [],
            })),
          },
          members: dto.memberIds?.length
            ? {
                create: [...new Set(dto.memberIds)].map((userId) => ({
                  userId,
                })),
              }
            : undefined,
        },
      });
      return this.getProject(project.id);
    } catch (e) {
      conflict(e, 'Slug or brand name is already used');
    }
  }

  async getProject(projectId: number) {
    const p = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        clientName: true,
        createdAt: true,
        brands: {
          orderBy: [{ isOwn: 'desc' }, { name: 'asc' }],
          select: {
            id: true,
            name: true,
            isOwn: true,
            color: true,
            aliases: true,
            _count: { select: { mentions: true } },
          },
        },
        members: {
          orderBy: { user: { name: 'asc' } },
          select: {
            permissions: true,
            user: { select: { id: true, name: true, email: true, role: true } },
          },
        },
      },
    });
    if (!p) throw new NotFoundException('Project not found');
    return {
      ...p,
      brands: p.brands.map(({ _count, ...b }) => ({
        ...b,
        mentionCount: _count.mentions,
      })),
      members: p.members.map((m) => ({
        ...m.user,
        custom: Array.isArray(m.permissions),
        permissions: effectivePermissions(m.user.role, m.permissions),
      })),
    };
  }

  async updateProject(projectId: number, dto: UpdateProjectDto) {
    await this.assertProject(projectId);
    try {
      await this.prisma.project.update({
        where: { id: projectId },
        data: {
          name: dto.name?.trim(),
          slug: dto.slug,
          description:
            dto.description === undefined
              ? undefined
              : dto.description?.trim() || null,
          clientName:
            dto.clientName === undefined
              ? undefined
              : dto.clientName?.trim() || null,
        },
      });
    } catch (e) {
      conflict(e, 'Slug is already used');
    }
    return this.getProject(projectId);
  }

  // ───────── Brands ─────────

  async addBrand(projectId: number, dto: BrandDto) {
    await this.assertProject(projectId);
    try {
      return await this.prisma.brand.create({
        data: {
          projectId,
          name: dto.name.trim(),
          isOwn: dto.isOwn,
          color: dto.color ?? null,
          aliases: cleanAliases(dto.aliases) ?? [],
        },
      });
    } catch (e) {
      conflict(e, 'A brand with this name already exists in the project');
    }
  }

  async updateBrand(projectId: number, brandId: number, dto: UpdateBrandDto) {
    await this.assertBrand(projectId, brandId);
    try {
      return await this.prisma.brand.update({
        where: { id: brandId },
        data: {
          name: dto.name?.trim(),
          isOwn: dto.isOwn,
          color: dto.color,
          aliases: cleanAliases(dto.aliases),
        },
      });
    } catch (e) {
      conflict(e, 'A brand with this name already exists in the project');
    }
  }

  /** Only brands without mentions: deleting one would silently drop data from every chart. */
  async deleteBrand(projectId: number, brandId: number) {
    await this.assertBrand(projectId, brandId);
    const used = await this.prisma.mentionBrand.count({ where: { brandId } });
    if (used)
      throw new ConflictException(
        `This brand has ${used} mentions. Rename it or update its keywords instead.`,
      );
    await this.prisma.brand.delete({ where: { id: brandId } });
  }

  // ───────── Members ─────────

  async setMember(
    projectId: number,
    userId: number,
    permissions: string[] | null,
  ) {
    await this.assertProject(projectId);
    await this.assertUser(userId);
    const value = permissions ? [...new Set(permissions)] : Prisma.DbNull; // back to the role preset
    await this.prisma.projectMember.upsert({
      where: { userId_projectId: { userId, projectId } },
      update: { permissions: value },
      create: { userId, projectId, permissions: value },
    });
  }

  async removeMember(projectId: number, userId: number) {
    await this.prisma.projectMember.deleteMany({
      where: { projectId, userId },
    });
  }

  // ───────── Users ─────────

  async listUsers() {
    const users = await this.prisma.user.findMany({
      orderBy: [{ role: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        createdAt: true,
        memberships: {
          select: {
            permissions: true,
            project: { select: { id: true, name: true } },
          },
        },
      },
    });
    return users.map(({ memberships, ...u }) => ({
      ...u,
      projects: memberships
        .map((m) => ({
          projectId: m.project.id,
          name: m.project.name,
          custom: Array.isArray(m.permissions),
          permissions: effectivePermissions(u.role, m.permissions),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }));
  }

  async updateUser(actorId: number, userId: number, dto: UpdateUserDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    if (!user) throw new NotFoundException('User not found');
    if (dto.role && (user.role === 'SUPERADMIN' || userId === actorId))
      throw new BadRequestException(
        "A superadmin's role can't be changed here",
      );
    await this.prisma.user.update({
      where: { id: userId },
      data: { name: dto.name?.trim(), role: dto.role },
    });
  }

  private async assertProject(projectId: number) {
    if (!(await this.prisma.project.count({ where: { id: projectId } })))
      throw new NotFoundException('Project not found');
  }

  private async assertUser(userId: number) {
    if (!(await this.prisma.user.count({ where: { id: userId } })))
      throw new NotFoundException('User not found');
  }

  private async assertBrand(projectId: number, brandId: number) {
    if (!(await this.prisma.brand.count({ where: { id: brandId, projectId } })))
      throw new NotFoundException('Brand not found');
  }
}
