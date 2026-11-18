/**
 * Error types used to decide what to do when something goes wrong.
 *
 * - PermanentError: retrying will not help (bad config, missing data). Fail now.
 * - TransientError: may work later (network, database restart). Retry with backoff.
 * - Any other error is treated as transient, but still limited by max attempts.
 */
export class PermanentError extends Error {
  override readonly name = 'PermanentError';
}

export class TransientError extends Error {
  override readonly name = 'TransientError';
}

export function isPermanent(err: unknown): boolean {
  return err instanceof PermanentError;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Errors that the HTTP layer turns into a status code. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what = 'Not found') => new HttpError(404, what);
export const badRequest = (message: string, details?: unknown) => new HttpError(400, message, details);
export const conflict = (message: string) => new HttpError(409, message);
