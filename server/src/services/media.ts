import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AppContext } from '../context.js';
import { badRequest, notFound } from '../lib/errors.js';
import type { ChannelRow } from '../types.js';
import { explainMetaError, MetaApiError, type WhatsAppProvider } from '../whatsapp/types.js';

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

const KB = 1024;
const MB = 1024 * KB;
const DOC = 100 * MB;

/** The only types (and sizes) the Cloud API /media endpoint accepts; anything else fails at send time. */
export const WA_MEDIA_LIMITS: Record<string, number> = {
  'image/jpeg': 5 * MB,
  'image/png': 5 * MB,
  'image/webp': 500 * KB, // stickers: 100 KB static, 500 KB animated (checked with the file header)
  'video/mp4': 16 * MB,
  'video/3gpp': 16 * MB,
  'audio/aac': 16 * MB,
  'audio/amr': 16 * MB,
  'audio/mpeg': 16 * MB,
  'audio/mp4': 16 * MB,
  'audio/ogg': 16 * MB,
  'text/plain': DOC,
  'application/pdf': DOC,
  'application/msword': DOC,
  'application/vnd.ms-excel': DOC,
  'application/vnd.ms-powerpoint': DOC,
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': DOC,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': DOC,
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': DOC,
};

const STICKER_STATIC_MAX = 100 * KB;
/** WhatsApp stickers are exactly 512×512; any other WebP (a photo saved from a website) is not one. */
const STICKER_PX = 512;

