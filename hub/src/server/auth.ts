import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import type { SessionRow, UserRow } from './db.ts';
import { queryOne } from './db.ts';

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

// Deliberately slow. These land well under a second on any machine that can
// run Docker, and the hub only ever hashes on login.
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LENGTH = 32;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, KEY_LENGTH, SCRYPT_PARAMS);
  return [
    'scrypt',
    SCRYPT_PARAMS.N,
    SCRYPT_PARAMS.r,
    SCRYPT_PARAMS.p,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4]!, 'base64url');
  const expected = Buffer.from(parts[5]!, 'base64url');
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  const derived = await scryptAsync(password, salt, expected.length, {
    N,
    r,
    p,
    maxmem: SCRYPT_PARAMS.maxmem,
  });
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/**
 * Sessions are stored by hash. A leaked database copy then reveals no usable
 * session cookies, only the fact that sessions existed.
 */
function hashSessionId(id: string): string {
  return createHash('sha256').update(id).digest('base64url');
}

export function createSession(db: DatabaseSync, userId: number, ttlMs: number): string {
  const id = randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare(
    'insert into sessions (id_hash, user_id, created_at, expires_at) values (?, ?, ?, ?)',
  ).run(hashSessionId(id), userId, now, now + ttlMs);
  return id;
}

export function lookupSession(db: DatabaseSync, id: string): UserRow | null {
  const session = queryOne<SessionRow>(
    db,
    'select * from sessions where id_hash = ?',
    hashSessionId(id),
  );
  if (!session) return null;
  if (session.expires_at < Date.now()) {
    db.prepare('delete from sessions where id_hash = ?').run(session.id_hash);
    return null;
  }
  return queryOne<UserRow>(db, 'select * from users where id = ?', session.user_id);
}

export function destroySession(db: DatabaseSync, id: string): void {
  db.prepare('delete from sessions where id_hash = ?').run(hashSessionId(id));
}

export function findUser(db: DatabaseSync, username: string): UserRow | null {
  return queryOne<UserRow>(db, 'select * from users where username = ?', username);
}

export function countUsers(db: DatabaseSync): number {
  return queryOne<{ n: number }>(db, 'select count(*) as n from users')?.n ?? 0;
}

export async function createUser(
  db: DatabaseSync,
  username: string,
  password: string,
): Promise<void> {
  const hash = await hashPassword(password);
  db.prepare('insert into users (username, password_hash, created_at) values (?, ?, ?)').run(
    username,
    hash,
    Date.now(),
  );
}

/**
 * Bootstraps the first login. Without ADMIN_PASSWORD we generate one and print
 * it, so a fresh container is never reachable with a guessable default.
 */
export async function ensureAdminUser(
  db: DatabaseSync,
  username: string,
  password: string | null,
  log: (message: string) => void,
): Promise<void> {
  if (countUsers(db) > 0) return;

  const effective = password ?? randomBytes(12).toString('base64url');
  await createUser(db, username, effective);

  if (password) {
    log(`Created admin user "${username}" from ADMIN_PASSWORD.`);
  } else {
    log(
      `Created admin user "${username}" with generated password: ${effective}\n` +
        'Save it now -- it is not stored anywhere in readable form and will not be shown again.',
    );
  }
}
