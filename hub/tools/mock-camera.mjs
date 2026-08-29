#!/usr/bin/env node
/**
 * A stand-in ESP32-CAM.
 *
 * Speaks exactly the API in firmware/src/http_api.cpp and stream_server.cpp,
 * including the quirks that matter to the hub: the control and stream servers
 * are on separate ports, SD downloads reply chunked with no Content-Length, and
 * only one MJPEG client is accepted at a time.
 *
 * Usage:
 *   node tools/mock-camera.mjs --hub http://127.0.0.1:8080 --code ABCD-EFGH
 *   node tools/mock-camera.mjs --token <token>     # skip pairing
 */
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    hub: { type: 'string' },
    code: { type: 'string' },
    token: { type: 'string' },
    name: { type: 'string', default: 'Mock Camera' },
    id: { type: 'string', default: 'cam-mock00000001' },
    port: { type: 'string', default: '8081' },
    'stream-port': { type: 'string', default: '8082' },
    'heartbeat-seconds': { type: 'string', default: '30' },
  },
});

const CONTROL_PORT = Number(values.port);
const STREAM_PORT = Number(values['stream-port']);
const DEVICE_ID = values.id;

let token = values.token ?? null;
let streaming = false;

/** Counters the e2e test reads back to assert on hub behaviour. */
const stats = { streamConnections: 0, streamRejections: 0, snapshots: 0, sdReads: 0 };

const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
    'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
    'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
);

const settings = {
  framesize: 8,
  quality: 10,
  brightness: 1,
  contrast: 0,
  saturation: -1,
  hmirror: 0,
  vflip: 1,
  flash: 0,
};

// A tiny virtual SD card: one folder of "photos" plus a file at the root.
const SD = new Map([
  ['/DCIM', { dir: true, mtime: 1756400000 }],
  ['/DCIM/20260829', { dir: true, mtime: 1756400000 }],
  ['/DCIM/20260829/120000-001.jpg', { dir: false, mtime: 1756425600, body: Buffer.concat(Array(40).fill(JPEG)) }],
  ['/DCIM/20260829/120500-114.jpg', { dir: false, mtime: 1756425900, body: Buffer.concat(Array(25).fill(JPEG)) }],
  ['/README.txt', { dir: false, mtime: 1756400000, body: Buffer.from('mock sd card\n') }],
]);

function authorised(req) {
  if (!token) return false;
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') && header.slice(7) === token;
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': payload.length });
  res.end(payload);
}

function deny(res) {
  json(res, 401, { error: 'invalid or missing device token' });
}

