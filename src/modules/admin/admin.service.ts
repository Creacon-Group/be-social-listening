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
import { ignoredSet, keywordKey } from '../../common/keywords.js';
import { BrandTaggingService } from '../projects/brand-tagging.service.js';
import type {
  BrandDto,
  CreateProjectDto,
  UpdateBrandDto,
  UpdateProjectDto,
  UpdateUserDto,
} from './admin.dto.js';

const stringList = (v: unknown) =>
  Array.isArray(v) ? v.filter((a): a is string => typeof a === 'string') : [];

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly tagging: BrandTaggingService,
  ) {}

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
    let brand;
    try {
      brand = await this.prisma.brand.create({
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
    // Existing mentions whose keyword matches the new name/aliases count for it right away.
    await this.tagging.retag(projectId, [brand.id]);
    return brand;
  }

  async updateBrand(projectId: number, brandId: number, dto: UpdateBrandDto) {
    await this.assertBrand(projectId, brandId);
    let brand;
    try {
      brand = await this.prisma.brand.update({
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
    if (dto.name !== undefined || dto.aliases !== undefined)
      await this.tagging.retag(projectId, [brandId]);
    return brand;
  }

  // ───────── Keywords from the data ─────────

  async keywords(projectId: number) {
    await this.assertProject(projectId);
    return this.tagging.keywords(projectId);
  }

  /** Add a keyword as an alias of a brand and re-tag existing mentions. */
  async assignKeyword(projectId: number, brandId: number, keyword: string) {
    await this.assertBrand(projectId, brandId);
    const brand = await this.prisma.brand.findUniqueOrThrow({
      where: { id: brandId },
      select: { name: true, aliases: true },
    });
    const aliases = Array.isArray(brand.aliases)
      ? (brand.aliases as unknown[]).filter(
          (a): a is string => typeof a === 'string',
        )
      : [];
    const key = keywordKey(keyword);
    if (
      keywordKey(brand.name) !== key &&
      !aliases.some((a) => keywordKey(a) === key)
    )
      await this.prisma.brand.update({
        where: { id: brandId },
        data: { aliases: [...aliases, keyword.trim()] },
      });
    await this.setIgnored(projectId, keyword, false);
    const [res] = await this.tagging.retag(projectId, [brandId]);
    return res;
  }

  /** Mark a keyword as "not a brand" (or undo). */
  async setIgnored(projectId: number, keyword: string, ignored: boolean) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { ignoredKeywords: true },
    });
    if (!project) throw new NotFoundException('Project not found');
    const set = ignoredSet(project.ignoredKeywords);
    const key = keywordKey(keyword);
    if (ignored === set.has(key)) return;
    if (ignored) set.add(key);
    else set.delete(key);
    await this.prisma.project.update({
      where: { id: projectId },
      data: { ignoredKeywords: [...set].sort() },
    });
  }

  retagAll(projectId: number) {
    return this.tagging.retag(projectId);
  }

  /**
   * Delete a brand. Mentions are never deleted, only their tag for this brand.
   * - mergeInto: the brand's name and aliases move to the target brand, its tags too, then
   *   the target is re-tagged from keywords (e.g. "Brand A Official" into "Brand A").
   * - ignoreKeywords: its name and aliases are marked "not a brand" so they stop showing as
   *   unmapped keywords (for brands that aren't relevant to the project).
   */
  async deleteBrand(
    projectId: number,
    brandId: number,
    opts: { mergeInto?: number; ignoreKeywords?: boolean } = {},
  ) {
    await this.assertBrand(projectId, brandId);
    const source = await this.prisma.brand.findUniqueOrThrow({
      where: { id: brandId },
      select: { name: true, aliases: true },
    });
    const sourceLabels = [source.name, ...stringList(source.aliases)];

    if (opts.mergeInto !== undefined) {
      if (opts.mergeInto === brandId)
        throw new BadRequestException("A brand can't be merged into itself");
      await this.assertBrand(projectId, opts.mergeInto);
      const target = await this.prisma.brand.findUniqueOrThrow({
        where: { id: opts.mergeInto },
        select: { name: true, aliases: true },
      });
      const aliases = stringList(target.aliases);
      const taken = new Set([target.name, ...aliases].map(keywordKey));
      for (const label of sourceLabels) {
        const key = keywordKey(label);
        if (key && !taken.has(key)) {
          aliases.push(label.trim());
          taken.add(key);
        }
      }
      await this.prisma.$transaction(
        async (tx) => {
          await tx.brand.update({
            where: { id: opts.mergeInto },
            data: { aliases },
          });
          // Tags of mentions without stored keywords (older data) move over as they are.
          await tx.$executeRaw`
            INSERT IGNORE INTO mention_brands (mentionId, brandId)
            SELECT mentionId, ${opts.mergeInto} FROM mention_brands WHERE brandId = ${brandId}`;
          await tx.brand.delete({ where: { id: brandId } });
        },
        { timeout: 120_000 },
      );
      const [res] = await this.tagging.retag(projectId, [opts.mergeInto]);
      return { merged: true, ...res };
    }

    await this.prisma.brand.delete({ where: { id: brandId } });
    if (opts.ignoreKeywords)
      for (const label of sourceLabels)
        await this.setIgnored(projectId, label, true);
    return { merged: false };
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
