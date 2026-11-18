import type { ErrorRequestHandler, RequestHandler, Response } from 'express';
import { ZodError } from 'zod';
import { HttpError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import type { Caller } from '../modules/tenancy/tenancy.js';

/**
 * Simulated authentication. Production would verify a token (e.g. Entra ID) and read the
 * tenant from it. The tenant is NEVER taken from the URL or body.
 */
export const authenticate: RequestHandler = (req, res, next) => {
  const tenantId = req.header('x-tenant-id');
  const userId = req.header('x-user-id') ?? 'unknown-user';
  if (!tenantId) {
    res.status(401).json({ error: 'Missing x-tenant-id header (simulated auth)' });
    return;
  }
  res.locals.caller = { tenantId, userId } satisfies Caller;
  next();
};

export function callerOf(res: Response): Caller {
  return res.locals.caller as Caller;
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(400).json({ error: 'Validation failed', issues: err.issues });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, details: err.details });
    return;
  }
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({ error: 'Invalid JSON body' });
    return;
  }
  logger.error({ err }, 'Unhandled API error');
  res.status(500).json({ error: 'Internal error' });
};
