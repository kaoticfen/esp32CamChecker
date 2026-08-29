const MAX_HEADER_BYTES = 4096;
const MAX_FRAME_BYTES = 4 * 1024 * 1024;

/**
 * Pulls JPEG frames out of a `multipart/x-mixed-replace` body.
 *
 * Frames are located by each part's Content-Length rather than by scanning for
 * JPEG start/end markers, because those markers also occur inside EXIF
 * thumbnails and would split a frame in the wrong place.
 */
export class MjpegParser {
  #buffer: Buffer = Buffer.alloc(0);
  #expect = -1;
  #onFrame: (frame: Buffer) => void;

  constructor(onFrame: (frame: Buffer) => void) {
    this.#onFrame = onFrame;
  }

  push(chunk: Buffer): void {
    this.#buffer =
      this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);

    for (;;) {
      if (this.#expect < 0) {
        const headerEnd = this.#buffer.indexOf('\r\n\r\n');
        if (headerEnd < 0) {
          // A part header this long means we have lost sync with the stream;
          // drop what we have rather than growing without bound.
          if (this.#buffer.length > MAX_HEADER_BYTES) this.#buffer = Buffer.alloc(0);
          return;
        }

        const header = this.#buffer.subarray(0, headerEnd).toString('latin1');
        this.#buffer = this.#buffer.subarray(headerEnd + 4);

        const match = /content-length:\s*(\d+)/i.exec(header);
        if (!match) continue; // preamble or a part we cannot size -- skip it

        const length = Number(match[1]);
        if (!Number.isFinite(length) || length <= 0 || length > MAX_FRAME_BYTES) {
          this.#buffer = Buffer.alloc(0);
          return;
        }
        this.#expect = length;
      }

      if (this.#buffer.length < this.#expect) return;

      // Copy: the frame outlives this call as the cached "latest" frame, and
      // subarray would pin the whole accumulated chunk behind it.
      this.#onFrame(Buffer.from(this.#buffer.subarray(0, this.#expect)));
      this.#buffer = this.#buffer.subarray(this.#expect);
      this.#expect = -1;
    }
  }
}
