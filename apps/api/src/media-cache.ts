import type { MediaDownloader } from '@lexora/worker';

import type { DownloadedMedia } from './whatsapp/types.js';

const MAX_ENTRIES = 50;

/**
 * Kapso download URLs expire quickly, so the webhook downloads the file at once and the worker reads it
 * from here by reference (`kapso:<message id>:<index>`). Memory only: nothing is written to disk.
 */
export class MediaCache implements MediaDownloader {
  private readonly files = new Map<string, DownloadedMedia>();

  put(key: string, media: DownloadedMedia): void {
    this.files.set(key, media);
    while (this.files.size > MAX_ENTRIES) {
      const oldest = this.files.keys().next().value;
      if (oldest === undefined) break;
      this.files.delete(oldest);
    }
  }

  async download(ref: string): Promise<{ bytes: Uint8Array; contentType: string | null }> {
    const media = this.files.get(ref);
    if (!media) throw new Error('media no longer in memory');
    return { bytes: media.bytes, contentType: media.mimeType };
  }
}
