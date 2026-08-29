#!/usr/bin/env node
/**
 * End-to-end check of the hub against a mock ESP32-CAM.
 *
 * Starts a throwaway hub and a mock camera, then walks the whole flow: login,
 * pairing, heartbeat, snapshot, stream fan-out, SD browsing and download.
 * Requires no hardware.
 *
 *   npm run build && node tools/e2e-test.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HUB_PORT = 18080;
const CAM_PORT = 18081;
const CAM_STREAM_PORT = 18082;
const BASE = `http://127.0.0.1:${HUB_PORT}`;
const PASSWORD = 'correct-horse-battery-staple';
const hubDir = fileURLToPath(new URL('..', import.meta.url));

let passed = 0;
let failed = 0;
const children = [];
let dataDir;

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  [32m✓[0m ${name}`);
  } else {
    failed++;
    console.log(`  [31m✗[0m ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

let cookie = '';

async function call(path, init = {}) {
  const response = await fetch(BASE + path, {
    ...init,
    headers: {
      'X-Requested-With': 'esp32camchecker',
      ...(cookie ? { cookie } : {}),
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  for (const raw of response.headers.getSetCookie()) {
    const pair = raw.split(';')[0];
    if (pair.startsWith('camsess=')) cookie = pair;
  }
  return response;
}

function launch(label, args, env) {
  const child = spawn(process.execPath, args, {
    cwd: hubDir,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  child.stderr.on('data', (chunk) => {
    const text = String(chunk).trim();
    if (text) console.log(`    [${label}] ${text.split('\n').slice(-1)[0]}`);
  });
  return child;
}

async function waitFor(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${url}`);
}

/** Reads frames off an MJPEG response until it has seen `wanted` of them. */
async function readFrames(response, wanted, signal) {
  const reader = response.body.getReader();
  let seen = 0;
  let buffered = 0;
  try {
    while (seen < wanted && !signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += value.length;
      seen = Math.floor(buffered / 800); // frames are ~800 bytes with headers
    }
  } catch {
    // aborted
  }
  return buffered;
}

