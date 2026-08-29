import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { DeviceRow } from './db.ts';
import { queryAll, queryOne } from './db.ts';

export interface DeviceView {
  id: string;
  name: string;
  online: boolean;
  lastSeen: number | null;
  ip: string | null;
  rssi: number | null;
  fwVersion: string | null;
  sd: { mounted: boolean; totalKb: number; usedKb: number };
}

export function newDeviceToken(): string {
  return randomBytes(32).toString('base64url');
}

export function listDevices(db: DatabaseSync): DeviceRow[] {
  return queryAll<DeviceRow>(db, 'select * from devices order by name collate nocase');
}

export function getDevice(db: DatabaseSync, id: string): DeviceRow | null {
  return queryOne<DeviceRow>(db, 'select * from devices where id = ?', id);
}

export function deleteDevice(db: DatabaseSync, id: string): boolean {
  const result = db.prepare('delete from devices where id = ?').run(id);
  return result.changes > 0;
}

export function renameDevice(db: DatabaseSync, id: string, name: string): boolean {
  const result = db.prepare('update devices set name = ? where id = ?').run(name, id);
  return result.changes > 0;
}

export function upsertDevice(
  db: DatabaseSync,
  device: Pick<DeviceRow, 'id' | 'name' | 'token' | 'control_port' | 'stream_port' | 'last_ip'>,
): void {
  db.prepare(
    `insert into devices (id, name, token, control_port, stream_port, last_ip, last_seen, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(id) do update set
       name = excluded.name,
       token = excluded.token,
       control_port = excluded.control_port,
       stream_port = excluded.stream_port,
       last_ip = excluded.last_ip,
       last_seen = excluded.last_seen`,
  ).run(
    device.id,
    device.name,
    device.token,
    device.control_port,
    device.stream_port,
    device.last_ip,
    Date.now(),
    Date.now(),
  );
}

export interface HeartbeatFields {
  ip: string | null;
  rssi: number | null;
  fwVersion: string | null;
  name: string | null;
  controlPort: number | null;
  streamPort: number | null;
  sdMounted: boolean;
  sdTotalKb: number;
  sdUsedKb: number;
}

export function recordHeartbeat(db: DatabaseSync, id: string, fields: HeartbeatFields): void {
  db.prepare(
    `update devices set
       last_ip      = coalesce(?, last_ip),
       last_seen    = ?,
       rssi         = ?,
       fw_version   = coalesce(?, fw_version),
       control_port = coalesce(?, control_port),
       stream_port  = coalesce(?, stream_port),
       sd_mounted   = ?,
       sd_total_kb  = ?,
       sd_used_kb   = ?
     where id = ?`,
  ).run(
    fields.ip,
    Date.now(),
    fields.rssi,
    fields.fwVersion,
    fields.controlPort,
    fields.streamPort,
    fields.sdMounted ? 1 : 0,
    fields.sdTotalKb,
    fields.sdUsedKb,
    id,
  );
}

/** Constant-time so a caller cannot probe a device token byte by byte. */
export function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function isOnline(device: DeviceRow, offlineAfterMs: number): boolean {
  return device.last_seen !== null && Date.now() - device.last_seen < offlineAfterMs;
}

export function toView(device: DeviceRow, offlineAfterMs: number): DeviceView {
  return {
    id: device.id,
    name: device.name,
    online: isOnline(device, offlineAfterMs),
    lastSeen: device.last_seen,
    ip: device.last_ip,
    rssi: device.rssi,
    fwVersion: device.fw_version,
    sd: {
      mounted: device.sd_mounted === 1,
      totalKb: device.sd_total_kb,
      usedKb: device.sd_used_kb,
    },
  };
}
