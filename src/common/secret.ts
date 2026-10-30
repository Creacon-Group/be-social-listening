import { createHash, timingSafeEqual } from 'node:crypto';

/** Constant-time compare: both sides are hashed first so input length does not leak through timing. */
export const sameSecret = (given: string, expected: string) =>
  timingSafeEqual(
    createHash('sha256').update(given).digest(),
    createHash('sha256').update(expected).digest(),
  );

/** Reads "Bearer <token>" from an Authorization header. */
export const bearer = (authorization: string | undefined) =>
  authorization?.replace(/^Bearer\s+/i, '') || undefined;
