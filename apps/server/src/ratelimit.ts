import type { RequestHandler } from 'express';
import { HttpError } from './http.js';

/** Fixed-window in-memory limiter. Use a shared store when running several server instances. */
export function rateLimit(name: string, max: number, windowMs: number): RequestHandler {
  const hits = new Map<string, { n: number; reset: number }>();
  return (req, _res, next) => {
    if (process.env.INQURIX_DISABLE_RATE_LIMIT === '1') return next();
    const key = `${name}:${req.ip}`;
    const now = Date.now();
    const h = hits.get(key);
    if (!h || h.reset < now) hits.set(key, { n: 1, reset: now + windowMs });
    else if (++h.n > max) return next(new HttpError(429, 'Too many attempts. Please wait and try again.', 'rate_limited'));
    if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    next();
  };
}
