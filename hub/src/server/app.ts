import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { lookupSession } from './auth.ts';
import type { Config } from './config.ts';
import type { AppContext } from './context.ts';
import { sessionCookieName } from './context.ts';
import { getDevice } from './devices.ts';
import { streamUrl } from './proxy.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerCameraRoutes } from './routes/cameras.ts';
import { registerPairingRoutes } from './routes/pairing.ts';
import { StreamHub } from './stream-hub.ts';

const CSRF_HEADER = 'x-requested-with';
const CSRF_VALUE = 'esp32camchecker';

/**
 * The two routes a camera calls. They carry their own credential -- a pairing
 * code or a device token -- never the session cookie, so they sit outside both
 * the login check and the CSRF header requirement.
 */
const DEVICE_ROUTES = [/^\/api\/pair$/, /^\/api\/devices\/[^/]+\/heartbeat$/];

export interface BuiltApp {
  app: FastifyInstance;
  ctx: AppContext;
}

export async function buildApp(config: Config, db: DatabaseSync): Promise<BuiltApp> {
  const baseOptions = {
    logger: { level: config.logLevel },
    bodyLimit: 256 * 1024,
    // No reverse proxy in the supported topology, so req.ip must stay the real
    // socket peer -- an attacker could otherwise forge X-Forwarded-For.
    trustProxy: false,
  };

  // Fastify's instance type is generic over the server implementation, and the
  // HTTPS variant is not assignable to the default. One cast here keeps every
  // downstream signature plain.
  const app: FastifyInstance = config.tls
    ? (Fastify({
        ...baseOptions,
        https: { cert: config.tls.cert, key: config.tls.key },
      }) as unknown as FastifyInstance)
    : Fastify(baseOptions);

  const hub = new StreamHub((id) => {
    const device = getDevice(db, id);
    if (!device?.last_ip) return null;
    return { url: streamUrl(device), token: device.token };
  }, app.log);

  const ctx: AppContext = { db, config, hub };
  const cookieName = sessionCookieName(config);

  await app.register(cookie, { secret: config.sessionSecret });
  await app.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute' });
  await app.register(fastifyStatic, {
    root: config.publicDir,
    prefix: '/',
    index: ['index.html'],
  });

  app.decorateRequest('user', null);

  app.addHook('preHandler', async (req, reply) => {
    const path = req.url.split('?')[0] ?? '';

    if (!path.startsWith('/api/')) return;
    if (DEVICE_ROUTES.some((pattern) => pattern.test(path))) return;
    if (path === '/api/auth/login') return;

    const rawCookie = req.cookies[cookieName];
    const unsigned = rawCookie ? req.unsignCookie(rawCookie) : null;
    const user =
      unsigned && unsigned.valid && unsigned.value
        ? lookupSession(db, unsigned.value)
        : null;

    if (!user) {
      return reply.code(401).send({ error: 'authentication required' });
    }
    req.user = user;

    // SameSite=Lax already blocks cross-site form posts; this header cannot be
    // set cross-origin without a preflight, which closes the remaining gap.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (req.headers[CSRF_HEADER] !== CSRF_VALUE) {
        return reply.code(403).send({ error: 'missing or bad X-Requested-With header' });
      }
    }
  });

  app.get('/healthz', async (_req, reply) => reply.send({ ok: true }));

  registerAuthRoutes(app, ctx);
  registerCameraRoutes(app, ctx);
  registerPairingRoutes(app, ctx);

  return { app, ctx };
}
