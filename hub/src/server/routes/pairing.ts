import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.ts';
import type { DeviceRow } from '../db.ts';
import {
  getDevice,
  newDeviceToken,
  recordHeartbeat,
  tokenMatches,
  upsertDevice,
} from '../devices.ts';
import { claimCode, listActiveCodes, mintCode } from '../pairing.ts';

function bearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice(7);
}

function authenticateDevice(ctx: AppContext, req: FastifyRequest, id: string): DeviceRow | null {
  const token = bearerToken(req);
  if (!token) return null;
  const device = getDevice(ctx.db, id);
  if (!device) return null;
  return tokenMatches(token, device.token) ? device : null;
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function int(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

export function registerPairingRoutes(app: FastifyInstance, ctx: AppContext): void {
  // ---- Operator side -------------------------------------------------------

  app.post('/api/pair/code', async (_req, reply) => {
    const minted = mintCode(ctx.db, ctx.config.pairingCodeTtlMs);
    return reply.send(minted);
  });

  app.get('/api/pair/codes', async (_req, reply) => {
    return reply.send({ codes: listActiveCodes(ctx.db) });
  });

  // ---- Camera side ---------------------------------------------------------
  // These two are the only routes a camera calls, and the only ones outside the
  // session cookie. They authenticate with the pairing code and device token
  // respectively, so they are exempt from the CSRF header check.

  app.post(
    '/api/pair',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = req.body as Record<string, unknown> | undefined;
      const code = str(body?.code);
      const deviceId = str(body?.deviceId);

      if (!code || !deviceId) {
        return reply.code(400).send({ error: 'code and deviceId are required' });
      }
      if (!/^[a-z0-9-]{4,64}$/i.test(deviceId)) {
        return reply.code(400).send({ error: 'malformed deviceId' });
      }

      const claim = claimCode(ctx.db, code, deviceId);
      if (!claim.ok) {
        req.log.warn({ deviceId, ip: req.ip, reason: claim.reason }, 'pairing rejected');
        return reply.code(403).send({ error: `pairing code ${claim.reason}` });
      }

      const token = newDeviceToken();
      const name = str(body?.name).trim() || deviceId;
      // Prefer the camera's self-reported LAN address over the socket peer:
      // when the hub runs in a bridged container, Docker's userland proxy can
      // rewrite the peer address to the bridge gateway, which routes nowhere.
      const reportedIp = str(body?.ip) || req.ip;

      upsertDevice(ctx.db, {
        id: deviceId,
        name,
        token,
        control_port: int(body?.controlPort, 80),
        stream_port: int(body?.streamPort, 81),
        last_ip: reportedIp,
      });

      // A re-pair issues a new token, so any stream still running under the old
      // one has to be torn down.
      ctx.hub.drop(deviceId);

      req.log.info({ deviceId, name, ip: reportedIp }, 'camera paired');
      return reply.send({ token, name, deviceId });
    },
  );

  app.post<{ Params: { id: string } }>('/api/devices/:id/heartbeat', async (req, reply) => {
    const device = authenticateDevice(ctx, req, req.params.id);
    if (!device) return reply.code(401).send({ error: 'unknown device or bad token' });

    const body = req.body as Record<string, unknown> | undefined;
    recordHeartbeat(ctx.db, device.id, {
      ip: str(body?.ip) || req.ip,
      rssi: int(body?.rssi, 0),
      fwVersion: str(body?.fwVersion) || null,
      name: null, // the hub owns the display name once a camera is enrolled
      controlPort: int(body?.controlPort, device.control_port),
      streamPort: int(body?.streamPort, device.stream_port),
      sdMounted: body?.sdMounted === true,
      sdTotalKb: int(body?.sdTotalKb, 0),
      sdUsedKb: int(body?.sdUsedKb, 0),
    });

    return reply.send({ ok: true, name: device.name });
  });
}
