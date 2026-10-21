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
    try {
      const payload = await this.jwt.verifyAsync<AuthUser & { sub: number }>(
        token,
      );
      req.user = {
        id: payload.sub,
        email: payload.email,
        name: payload.name,
        role: payload.role,
      };
      return true;
    } catch {
      throw new UnauthorizedException();
    }
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

/** Global: any route with a :projectId param requires membership (ADMIN/SUPERADMIN see every project). */
@Injectable()
export class ProjectAccessGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const raw = req.params?.projectId;
    if (raw === undefined || !req.user) return true;

    const projectId = Number(raw);
    if (!Number.isInteger(projectId)) throw new NotFoundException();
    if (seesAllProjects(req.user.role)) {
      const exists = await this.prisma.project.count({
        where: { id: projectId },
      });
      if (!exists) throw new NotFoundException();
      return true;
    }
    const member = await this.prisma.projectMember.count({
      where: { projectId, userId: req.user.id },
    });
    if (!member) throw new NotFoundException(); // do not reveal that the project exists
    return true;
  }
}