/** Mirrors sdcard::safePath in the firmware. */
function safePath(input) {
  let path = input || '/';
  if (!path.startsWith('/') || path.length > 255 || path.includes('..')) return null;
  if (/[\0\r\n]/.test(path)) return null;
  while (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return path;
}

function listDirectory(path) {
  const prefix = path === '/' ? '/' : `${path}/`;
  const entries = [];
  for (const [entryPath, meta] of SD) {
    if (!entryPath.startsWith(prefix) || entryPath === path) continue;
    if (entryPath.slice(prefix.length).includes('/')) continue;
    entries.push({
      name: entryPath.slice(entryPath.lastIndexOf('/') + 1),
      path: entryPath,
      dir: meta.dir,
      size: meta.dir ? 0 : meta.body.length,
      mtime: meta.mtime,
    });
  }
  return entries;
}

const control = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  if (path === '/_test/stats') return json(res, 200, stats); // test hook, not in firmware
  if (!authorised(req)) return deny(res);

  if (path === '/api/info' && req.method === 'GET') {
    return json(res, 200, {
      deviceId: DEVICE_ID,
      name: values.name,
      fwVersion: '0.1.0-mock',
      uptimeMs: Math.round(process.uptime() * 1000),
      ip: '127.0.0.1',
      rssi: -54,
      psram: true,
      heapFree: 190000,
      sd: { mounted: true, totalKb: 31_000_000, usedKb: 412_000 },
      settings,
    });
  }

  if (path === '/api/snapshot' && req.method === 'GET') {
    stats.snapshots++;
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': JPEG.length });
    return res.end(JPEG);
  }

  if (path === '/api/settings' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    return req.on('end', () => {
      let applied = 0;
      try {
        for (const [key, value] of Object.entries(JSON.parse(body || '{}'))) {
          if (key in settings) {
            settings[key] = Number(value);
            applied++;
          }
        }
      } catch {
        return json(res, 400, { error: 'body must be a JSON object' });
      }
      json(res, 200, { applied, rejected: '', settings });
    });
  }

  if (path === '/api/capture' && req.method === 'POST') {
    const name = `/DCIM/20260829/${Date.now().toString().slice(-6)}-000.jpg`;
    SD.set(name, { dir: false, mtime: Math.floor(Date.now() / 1000), body: JPEG });
    return json(res, 200, { path: name });
  }

  if (path === '/api/reboot' && req.method === 'POST') return json(res, 200, { rebooting: true });

  if (path === '/api/sd/list' && req.method === 'GET') {
    const target = safePath(url.searchParams.get('path') ?? '/');
    if (!target) return json(res, 400, { error: 'invalid path' });
    if (target !== '/' && !SD.get(target)?.dir) return json(res, 404, { error: 'not a directory' });
    return json(res, 200, { path: target, entries: listDirectory(target), truncated: false });
  }

  if (path === '/api/sd/file') {
    const target = safePath(url.searchParams.get('path') ?? '');
    if (!target) return json(res, 400, { error: 'invalid path' });
    const entry = SD.get(target);

    if (req.method === 'DELETE') {
      if (!entry) return json(res, 404, { error: 'no such file' });
      SD.delete(target);
      return json(res, 200, { deleted: true });
    }

    if (!entry) return json(res, 404, { error: 'no such file' });
    if (entry.dir) return json(res, 400, { error: 'path is a directory' });
    stats.sdReads++;

    const total = entry.body.length;
    let start = 0;
    let end = total - 1;
    let partial = false;

    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    if (range) {
      start = Number(range[1]);
      end = range[2] ? Number(range[2]) : total - 1;
      partial = true;
      if (start >= total) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}`, 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'range outside file' }));
      }
      if (end >= total) end = total - 1;
    }

    const headers = {
      'Content-Type': target.endsWith('.jpg') ? 'image/jpeg' : 'text/plain',
      'Accept-Ranges': 'bytes',
    };
    if (partial) headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
    // No Content-Length: esp_http_server always chunks a streamed body, and the
    // hub is specifically built to reconstruct the length from Content-Range.
    res.writeHead(partial ? 206 : 200, headers);
    return res.end(entry.body.subarray(start, end + 1));
  }

  return json(res, 404, { error: 'not found' });
});

const stream = createServer((req, res) => {
  if (!authorised(req)) return deny(res);
  if (new URL(req.url, 'http://localhost').pathname !== '/api/stream') {
    return json(res, 404, { error: 'not found' });
  }

  // The real board can only feed one client before its frame rate collapses.
  if (streaming) {
    stats.streamRejections++;
    return json(res, 503, { error: 'stream already in use' });
  }

  streaming = true;
  stats.streamConnections++;
  console.log(`[mock] stream opened (total ${stats.streamConnections})`);

  res.writeHead(200, {
    'Content-Type': 'multipart/x-mixed-replace;boundary=esp32camframe',
    'Cache-Control': 'no-store',
  });

  const timer = setInterval(() => {
    res.write(`\r\n--esp32camframe\r\nContent-Type: image/jpeg\r\nContent-Length: ${JPEG.length}\r\n\r\n`);
    res.write(JPEG);
  }, 100);

  const close = () => {
    clearInterval(timer);
    streaming = false;
    console.log('[mock] stream closed');
  };
  req.on('close', close);
  res.on('error', close);
});

async function pair() {
  const response = await fetch(`${values.hub}/api/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code: values.code,
      deviceId: DEVICE_ID,
      name: values.name,
      fwVersion: '0.1.0-mock',
      ip: '127.0.0.1',
      controlPort: CONTROL_PORT,
      streamPort: STREAM_PORT,
    }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`pairing failed: ${response.status} ${JSON.stringify(body)}`);
  token = body.token;
  console.log('[mock] paired, token acquired');
}

async function heartbeat() {
  if (!token || !values.hub) return;
  try {
    const response = await fetch(`${values.hub}/api/devices/${DEVICE_ID}/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        ip: '127.0.0.1',
        rssi: -54,
        uptimeMs: Math.round(process.uptime() * 1000),
        fwVersion: '0.1.0-mock',
        name: values.name,
        controlPort: CONTROL_PORT,
        streamPort: STREAM_PORT,
        heapFree: 190000,
        sdMounted: true,
        sdTotalKb: 31_000_000,
        sdUsedKb: 412_000,
      }),
    });
    if (response.status === 401) console.warn('[mock] hub rejected our token');
  } catch (error) {
    console.warn(`[mock] heartbeat failed: ${error.message}`);
  }
}

control.listen(CONTROL_PORT, '127.0.0.1');
stream.listen(STREAM_PORT, '127.0.0.1');
console.log(`[mock] ${DEVICE_ID} control :${CONTROL_PORT} stream :${STREAM_PORT}`);

if (values.code && values.hub) await pair();
if (values.hub) {
  await heartbeat();
  setInterval(() => void heartbeat(), Number(values['heartbeat-seconds']) * 1000).unref();
}
