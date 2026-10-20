import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdir, open, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { Env } from '../../../../config/env.js';

const LOCAL_PREFIX = 'local:';

/**
 * Where uploaded Excel files live.
 * - Vercel: the browser uploads to Vercel Blob; the API receives an https URL on the Blob host.
 * - Docker/PM2: multipart upload to UPLOAD_DIR; referenced as "local:<file name>".
 */
@Injectable()
export class FileStore {
  private readonly uploadDir: string;
  private readonly blobSuffix: string;
  private readonly blobToken?: string;

  constructor(config: ConfigService<Env, true>) {
    this.uploadDir = path.resolve(config.get('UPLOAD_DIR', { infer: true }));
    this.blobSuffix = config.get('BLOB_HOST_SUFFIX', { infer: true });
    this.blobToken = config.get('BLOB_READ_WRITE_TOKEN', { infer: true });
  }

  get localDir() {
    return this.uploadDir;
  }

  async ensureLocalDir() {
    await mkdir(this.uploadDir, { recursive: true });
  }

  localRef(fileName: string) {
    return `${LOCAL_PREFIX}${path.basename(fileName)}`;
  }

  /** Reject anything that is not our Blob host or our own upload dir (prevents SSRF / path traversal). */
  assertTrusted(fileUrl: string) {
    if (fileUrl.startsWith(LOCAL_PREFIX)) {
      const name = fileUrl.slice(LOCAL_PREFIX.length);
      if (!name || name !== path.basename(name))
        throw new BadRequestException('fileUrl tidak valid');
      return;
    }
    let url: URL;
    try {
      url = new URL(fileUrl);
    } catch {
      throw new BadRequestException('fileUrl tidak valid');
    }
    if (url.protocol !== 'https:' || !url.hostname.endsWith(this.blobSuffix)) {
      throw new BadRequestException(
        'fileUrl harus berasal dari storage Blob proyek ini',
      );
    }
  }

  async open(fileUrl: string): Promise<Readable> {
    this.assertTrusted(fileUrl);
    if (fileUrl.startsWith(LOCAL_PREFIX)) {
      // Open first so a missing file fails this call (and the batch) instead of
      // emitting an unhandled stream 'error' that would crash the process.
      const file = await open(
        path.join(this.uploadDir, fileUrl.slice(LOCAL_PREFIX.length)),
      ).catch(() => {
        throw new Error('File upload tidak ditemukan di server. Unggah ulang file.');
      });
      return file.createReadStream();
    }
    const res = await fetch(fileUrl, {
      headers: this.blobToken
        ? { authorization: `Bearer ${this.blobToken}` }
        : undefined,
    });
    if (!res.ok || !res.body)
      throw new Error(`Gagal membaca file (HTTP ${res.status})`);
    return Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  }

  /** Called once a batch is finished. Blob files are left for the Blob store's own cleanup. */
  async discard(fileUrl: string) {
    if (fileUrl.startsWith(LOCAL_PREFIX)) {
      await rm(
        path.join(
          this.uploadDir,
          path.basename(fileUrl.slice(LOCAL_PREFIX.length)),
        ),
        { force: true },
      );
    }
  }
}
