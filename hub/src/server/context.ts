import type { DatabaseSync } from 'node:sqlite';
import type { Config } from './config.ts';
import type { UserRow } from './db.ts';
import type { StreamHub } from './stream-hub.ts';

export interface AppContext {
  db: DatabaseSync;
  config: Config;
  hub: StreamHub;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the session preHandler; absent on unauthenticated requests. */
    user: UserRow | null;
  }
}

export const SESSION_COOKIE_SECURE = '__Host-camsess';
export const SESSION_COOKIE_PLAIN = 'camsess';

export function sessionCookieName(config: Config): string {
  // The __Host- prefix requires Secure, which a browser refuses over plain
  // HTTP -- so the name has to follow the transport.
  return config.tls ? SESSION_COOKIE_SECURE : SESSION_COOKIE_PLAIN;
}
