import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AppContext } from '../context.js';
import { notFound } from '../lib/errors.js';
import type { ChannelRow } from '../types.js';
import type { WhatsAppProvider } from '../whatsapp/types.js';

export interface MediaFile {
  id: string;
  workspace_id: string;
  path: string;
  mime: string;
  size: number;
  filename: string | null;
  wa_media_ids: Record<string, string>;
  created_at: Date;
}

const EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'video/3gpp': '.3gp',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'audio/amr': '.amr',
  'application/pdf': '.pdf',
};

export function extFor(mime: string, filename?: string | null): string {
  const base = mime.split(';')[0].trim();
  if (EXT[base]) return EXT[base];
  const fromName = filename ? path.extname(filename) : '';
  return /^\.[a-z0-9]{1,8}$/i.test(fromName) ? fromName.toLowerCase() : '.bin';
}

/** WhatsApp message type to use for a file. */
export function waTypeForMime(mime: string): 'image' | 'video' | 'audio' | 'document' | 'sticker' {
  const m = mime.split(';')[0].trim();
  if (m === 'image/jpeg' || m === 'image/png') return 'image';
  if (m === 'image/webp') return 'sticker';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  return 'document';
}

export async function saveMedia(
  ctx: AppContext,
  workspaceId: string,
  data: Buffer,
  mime: string,
  filename: string | null,
  waMediaIds: Record<string, string> = {},
): Promise<MediaFile> {
  const rel = path.join('media', workspaceId, `${crypto.randomUUID()}${extFor(mime, filename)}`);
  const abs = path.join(ctx.config.dataDir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, data);
  const { rows } = await ctx.db.query<MediaFile>(
    `INSERT INTO media_files (workspace_id, path, mime, size, filename, wa_media_ids)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [workspaceId, rel, mime.split(';')[0].trim(), data.length, filename, JSON.stringify(waMediaIds)],
  );
  return rows[0];
}

export async function getMedia(ctx: AppContext, workspaceId: string, id: string): Promise<MediaFile> {
  const { rows } = await ctx.db.query<MediaFile>(`SELECT * FROM media_files WHERE id = $1 AND workspace_id = $2`, [id, workspaceId]);
  if (!rows[0]) throw notFound('Archivo');
  return rows[0];
}

export function mediaAbsPath(ctx: AppContext, file: MediaFile): string {
  return path.join(ctx.config.dataDir, file.path);
}

const MEDIA_ID_TTL_MS = 25 * 24 * 3600 * 1000; // Meta keeps uploaded media for 30 days

/** Returns the WhatsApp media id for this channel, uploading the file when missing or stale. */
export async function ensureUploaded(ctx: AppContext, file: MediaFile, channel: ChannelRow, provider: WhatsAppProvider): Promise<string> {
  const cached = file.wa_media_ids?.[channel.id];
  if (cached) {
    const [id, at] = cached.split('@');
    if (id && Date.now() - Number(at || 0) < MEDIA_ID_TTL_MS) return id;
  }
  const data = await fs.readFile(mediaAbsPath(ctx, file));
  const id = await provider.uploadMedia(data, file.mime, file.filename ?? `archivo${extFor(file.mime)}`);
  await ctx.db.query(`UPDATE media_files SET wa_media_ids = wa_media_ids || $2::jsonb WHERE id = $1`, [
    file.id,
    JSON.stringify({ [channel.id]: `${id}@${Date.now()}` }),
  ]);
  return id;
}
