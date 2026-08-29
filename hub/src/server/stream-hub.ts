import { MjpegParser } from './mjpeg.ts';
import { readChunks } from './proxy.ts';

export interface StreamTarget {
  url: string;
  token: string;
}

export type FrameListener = (frame: Buffer) => void;

export interface StreamLogger {
  info(msg: string): void;
  warn(msg: string): void;
  debug(msg: string): void;
}

/** Keeps the camera connection up briefly across a grid -> detail -> grid trip. */
const LINGER_MS = 3000;
const MIN_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 15000;
/** How stale a live frame may be before /snapshot goes back to the camera. */
export const SNAPSHOT_MAX_AGE_MS = 2000;

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/**
 * One upstream MJPEG connection per camera, fanned out to every viewer.
 *
 * An ESP32-CAM serves a single stream client before its frame rate collapses,
 * so the hub is that client and every browser subscribes to the hub instead.
 */
class CameraStream {
  #id: string;
  #resolve: () => StreamTarget | null;
  #log: StreamLogger;
  #listeners = new Set<FrameListener>();
  #controller: AbortController | null = null;
  #lingerTimer: ReturnType<typeof setTimeout> | null = null;
  #running = false;
  #snapshotInflight: Promise<Buffer> | null = null;

  latestFrame: Buffer | null = null;
  latestAt = 0;

  constructor(id: string, resolve: () => StreamTarget | null, log: StreamLogger) {
    this.#id = id;
    this.#resolve = resolve;
    this.#log = log;
  }

  get viewerCount(): number {
    return this.#listeners.size;
  }

  subscribe(listener: FrameListener): () => void {
    this.#listeners.add(listener);
    if (this.#lingerTimer) {
      clearTimeout(this.#lingerTimer);
      this.#lingerTimer = null;
    }
    this.#ensureUpstream();

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) this.#scheduleStop();
    };
  }

  /**
   * A still image. Prefers the live stream's most recent frame, then falls back
   * to a one-shot fetch -- and collapses concurrent callers onto one fetch so a
   * grid of tiles refreshing together still only wakes the camera once.
   */
  async snapshot(fetchOnce: () => Promise<Buffer>): Promise<Buffer> {
    if (this.latestFrame && Date.now() - this.latestAt < SNAPSHOT_MAX_AGE_MS) {
      return this.latestFrame;
    }
    if (this.#snapshotInflight) return this.#snapshotInflight;

    const pending = fetchOnce()
      .then((frame) => {
        this.latestFrame = frame;
        this.latestAt = Date.now();
        return frame;
      })
      .finally(() => {
        this.#snapshotInflight = null;
      });

    this.#snapshotInflight = pending;
    return pending;
  }

  stop(): void {
    this.#running = false;
    this.#controller?.abort();
    this.#controller = null;
    if (this.#lingerTimer) {
      clearTimeout(this.#lingerTimer);
      this.#lingerTimer = null;
    }
  }

  #scheduleStop(): void {
    if (this.#lingerTimer) clearTimeout(this.#lingerTimer);
    this.#lingerTimer = setTimeout(() => {
      this.#lingerTimer = null;
      if (this.#listeners.size === 0) {
        this.#log.debug(`[stream ${this.#id}] last viewer left, closing upstream`);
        this.stop();
      }
    }, LINGER_MS);
  }

  #ensureUpstream(): void {
    if (this.#running) return;
    this.#running = true;
    void this.#pump();
  }

  #emit(frame: Buffer): void {
    this.latestFrame = frame;
    this.latestAt = Date.now();
    for (const listener of this.#listeners) {
      try {
        listener(frame);
      } catch {
        // A broken viewer must not take down the shared upstream connection.
      }
    }
  }

  async #pump(): Promise<void> {
    let failures = 0;

    while (this.#running && this.#listeners.size > 0) {
      const target = this.#resolve();
      if (!target) {
        this.#log.debug(`[stream ${this.#id}] camera offline, waiting`);
        await sleep(2000);
        continue;
      }

      const controller = new AbortController();
      this.#controller = controller;

      try {
        const response = await fetch(target.url, {
          headers: { Authorization: `Bearer ${target.token}` },
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          throw new Error(`camera returned HTTP ${response.status}`);
        }

        this.#log.info(`[stream ${this.#id}] upstream open (${this.#listeners.size} viewers)`);
        failures = 0;

        const parser = new MjpegParser((frame) => this.#emit(frame));
        for await (const chunk of readChunks(response.body)) {
          parser.push(Buffer.from(chunk));
        }
      } catch (error) {
        if (controller.signal.aborted) break;
        failures++;
        const message = error instanceof Error ? error.message : String(error);
        this.#log.warn(`[stream ${this.#id}] upstream failed: ${message}`);
      } finally {
        if (this.#controller === controller) this.#controller = null;
      }

      if (!this.#running || this.#listeners.size === 0) break;

      const backoff = Math.min(MIN_BACKOFF_MS * 2 ** Math.max(0, failures - 1), MAX_BACKOFF_MS);
      await sleep(backoff);
    }

    this.#running = false;
  }
}

export class StreamHub {
  #streams = new Map<string, CameraStream>();
  #resolve: (id: string) => StreamTarget | null;
  #log: StreamLogger;

  constructor(resolve: (id: string) => StreamTarget | null, log: StreamLogger) {
    this.#resolve = resolve;
    this.#log = log;
  }

  #stream(id: string): CameraStream {
    let stream = this.#streams.get(id);
    if (!stream) {
      stream = new CameraStream(id, () => this.#resolve(id), this.#log);
      this.#streams.set(id, stream);
    }
    return stream;
  }

  subscribe(id: string, listener: FrameListener): () => void {
    return this.#stream(id).subscribe(listener);
  }

  snapshot(id: string, fetchOnce: () => Promise<Buffer>): Promise<Buffer> {
    return this.#stream(id).snapshot(fetchOnce);
  }

  viewerCount(id: string): number {
    return this.#streams.get(id)?.viewerCount ?? 0;
  }

  /** Called when a camera is removed or its token is rotated. */
  drop(id: string): void {
    this.#streams.get(id)?.stop();
    this.#streams.delete(id);
  }

  stopAll(): void {
    for (const stream of this.#streams.values()) stream.stop();
    this.#streams.clear();
  }
}
