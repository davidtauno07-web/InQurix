import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { authRouter, authenticate } from './auth.js';
import { orgsRouter } from './orgs.js';
import { sourcesRouter } from './sources.js';
import { billingRouter, webhookRouter } from './billing.js';
import { HttpError } from './http.js';
import { log } from './log.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], frameAncestors: ["'none'"] } } }));
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  // Webhooks need the raw body for signature verification.
  app.use('/api/webhooks', webhookRouter);
  app.use(cookieParser());
  app.use(express.json({ limit: '1mb' }));
  app.use(authenticate);
  app.use('/api/auth', authRouter);
  app.use('/api/billing', billingRouter);
  app.use('/api', orgsRouter);
  app.use('/api', sourcesRouter);
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found', 'not_found')));
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    void _next;
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.code, message: err.message });
    const status = (err as { status?: number; type?: string }).status;
    if (status === 413) return res.status(413).json({ error: 'too_large', message: 'The file or request is too large' });
    if (status === 400 && (err as { type?: string }).type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_request', message: 'Malformed JSON' });
    log.error({ err, path: req.path }, 'Unhandled error');
    res.status(500).json({ error: 'internal', message: 'Something went wrong. Please try again.' });
  });
  return app;
}
