import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AppContext } from '../context.ts';
import type { DeviceRow } from '../db.ts';
import { deleteDevice, getDevice, listDevices, renameDevice, toView } from '../devices.ts';
import { cameraFetch, parseContentRange, readChunks, streamUrl } from '../proxy.ts';

const BOUNDARY = 'esp32camhub';
/** Drop frames for a viewer once this much is queued rather than buffering. */
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.name === 'TimeoutError' ? 'camera timed out' : error.message;
  }
  return String(error);
}

async function forwardJson(reply: FastifyReply, upstream: Response): Promise<FastifyReply> {
  const text = await upstream.text();
  reply.code(upstream.status);
  reply.type(upstream.headers.get('content-type') ?? 'application/json');
  return reply.send(text);
}

export function registerCameraRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** Resolves the camera, or sends the right 404/503 and returns null. */
  function resolveDevice(reply: FastifyReply, id: string): DeviceRow | null {
    const device = getDevice(ctx.db, id);
    if (!device) {
      void reply.code(404).send({ error: 'no such camera' });
      return null;
    }
    if (!device.last_ip) {
      void reply.code(503).send({ error: 'camera has not checked in yet' });
      return null;
    }
    return device;
  }

  app.get('/api/cameras', async (_req, reply) => {
    const cameras = listDevices(ctx.db).map((device) => ({
      ...toView(device, ctx.config.offlineAfterMs),
      viewers: ctx.hub.viewerCount(device.id),
    }));
    return reply.send({ cameras });
  });

  app.get<{ Params: { id: string } }>('/api/cameras/:id/info', async (req, reply) => {
    const device = resolveDevice(reply, req.params.id);
    if (!device) return reply;
    try {
      return await forwardJson(reply, await cameraFetch(device, '/api/info'));
    } catch (error) {
      return reply.code(502).send({ error: describeError(error) });
    }
  });

  app.patch<{ Params: { id: string } }>('/api/cameras/:id', async (req, reply) => {
    const body = req.body as { name?: unknown } | undefined;
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 64) {
      return reply.code(400).send({ error: 'name must be 1-64 characters' });
    }
    if (!renameDevice(ctx.db, req.params.id, name)) {
      return reply.code(404).send({ error: 'no such camera' });
    }
    return reply.send({ ok: true, name });
  });

  app.delete<{ Params: { id: string } }>('/api/cameras/:id', async (req, reply) => {
    ctx.hub.drop(req.params.id);
    if (!deleteDevice(ctx.db, req.params.id)) {
      return reply.code(404).send({ error: 'no such camera' });
    }
    // The camera keeps its now-orphaned token until its heartbeats start
    // failing, at which point it wipes itself back to the setup portal.
    return reply.send({ ok: true });
  });

  // ---- Imaging -------------------------------------------------------------

  app.get<{ Params: { id: string } }>('/api/cameras/:id/snapshot', async (req, reply) => {
    const device = resolveDevice(reply, req.params.id);
    if (!device) return reply;

    try {
      const frame = await ctx.hub.snapshot(device.id, async () => {
        const upstream = await cameraFetch(device, '/api/snapshot', { timeoutMs: 8000 });
        if (!upstream.ok) throw new Error(`camera returned HTTP ${upstream.status}`);
        return Buffer.from(await upstream.arrayBuffer());
      });
      reply.header('Cache-Control', 'no-store');
      return reply.type('image/jpeg').send(frame);
    } catch (error) {
      return reply.code(502).send({ error: describeError(error) });
    }
  });

  app.get<{ Params: { id: string } }>('/api/cameras/:id/stream', async (req, reply) => {
    const device = resolveDevice(reply, req.params.id);
    if (!device) return reply;

    try {
      streamUrl(device); // fail fast if the camera has no usable address
    } catch (error) {
      return reply.code(503).send({ error: describeError(error) });
    }

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache',
      Connection: 'close',
      // Belt and braces for anyone who later fronts this with nginx.
      'X-Accel-Buffering': 'no',
    });

    const write = (frame: Buffer): void => {
      if (raw.destroyed || raw.writableEnded) return;
      // A phone on weak Wi-Fi must not make the hub queue frames forever;
      // skipping is the right failure for live video.
      if (raw.writableLength > MAX_BUFFERED_BYTES) return;
      raw.write(
        `--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`,
      );
      raw.write(frame);
      raw.write('\r\n');
    };

    const unsubscribe = ctx.hub.subscribe(device.id, write);
    const close = (): void => {
      unsubscribe();
      if (!raw.destroyed) raw.end();
    };
    req.raw.on('close', close);
    req.raw.on('error', close);
    raw.on('error', close);
  });

  app.post<{ Params: { id: string } }>('/api/cameras/:id/settings', async (req, reply) => {
    const device = resolveDevice(reply, req.params.id);
    if (!device) return reply;
    try {
      const upstream = await cameraFetch(device, '/api/settings', {
        method: 'POST',
        body: JSON.stringify(req.body ?? {}),
      });
      return await forwardJson(reply, upstream);
    } catch (error) {
      return reply.code(502).send({ error: describeError(error) });
    }
  });

  for (const action of ['capture', 'reboot'] as const) {
    app.post<{ Params: { id: string } }>(`/api/cameras/:id/${action}`, async (req, reply) => {
      const device = resolveDevice(reply, req.params.id);
      if (!device) return reply;
      try {
        const upstream = await cameraFetch(device, `/api/${action}`, {
          method: 'POST',
          timeoutMs: 15000,
        });
        return await forwardJson(reply, upstream);
      } catch (error) {
        return reply.code(502).send({ error: describeError(error) });
      }
    });
  }

  // ---- SD card -------------------------------------------------------------

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    '/api/cameras/:id/sd',
    async (req, reply) => {
      const device = resolveDevice(reply, req.params.id);
      if (!device) return reply;
      const path = req.query.path ?? '/';
      try {
        const upstream = await cameraFetch(
          device,
          `/api/sd/list?path=${encodeURIComponent(path)}`,
          { timeoutMs: 15000 },
        );
        return await forwardJson(reply, upstream);
      } catch (error) {
        return reply.code(502).send({ error: describeError(error) });
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { path?: string; download?: string } }>(
    '/api/cameras/:id/sd/file',
    async (req, reply) => {
      const device = resolveDevice(reply, req.params.id);
      if (!device) return reply;

      const path = req.query.path;
      if (!path) return reply.code(400).send({ error: 'path is required' });

      const browserRange = req.headers.range;
      let upstream: Response;
      try {
        // Always ask the camera for a byte range. Its reply is chunked and so
        // carries no Content-Length, but Content-Range tells us exactly how
        // many bytes are coming -- which lets us hand the browser a real length,
        // and that is what makes video seeking and resumable downloads work.
        upstream = await cameraFetch(device, `/api/sd/file?path=${encodeURIComponent(path)}`, {
          headers: { Range: browserRange ?? 'bytes=0-' },
          timeoutMs: 30000,
        });
      } catch (error) {
        return reply.code(502).send({ error: describeError(error) });
      }

      if (upstream.status !== 200 && upstream.status !== 206) {
        return await forwardJson(reply, upstream);
      }
      if (!upstream.body) return reply.code(502).send({ error: 'camera sent an empty body' });

      const range = parseContentRange(upstream.headers.get('content-range'));
      const fileName = path.slice(path.lastIndexOf('/') + 1) || 'download';
      const headers: Record<string, string> = {
        'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, max-age=86400',
        'Content-Disposition': `${req.query.download ? 'attachment' : 'inline'}; filename="${fileName.replace(/"/g, '')}"`,
      };

      let status = 200;
      if (range) {
        headers['Content-Length'] = String(range.end - range.start + 1);
        if (browserRange) {
          status = 206;
          headers['Content-Range'] = `bytes ${range.start}-${range.end}/${range.total}`;
        }
      }

      reply.hijack();
      reply.raw.writeHead(status, headers);
      try {
        await pipeline(Readable.from(readChunks(upstream.body)), reply.raw);
      } catch (error) {
        req.log.warn({ err: error }, 'sd download interrupted');
        if (!reply.raw.destroyed) reply.raw.destroy();
      }
    },
  );

  app.delete<{ Params: { id: string }; Querystring: { path?: string } }>(
    '/api/cameras/:id/sd/file',
    async (req, reply) => {
      const device = resolveDevice(reply, req.params.id);
      if (!device) return reply;

      const path = req.query.path;
      if (!path) return reply.code(400).send({ error: 'path is required' });

      try {
        const upstream = await cameraFetch(
          device,
          `/api/sd/file?path=${encodeURIComponent(path)}`,
          { method: 'DELETE', timeoutMs: 15000 },
        );
        return await forwardJson(reply, upstream);
      } catch (error) {
        return reply.code(502).send({ error: describeError(error) });
      }
    },
  );
}
