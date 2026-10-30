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

/**
 * Client IP. Vercel overwrites X-Forwarded-For with the real client address, so it is trusted there.
 * Elsewhere a client can send any X-Forwarded-For and reset its own limit, so req.ip is used; it
 * honours the header only from proxies Express trusts (`trust proxy` in main.ts).
 */
const clientIp = (req: Request) => {
  if (process.env.VERCEL) {
    const forwarded = req.headers['x-forwarded-for'];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)
      ?.split(',')[0]
      .trim();
    if (first) return first;
  }
  return req.ip ?? 'unknown';
};

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
    const key = `${ctx.getClass().name}.${ctx.getHandler().name}:${clientIp(req)}`;

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
        'Too many requests. Wait a minute and try again.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