/** Width, height and animation flag of a WebP file, or null when the header is not a valid WebP. */
export function webpInfo(data: Buffer): { width: number; height: number; animated: boolean } | null {
  if (data.length < 30 || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WEBP') return null;
  const chunk = data.toString('ascii', 12, 16);
  if (chunk === 'VP8X') {
    return { animated: (data[20] & 0x02) !== 0, width: data.readUIntLE(24, 3) + 1, height: data.readUIntLE(27, 3) + 1 };
  }
  if (chunk === 'VP8 ' && data[23] === 0x9d && data[24] === 0x01 && data[25] === 0x2a) {
    return { animated: false, width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L' && data[20] === 0x2f) {
    const bits = data.readUInt32LE(21);
    return { animated: false, width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return null;
}

const KIND_LABEL: Record<string, string> = {
  image: 'Las imágenes',
  video: 'Los videos',
  audio: 'Los audios',
  document: 'Los documentos',
};

function fmtSize(bytes: number): string {
  return bytes >= MB ? `${(bytes / MB).toFixed(1)} MB` : `${Math.ceil(bytes / KB)} KB`;
}

/**
 * Throws a clear error when WhatsApp would refuse this file. `data` (the file or at least its first
 * 30 bytes) lets stickers be checked; `strict` also refuses a WebP whose header cannot be read
 * (uploads), while at send time such a file is left for Meta to judge.
 */
export function assertWhatsAppMedia(mime: string, size: number, data?: Buffer, strict = false): void {
  const m = mime.split(';')[0].trim();
  const limit = WA_MEDIA_LIMITS[m];
  if (!limit) {
    throw badRequest(
      `WhatsApp no acepta archivos de tipo ${m}. Envía imágenes JPG o PNG, videos MP4 o 3GP, audios AAC, AMR, MP3, M4A u OGG, stickers WebP o documentos PDF, Word, Excel, PowerPoint o TXT.`,
      'MEDIA_TYPE_NOT_SUPPORTED',
    );
  }
  if (m === 'image/webp') {
    const info = data ? webpInfo(data) : null;
    const stickerError = () =>
      badRequest(
        'WhatsApp solo envía imágenes WebP como sticker: exactamente 512×512 px y máximo 100 KB (500 KB si es animado). Convierte la imagen a JPG o PNG para enviarla como foto.',
        'STICKER_NOT_VALID',
      );
    if (!info) {
      if (strict || size > limit) throw stickerError();
      return;
    }
    if (info.width !== STICKER_PX || info.height !== STICKER_PX || size > (info.animated ? limit : STICKER_STATIC_MAX)) throw stickerError();
    return;
  }
  if (size > limit) {
    const kind = waTypeForMime(m);
    throw badRequest(
      `${KIND_LABEL[kind]} pueden pesar máximo ${fmtSize(limit)} en WhatsApp y este archivo pesa ${fmtSize(size)}. Redúcelo o comprímelo antes de enviarlo.`,
      'MEDIA_TOO_LARGE',
    );
  }
}

/** assertWhatsAppMedia for a stored file (reads the header of WebP files from disk). */
export async function assertSendableMedia(ctx: AppContext, file: MediaFile): Promise<void> {
  let head: Buffer | undefined;
  if (file.mime === 'image/webp') {
    const fh = await fs.open(mediaAbsPath(ctx, file), 'r').catch(() => null);
    if (fh) {
      try {
        const buf = Buffer.alloc(32);
        const { bytesRead } = await fh.read(buf, 0, 32, 0);
        head = buf.subarray(0, bytesRead);
      } finally {
        await fh.close();
      }
    }
  }
  assertWhatsAppMedia(file.mime, Number(file.size), head);
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

/**
 * A fresh path for a file being downloaded, on the same disk as the media store so saving it is
 * a rename. The caller writes it and passes it to saveMediaFile (or deletes it on failure).
 */
export async function mediaTempPath(ctx: AppContext): Promise<string> {
  const dir = path.join(ctx.config.dataDir, 'media', '.tmp');
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, `${crypto.randomUUID()}.part`);
}

/**
 * Deletes partial downloads older than `maxAgeMs` from the temp folder. A download that fails
 * removes its own file; one cut off by a crash leaves it behind. A live download writes its file
 * all the time (and a job times out after 10 minutes), so an hour without a write means nobody owns it.
 */
export async function removeStaleMediaTemp(ctx: AppContext, maxAgeMs = 3600_000): Promise<number> {
  const dir = path.join(ctx.config.dataDir, 'media', '.tmp');
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err: any) {
    if (err?.code === 'ENOENT') return 0;
    throw err;
  }
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith('.part')) continue;
    const file = path.join(dir, name);
    const st = await fs.stat(file).catch(() => null);
    if (!st?.isFile() || Date.now() - st.mtimeMs < maxAgeMs) continue;
    await fs.rm(file, { force: true });
    removed++;
  }
  return removed;
}

/** saveMedia for a file already on disk (see mediaTempPath): it is moved into the store, never read into memory. */
export async function saveMediaFile(
  ctx: AppContext,
  workspaceId: string,
  tempPath: string,
  mime: string,
  filename: string | null,
  waMediaIds: Record<string, string> = {},
): Promise<MediaFile> {
  const rel = path.join('media', workspaceId, `${crypto.randomUUID()}${extFor(mime, filename)}`);
  const abs = path.join(ctx.config.dataDir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const { size } = await fs.stat(tempPath);
  await fs.rename(tempPath, abs);
  try {
    const { rows } = await ctx.db.query<MediaFile>(
      `INSERT INTO media_files (workspace_id, path, mime, size, filename, wa_media_ids)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [workspaceId, rel, mime.split(';')[0].trim(), size, filename, JSON.stringify(waMediaIds)],
    );
    return rows[0];
  } catch (err) {
    await fs.rm(abs, { force: true }).catch(() => {});
    throw err;
  }
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
  // Any stored file can be resent (inbound ones too): refuse what Meta would reject, with a reason.
  assertWhatsAppMedia(file.mime, data.length, data);
  let id: string;
  try {
    id = await provider.uploadMedia(data, file.mime, file.filename ?? `archivo${extFor(file.mime)}`);
  } catch (err) {
    // Runs before the message row exists: without this the agent only gets a bare 500.
    if (err instanceof MetaApiError) throw badRequest(`WhatsApp no aceptó el archivo: ${explainMetaError(err.code, err.message)}`, 'META_ERROR');
    throw err;
  }
  await ctx.db.query(`UPDATE media_files SET wa_media_ids = wa_media_ids || $2::jsonb WHERE id = $1`, [
    file.id,
    JSON.stringify({ [channel.id]: `${id}@${Date.now()}` }),
  ]);
  return id;
}
