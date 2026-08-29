import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';

export interface DeviceRow {
  id: string;
  name: string;
  token: string;
  control_port: number;
  stream_port: number;
  last_ip: string | null;
  last_seen: number | null;
  fw_version: string | null;
  rssi: number | null;
  sd_mounted: number;
  sd_total_kb: number;
  sd_used_kb: number;
  created_at: number;
}

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  created_at: number;
}

export interface SessionRow {
  id_hash: string;
  user_id: number;
  created_at: number;
  expires_at: number;
}

export interface PairingCodeRow {
  code: string;
  created_at: number;
  expires_at: number;
  used_at: number | null;
  used_by: string | null;
}

const SCHEMA = `
create table if not exists users (
  id            integer primary key autoincrement,
  username      text not null unique,
  password_hash text not null,
  created_at    integer not null
);

create table if not exists sessions (
  id_hash    text primary key,
  user_id    integer not null references users(id) on delete cascade,
  created_at integer not null,
  expires_at integer not null
);

create table if not exists devices (
  id           text primary key,
  name         text not null,
  token        text not null,
  control_port integer not null default 80,
  stream_port  integer not null default 81,
  last_ip      text,
  last_seen    integer,
  fw_version   text,
  rssi         integer,
  sd_mounted   integer not null default 0,
  sd_total_kb  integer not null default 0,
  sd_used_kb   integer not null default 0,
  created_at   integer not null
);

create table if not exists pairing_codes (
  code       text primary key,
  created_at integer not null,
  expires_at integer not null,
  used_at    integer,
  used_by    text
);

create index if not exists idx_sessions_expires on sessions(expires_at);
create index if not exists idx_pairing_expires on pairing_codes(expires_at);
`;

export type SqlParam = null | number | bigint | string | Uint8Array;

/**
 * node:sqlite hands back `Record<string, SQLOutputValue>`, which no row
 * interface overlaps with. These two wrappers hold the one unavoidable cast so
 * it does not have to be repeated (and re-justified) at every call site.
 */
export function queryAll<T>(db: DatabaseSync, sql: string, ...params: SqlParam[]): T[] {
  return db.prepare(sql).all(...params) as unknown as T[];
}

export function queryOne<T>(db: DatabaseSync, sql: string, ...params: SqlParam[]): T | null {
  return (db.prepare(sql).get(...params) as unknown as T | undefined) ?? null;
}

export function openDatabase(dataDir: string): DatabaseSync {
  const db = new DatabaseSync(resolve(dataDir, 'hub.db'));
  // WAL keeps a long-running MJPEG request from blocking a heartbeat write.
  db.exec('pragma journal_mode = WAL');
  db.exec('pragma foreign_keys = ON');
  db.exec('pragma busy_timeout = 5000');
  db.exec(SCHEMA);
  return db;
}

/** Drops expired sessions and pairing codes. Cheap enough to run on a timer. */
export function pruneExpired(db: DatabaseSync): void {
  const now = Date.now();
  db.prepare('delete from sessions where expires_at < ?').run(now);
  db.prepare('delete from pairing_codes where expires_at < ? and used_at is null').run(now);
}