async function main() {
  dataDir = await mkdtemp(join(tmpdir(), 'camhub-e2e-'));

  console.log('\nStarting hub and mock camera');
  launch('hub', ['src/server/main.ts'], {
    DATA_DIR: dataDir,
    HUB_PORT: String(HUB_PORT),
    HUB_HOST: '127.0.0.1',
    ADMIN_USER: 'admin',
    ADMIN_PASSWORD: PASSWORD,
    SESSION_SECRET: 'e2e-session-secret-that-is-long-enough',
    LOG_LEVEL: 'warn',
  });
  await waitFor(`${BASE}/healthz`);

  console.log('\nAuthentication');
  check('unauthenticated camera list is rejected', (await call('/api/cameras')).status === 401);
  check(
    'wrong password is rejected',
    (await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'nope' }) }))
      .status === 401,
  );
  const login = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'admin', password: PASSWORD }),
  });
  check('correct password logs in', login.status === 200, `got ${login.status}`);
  check('session cookie was issued', cookie.startsWith('camsess='));
  check('camera list is now allowed', (await call('/api/cameras')).status === 200);

  console.log('\nCSRF');
  const noCsrf = await fetch(`${BASE}/api/pair/code`, { method: 'POST', headers: { cookie } });
  check('state-changing call without X-Requested-With is refused', noCsrf.status === 403, `got ${noCsrf.status}`);

  console.log('\nPairing');
  const minted = await (await call('/api/pair/code', { method: 'POST' })).json();
  check('pairing code minted', /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(minted.display), minted.display);

  launch('cam', [
    'tools/mock-camera.mjs',
    '--hub', BASE,
    '--code', minted.display,
    '--port', String(CAM_PORT),
    '--stream-port', String(CAM_STREAM_PORT),
    '--name', 'Greenhouse',
    '--heartbeat-seconds', '2',
  ]);
  await waitFor(`http://127.0.0.1:${CAM_PORT}/_test/stats`);
  await sleep(700);

  const replay = await fetch(`${BASE}/api/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: minted.display, deviceId: 'cam-attacker0001' }),
  });
  check('a used pairing code cannot be replayed', replay.status === 403, `got ${replay.status}`);

  const badToken = await fetch(`${BASE}/api/devices/cam-mock00000001/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong' },
    body: JSON.stringify({ ip: '127.0.0.1' }),
  });
  check('heartbeat with a wrong device token is rejected', badToken.status === 401, `got ${badToken.status}`);

  const { cameras } = await (await call('/api/cameras')).json();
  check('camera appears in the list', cameras.length === 1, `got ${cameras.length}`);
  check('camera is online', cameras[0]?.online === true);
  check('camera kept its name', cameras[0]?.name === 'Greenhouse', cameras[0]?.name);
  const id = cameras[0]?.id;

  console.log('\nImaging');
  const snapshot = await call(`/api/cameras/${id}/snapshot`);
  const snapshotBody = Buffer.from(await snapshot.arrayBuffer());
  check('snapshot is a JPEG', snapshot.headers.get('content-type') === 'image/jpeg');
  check('snapshot has JPEG magic bytes', snapshotBody[0] === 0xff && snapshotBody[1] === 0xd8);

  const before = await (await fetch(`http://127.0.0.1:${CAM_PORT}/_test/stats`)).json();

  const abortA = new AbortController();
  const abortB = new AbortController();
  const streamA = await call(`/api/cameras/${id}/stream`, { signal: abortA.signal });
  const streamB = await call(`/api/cameras/${id}/stream`, { signal: abortB.signal });
  check('first viewer gets a multipart stream', (streamA.headers.get('content-type') ?? '').startsWith('multipart/x-mixed-replace'));
  check('second viewer gets a multipart stream too', (streamB.headers.get('content-type') ?? '').startsWith('multipart/x-mixed-replace'));

  const [bytesA, bytesB] = await Promise.all([
    readFrames(streamA, 4, abortA.signal),
    readFrames(streamB, 4, abortB.signal),
  ]);
  abortA.abort();
  abortB.abort();
  check('viewer A received frames', bytesA > 1000, `${bytesA} bytes`);
  check('viewer B received frames', bytesB > 1000, `${bytesB} bytes`);

  const after = await (await fetch(`http://127.0.0.1:${CAM_PORT}/_test/stats`)).json();
  const opened = after.streamConnections - before.streamConnections;
  check('two viewers used ONE upstream connection', opened === 1, `camera saw ${opened}`);
  check('camera never had to reject a second stream', after.streamRejections === before.streamRejections);

  await sleep(4000);
  const idle = await (await fetch(`http://127.0.0.1:${CAM_PORT}/_test/stats`)).json();
  check('upstream closes once every viewer leaves', idle.streamConnections === after.streamConnections);

  console.log('\nSD card');
  const listing = await (await call(`/api/cameras/${id}/sd?path=/DCIM/20260829`)).json();
  check('folder listing returns entries', listing.entries.length >= 2, `${listing.entries.length}`);

  const file = '/DCIM/20260829/120000-001.jpg';
  const download = await call(`/api/cameras/${id}/sd/file?path=${encodeURIComponent(file)}`);
  const downloaded = Buffer.from(await download.arrayBuffer());
  const declared = Number(download.headers.get('content-length'));
  check('download reports a Content-Length', Number.isFinite(declared) && declared > 0, String(declared));
  check('Content-Length matches the body', declared === downloaded.length, `${declared} vs ${downloaded.length}`);
  check('download advertises range support', download.headers.get('accept-ranges') === 'bytes');

  const ranged = await call(`/api/cameras/${id}/sd/file?path=${encodeURIComponent(file)}`, {
    headers: { Range: 'bytes=10-109' },
  });
  const rangedBody = Buffer.from(await ranged.arrayBuffer());
  check('range request returns 206', ranged.status === 206, `got ${ranged.status}`);
  check('range returns exactly the requested bytes', rangedBody.length === 100, `${rangedBody.length}`);
  check(
    'Content-Range is correct',
    ranged.headers.get('content-range') === `bytes 10-109/${downloaded.length}`,
    ranged.headers.get('content-range') ?? 'missing',
  );
  check('ranged bytes match the full download', rangedBody.equals(downloaded.subarray(10, 110)));

  const traversal = await call(`/api/cameras/${id}/sd?path=${encodeURIComponent('/../../etc')}`);
  check('path traversal is refused', traversal.status === 400, `got ${traversal.status}`);

  console.log('\nCapture and removal');
  const captured = await (await call(`/api/cameras/${id}/capture`, { method: 'POST' })).json();
  check('capture returns a path on the card', typeof captured.path === 'string' && captured.path.startsWith('/DCIM/'), captured.path);
  const afterCapture = await (await call(`/api/cameras/${id}/sd?path=/DCIM/20260829`)).json();
  check('captured file shows up in the listing', afterCapture.entries.length > listing.entries.length);

  check('camera can be removed', (await call(`/api/cameras/${id}`, { method: 'DELETE' })).status === 200);
  const emptied = await (await call('/api/cameras')).json();
  check('camera list is empty again', emptied.cameras.length === 0);

  check('logout succeeds', (await call('/api/auth/logout', { method: 'POST' })).status === 200);
  check('session is dead after logout', (await call('/api/cameras')).status === 401);
}

try {
  await main();
} catch (error) {
  failed++;
  console.error(`\n[31mfatal:[0m ${error.stack ?? error.message}`);
} finally {
  for (const child of children) child.kill('SIGKILL');
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}
