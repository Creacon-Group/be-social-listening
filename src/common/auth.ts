import {
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import type { Request } from 'express';
import type { UserRole } from '../generated/prisma/client.js';

export interface AuthUser {
  id: number;
  email: string;
  name: string;
  role: UserRole;
}

export type AuthedRequest = Request & { user?: AuthUser };

export const AUTH_COOKIE = 'sl_token';

export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** ADMIN and SUPERADMIN see every project. */
export const seesAllProjects = (role: UserRole) =>
  role === 'ADMIN' || role === 'SUPERADMIN';

export const ROLES = 'roles';
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES, roles);

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthUser =>
    ctx.switchToHttp().getRequest<AuthedRequest>().user!,
);
