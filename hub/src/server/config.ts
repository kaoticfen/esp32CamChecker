import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const hubRoot = resolve(here, '..', '..');

export interface TlsConfig {
  cert: Buffer;
  key: Buffer;
}

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  publicDir: string;
  sessionSecret: string;
  sessionTtlMs: number;
  tls: TlsConfig | null;
  adminUser: string;
  adminPassword: string | null;
  /** A camera that has not checked in for this long is shown as offline. */
  offlineAfterMs: number;
  pairingCodeTtlMs: number;
  logLevel: string;
}

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

function envInt(name: string, fallback: number): number {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be an integer, got "${raw}"`);
  return parsed;
}

function loadTls(): TlsConfig | null {
  const certPath = env('TLS_CERT_FILE');
  const keyPath = env('TLS_KEY_FILE');
  if (!certPath && !keyPath) return null;
  if (!certPath || !keyPath) {
    throw new Error('TLS_CERT_FILE and TLS_KEY_FILE must be set together');
  }
  return { cert: readFileSync(certPath), key: readFileSync(keyPath) };
}

/**
 * The session secret has to survive restarts or every login drops on deploy,
 * so an unset SESSION_SECRET generates one and keeps it beside the database
 * rather than making first-run setup require a manual step.
 */
function loadSessionSecret(dataDir: string): string {
  const fromEnv = env('SESSION_SECRET');
  if (fromEnv) {
    if (fromEnv.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
    return fromEnv;
  }
  const secretFile = resolve(dataDir, 'session.secret');
  if (existsSync(secretFile)) return readFileSync(secretFile, 'utf8').trim();
  const generated = randomBytes(32).toString('base64url');
  writeFileSync(secretFile, generated, { mode: 0o600 });
  return generated;
}

export function loadConfig(): Config {
  const dataDir = resolve(env('DATA_DIR') ?? resolve(hubRoot, 'data'));
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  const tls = loadTls();

  return {
    host: env('HUB_HOST') ?? '0.0.0.0',
    port: envInt('HUB_PORT', tls ? 8443 : 8080),
    dataDir,
    publicDir: resolve(env('PUBLIC_DIR') ?? resolve(hubRoot, 'public')),
    sessionSecret: loadSessionSecret(dataDir),
    sessionTtlMs: envInt('SESSION_TTL_HOURS', 24 * 30) * 60 * 60 * 1000,
    tls,
    adminUser: env('ADMIN_USER') ?? 'admin',
    adminPassword: env('ADMIN_PASSWORD') ?? null,
    // Cameras heartbeat every 30s; three misses is a confident "offline".
    offlineAfterMs: envInt('OFFLINE_AFTER_SECONDS', 100) * 1000,
    pairingCodeTtlMs: envInt('PAIRING_CODE_TTL_MINUTES', 10) * 60 * 1000,
    logLevel: env('LOG_LEVEL') ?? 'info',
  };
}
