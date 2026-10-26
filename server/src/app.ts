import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { config } from './config.ts';
import { HttpError } from './core/http.ts';
import { registerAuthGuard, authRoutes } from './security/auth.ts';
import { coreRoutes } from './core/routes.ts';
import { loadModules } from './modules/index.ts';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    trustProxy: config.COMB_TRUST_PROXY ? config.COMB_TRUST_PROXY.split(',').map((s) => s.trim()) : false,
    bodyLimit: 4 * 1024 * 1024,
    logger: {
      level: config.isProd ? 'info' : 'warn',
      // Never log credentials, cookies, or request bodies (they can contain SQL with data).
      redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-comb-csrf"]', 'res.headers["set-cookie"]'],
    },
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        fontSrc: ["'self'", 'data:'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: config.cookieSecure ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: config.cookieSecure ? { maxAge: 31536000, includeSubDomains: true } : false,
    referrerPolicy: { policy: 'no-referrer' },
  });
  await app.register(cookie);
  await app.register(rateLimit, { global: true, max: 1200, timeWindow: '1 minute' });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.status).send({ error: err.message, ...(err.extra ?? {}) });
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply.status(err.statusCode).send({ error: err.message });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: 'Something went wrong on the server. It has been logged.' });
  });

  registerAuthGuard(app);
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.url.startsWith('/api/')) reply.header('cache-control', 'no-store');
    return payload;
  });

  const modules = await loadModules();
  await app.register(async (api) => {
    await authRoutes(api);
    await coreRoutes(api);
    for (const m of modules) await api.register(m);
  }, { prefix: '/api' });

  // Serve the built SPA in production.
  const dist = config.COMB_WEB_DIST ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');
  if (fs.existsSync(path.join(dist, 'index.html'))) {
    await app.register(fastifyStatic, { root: dist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ error: 'Not found' });
      return reply.sendFile('index.html');
    });
  }
  return app;
}
