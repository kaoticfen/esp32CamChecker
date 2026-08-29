import type { DeviceRow } from './db.ts';

export class CameraOfflineError extends Error {}

const DEFAULT_TIMEOUT_MS = 10_000;

export function controlBase(device: DeviceRow): string {
  if (!device.last_ip) {
    throw new CameraOfflineError(`camera ${device.id} has never reported an address`);
  }
  return `http://${device.last_ip}:${device.control_port}`;
}

export function streamUrl(device: DeviceRow): string {
  if (!device.last_ip) {
    throw new CameraOfflineError(`camera ${device.id} has never reported an address`);
  }
  return `http://${device.last_ip}:${device.stream_port}/api/stream`;
}

export interface CameraRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export async function cameraFetch(
  device: DeviceRow,
  path: string,
  options: CameraRequestOptions = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${device.token}`,
    ...options.headers,
  };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  return fetch(controlBase(device) + path, {
    method: options.method ?? 'GET',
    headers,
    body: options.body,
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
}

/**
 * Async-iterates a fetch body. Written out longhand rather than relying on
 * `for await` over the web stream, so the element type stays concrete.
 */
export async function* readChunks(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

export interface ContentRange {
  start: number;
  end: number;
  total: number;
}

export function parseContentRange(header: string | null): ContentRange | null {
  if (!header) return null;
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(header.trim());
  if (!match) return null;
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    total: Number(match[3]),
  };
}
