import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { finished } from 'node:stream/promises';

/**
 * File storage on a local folder. It stands in for blob storage (staging) and for the
 * customer's destination (object storage / SFTP).
 *
 * Every write goes to a temp file first and is then renamed. A rename on the same disk
 * is atomic, so readers never see half-written files, and a retry simply replaces the file.
 */
export class LocalStorage {
  constructor(private readonly root: string) {}

  private stagingDir(jobId: string): string {
    return path.join(this.root, 'staging', jobId);
  }

  private chunkPath(jobId: string, seq: number): string {
    return path.join(this.stagingDir(jobId), `chunk_${String(seq).padStart(6, '0')}.csv`);
  }

  /** Writes one staged chunk (CSV lines without header). Same job + seq => same file. */
  async writeChunk(jobId: string, seq: number, lines: AsyncIterable<string>): Promise<void> {
    const target = this.chunkPath(jobId, seq);
    await mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.tmp-${randomUUID()}`;
    await writeAll(temp, lines);
    await rename(temp, target);
  }

  /**
   * Builds the final file from a header plus all chunks in order, then publishes it
   * with one atomic rename. Returns where it went and a checksum.
   */
  async publish(input: {
    jobId: string;
    folder: string;
    fileName: string;
    header: string;
    chunkCount: number;
  }): Promise<{ location: string; sha256: string; bytes: number }> {
    const target = path.join(this.root, 'exports', input.folder, input.fileName);
    await mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.tmp-${randomUUID()}`;
    const hash = createHash('sha256');

    const chunkPaths = Array.from({ length: input.chunkCount }, (_, seq) => this.chunkPath(input.jobId, seq));
    async function* content(): AsyncGenerator<string | Buffer> {
      yield input.header;
      for (const chunk of chunkPaths) {
        for await (const piece of createReadStream(chunk)) yield piece as Buffer;
      }
    }

    await writeAll(temp, content(), (piece) => hash.update(piece));
    await rename(temp, target);
    const { size } = await stat(target);
    return { location: path.relative(this.root, target), sha256: hash.digest('hex'), bytes: size };
  }

  /** Removes staged chunks after the final file is published. Safe to call twice. */
  async removeStaging(jobId: string): Promise<void> {
    await rm(this.stagingDir(jobId), { recursive: true, force: true });
  }

  /** Absolute path of a published file, for downloads. */
  resolve(location: string): string {
    const full = path.resolve(this.root, location);
    if (!full.startsWith(path.resolve(this.root) + path.sep)) throw new Error('Invalid location');
    return full;
  }
}

/** Streams pieces into a file and flushes it to disk before returning. */
async function writeAll(
  file: string,
  pieces: AsyncIterable<string | Buffer>,
  onPiece?: (piece: string | Buffer) => void,
): Promise<void> {
  const out = createWriteStream(file);
  try {
    for await (const piece of pieces) {
      onPiece?.(piece);
      if (!out.write(piece)) await new Promise<void>((resolve) => out.once('drain', () => resolve()));
    }
    out.end();
    await finished(out);
  } catch (err) {
    out.destroy();
    await rm(file, { force: true });
    throw err;
  }
  const handle = await open(file, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
