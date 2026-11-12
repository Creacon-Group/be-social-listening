import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../database/prisma.service.js';
import type { UserRole } from '../generated/prisma/client.js';
import {
  AUTH_COOKIE,
  AuthedRequest,
  AuthUser,
  IS_PUBLIC,
  seesAllProjects,
  ROLES,
} from './auth.js';
import {
  effectivePermissions,
  type Permission,
  PERMISSIONS_KEY,
} from './permissions.js';

function readToken(req: AuthedRequest): string | undefined {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  const cookie = req.headers.cookie
    ?.split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${AUTH_COOKIE}=`));
  return cookie
    ? decodeURIComponent(cookie.slice(AUTH_COOKIE.length + 1))
    : undefined;
}

/** Global: every route needs a valid JWT unless marked @Public(). */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const token = readToken(req);
    if (!token) throw new UnauthorizedException();
    let payload: AuthUser & { sub: number };
    try {
      payload = await this.jwt.verifyAsync<AuthUser & { sub: number }>(token);
    } catch {
      throw new UnauthorizedException();
    }
    // Role from the database, not the token: role changes and deleted users apply immediately.
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, name: true, role: true },
    });
    if (!user) throw new UnauthorizedException();
    req.user = user;
    return true;
  }
}

/** Global: enforces @Roles(...) when present. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext) {
    const roles = this.reflector.getAllAndOverride<UserRole[] | undefined>(
      ROLES,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (!roles?.length) return true;
    const user = ctx.switchToHttp().getRequest<AuthedRequest>().user;
    // SUPERADMIN passes every role check.
    if (!user || (user.role !== 'SUPERADMIN' && !roles.includes(user.role)))
      throw new ForbiddenException();
    return true;
  }
}

/**
 * Global: any route with a :projectId param requires membership (ADMIN/SUPERADMIN see every project),
 * then enforces @RequirePermission(...) against the member's permissions in that project.
 * The result is left on req.projectPermissions for GET /projects/:projectId/access.
 */
@Injectable()
export class ProjectAccessGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const raw = req.params?.projectId;
    if (raw === undefined || !req.user) return true;

    const projectId = Number(raw);
    if (!Number.isInteger(projectId)) throw new NotFoundException();
    let stored: unknown = null;
    if (seesAllProjects(req.user.role)) {
      const exists = await this.prisma.project.count({
        where: { id: projectId },
      });
      if (!exists) throw new NotFoundException();
    } else {
      const member = await this.prisma.projectMember.findUnique({
        where: { userId_projectId: { userId: req.user.id, projectId } },
        select: { permissions: true },
      });
      if (!member) throw new NotFoundException(); // do not reveal that the project exists
      stored = member.permissions;
    }

    const granted = effectivePermissions(req.user.role, stored);
    req.projectPermissions = granted;

    const required = this.reflector.getAllAndOverride<Permission[] | undefined>(
      PERMISSIONS_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (required?.length && !required.some((p) => granted.includes(p)))
      throw new ForbiddenException('You do not have access to this feature');
    return true;
  }
}
