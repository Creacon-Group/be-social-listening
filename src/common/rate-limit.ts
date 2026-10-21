import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

/**
 * Small fixed-window rate limiter. Replaces @nestjs/throttler, which is CommonJS and cannot load
 * the ESM-only @nestjs/common 12 on Vercel's runtime (ERR_REQUIRE_ESM).
 * Counters live in memory, so on serverless each instance counts separately: good enough to stop
 * a script hammering login or the AI endpoint, not a hard quota.
 */
const RATE_LIMIT = 'rateLimit';
const DEFAULT = { limit: 300, ttlMs: 60_000 };

export const RateLimit = (limit: number, ttlMs = 60_000) =>
  SetMetadata(RATE_LIMIT, { limit, ttlMs });

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const { limit, ttlMs } =
      this.reflector.getAllAndOverride<typeof DEFAULT>(RATE_LIMIT, [
        ctx.getHandler(),
        ctx.getClass(),
      ]) ?? DEFAULT;
    const req = ctx.switchToHttp().getRequest<Request>();
    const forwarded = req.headers['x-forwarded-for'];
    const ip =
      (Array.isArray(forwarded) ? forwarded[0] : forwarded)
        ?.split(',')[0]
        .trim() ?? req.ip;
    const key = `${ctx.getClass().name}.${ctx.getHandler().name}:${ip}`;

    const now = Date.now();
    if (this.hits.size > 10_000) {
      for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
    }
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + ttlMs });
      return true;
    }
    if (++entry.count > limit) {
      throw new HttpException(
        'Terlalu banyak permintaan. Coba lagi sebentar.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
