import type { FastifyRequest } from 'fastify';
import type { ZodType } from 'zod';

export class HttpError extends Error {
  constructor(public status: number, message: string, public extra?: Record<string, unknown>) {
    super(message);
  }
}

export const badRequest = (m: string, extra?: Record<string, unknown>) => new HttpError(400, m, extra);
export const forbidden = (m = 'Not allowed') => new HttpError(403, m);
export const notFound = (m = 'Not found') => new HttpError(404, m);
export const conflict = (m: string, extra?: Record<string, unknown>) => new HttpError(409, m, extra);

/** Validates a request body (or query) with zod and returns typed data, or throws 400. */
export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw badRequest('Invalid input: ' + r.error.issues.map((i) => (i.path.join('.') || 'body') + ' ' + i.message).join('; '));
  }
  return r.data;
}

export function clientIp(req: FastifyRequest): string {
  return req.ip;
}
