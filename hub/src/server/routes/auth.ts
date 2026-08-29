import type { FastifyInstance } from 'fastify';
import { createSession, destroySession, findUser, verifyPassword } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { sessionCookieName } from '../context.ts';

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  const cookieName = sessionCookieName(ctx.config);

  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = req.body as { username?: unknown; password?: unknown } | undefined;
      const username = typeof body?.username === 'string' ? body.username : '';
      const password = typeof body?.password === 'string' ? body.password : '';

      if (!username || !password) {
        return reply.code(400).send({ error: 'username and password are required' });
      }

      const user = findUser(ctx.db, username);
      // Hash even when the user does not exist, so a wrong username and a wrong
      // password take the same amount of time to reject.
      const stored = user?.password_hash ?? '$scrypt$16384$8$1$aaaa$bbbb';
      const ok = await verifyPassword(password, stored);

      if (!user || !ok) {
        req.log.warn({ username, ip: req.ip }, 'failed login');
        return reply.code(401).send({ error: 'invalid credentials' });
      }

      const sessionId = createSession(ctx.db, user.id, ctx.config.sessionTtlMs);
      reply.setCookie(cookieName, sessionId, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: ctx.config.tls !== null,
        signed: true,
        maxAge: Math.floor(ctx.config.sessionTtlMs / 1000),
      });
      return reply.send({ username: user.username });
    },
  );

  app.post('/api/auth/logout', async (req, reply) => {
    const raw = req.cookies[cookieName];
    if (raw) {
      const unsigned = req.unsignCookie(raw);
      if (unsigned.valid && unsigned.value) destroySession(ctx.db, unsigned.value);
    }
    reply.clearCookie(cookieName, { path: '/' });
    return reply.send({ ok: true });
  });

  app.get('/api/auth/me', async (req, reply) => {
    // The global preHandler has already rejected unauthenticated requests.
    return reply.send({ username: req.user?.username ?? null });
  });
}
