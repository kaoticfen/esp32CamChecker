import { randomInt } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { PairingCodeRow } from './db.ts';
import { queryAll, queryOne } from './db.ts';

// No I, L, O, 0 or 1 -- these get read aloud and typed on a phone keyboard.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

function generateCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += ALPHABET[randomInt(ALPHABET.length)];
  }
  return code;
}

/** Display form: "ABCD-EFGH". Accepted with or without the dash. */
export function formatCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export function normaliseCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export interface MintedCode {
  code: string;
  display: string;
  expiresAt: number;
}

export function mintCode(db: DatabaseSync, ttlMs: number): MintedCode {
  const now = Date.now();
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = generateCode();
    const existing = db.prepare('select code from pairing_codes where code = ?').get(code);
    if (existing) continue;
    const expiresAt = now + ttlMs;
    db.prepare(
      'insert into pairing_codes (code, created_at, expires_at) values (?, ?, ?)',
    ).run(code, now, expiresAt);
    return { code, display: formatCode(code), expiresAt };
  }
  throw new Error('could not generate a unique pairing code');
}

export type ClaimResult =
  | { ok: true }
  | { ok: false; reason: 'unknown' | 'expired' | 'already-used' };

/**
 * Burns a code. Single-use and time-limited, so a code overheard or left on
 * screen cannot be replayed to enrol an attacker's device later.
 */
export function claimCode(db: DatabaseSync, rawCode: string, deviceId: string): ClaimResult {
  const code = normaliseCode(rawCode);
  const row = queryOne<PairingCodeRow>(db, 'select * from pairing_codes where code = ?', code);

  if (!row) return { ok: false, reason: 'unknown' };
  if (row.used_at !== null) return { ok: false, reason: 'already-used' };
  if (row.expires_at < Date.now()) return { ok: false, reason: 'expired' };

  const result = db
    .prepare('update pairing_codes set used_at = ?, used_by = ? where code = ? and used_at is null')
    .run(Date.now(), deviceId, code);

  // Lost the race against a concurrent claim of the same code.
  if (result.changes === 0) return { ok: false, reason: 'already-used' };
  return { ok: true };
}

export function listActiveCodes(db: DatabaseSync): MintedCode[] {
  const rows = queryAll<PairingCodeRow>(
    db,
    'select * from pairing_codes where used_at is null and expires_at > ? order by created_at desc',
    Date.now(),
  );
  return rows.map((row) => ({
    code: row.code,
    display: formatCode(row.code),
    expiresAt: row.expires_at,
  }));
}
