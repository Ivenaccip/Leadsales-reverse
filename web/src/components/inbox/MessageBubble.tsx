import { memo } from 'react';
import { AlertCircle, Ban, Check, CheckCheck, Clock, Download, FileText, ImageOff, Loader2, MapPin, Pencil, StickyNote } from 'lucide-react';
import { mediaUrl } from '../../lib/api';
import type { Message } from '../../lib/types';
import { cx } from '../ui';
import { SENT_BY_LABEL, WaText } from './helpers';

function timeOf(iso: string) {
  return new Date(iso).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
}

function StatusIcon({ status }: { status: Message['status'] }) {
  switch (status) {
    case 'pending':
      return <Clock className="h-3.5 w-3.5 text-slate-400" aria-label="Enviando" />;
    case 'unknown':
      return <AlertCircle className="h-3.5 w-3.5 text-amber-500" aria-label="Sin confirmar" />;
    case 'sent':
      return <Check className="h-3.5 w-3.5 text-slate-400" aria-label="Enviado" />;
    case 'delivered':
      return <CheckCheck className="h-3.5 w-3.5 text-slate-400" aria-label="Entregado" />;
    case 'read':
      return <CheckCheck className="h-3.5 w-3.5 text-sky-500" aria-label="Leído" />;
    case 'failed':
      return <AlertCircle className="h-3.5 w-3.5 text-red-500" aria-label="Falló" />;
    default:
      return null;
  }
}

function fileSize(n: number | null | undefined) {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Why a WhatsApp attachment will never show (the server gave up downloading it), or null while
 * it may still arrive. The customer is the only one who can send the file again.
 */
export function mediaDownloadError(m: Pick<Message, 'direction' | 'media'>): string | null {
  const raw = m.media?.download_error;
  const reason = typeof raw === 'string' ? raw.trim().replace(/[.\s]+$/, '') : '';
  if (!reason) return null;
  return m.direction === 'in' ? `No se pudo descargar el archivo: ${reason}. Pide al cliente que lo reenvíe.` : `No se pudo descargar el archivo: ${reason}.`;
}

function MediaContent({ m }: { m: Message }) {
  const inbound = m.direction === 'in';
  if (!m.media_file_id) {
    const failed = mediaDownloadError(m);
    if (failed) {
      return (
        <div className="flex items-start gap-2 rounded-md bg-red-50 px-3 py-3 text-xs text-red-700">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{failed}</span>
        </div>
      );
    }
    const Icon = inbound ? Loader2 : ImageOff;
    return (
      <div className="flex items-center gap-2 rounded-md bg-black/5 px-3 py-4 text-xs text-slate-500">
        <Icon className={cx('h-4 w-4', inbound && 'animate-spin')} />
        {inbound ? 'Descargando archivo de WhatsApp…' : 'Archivo no disponible'}
      </div>
    );
  }
  const src = mediaUrl(m.media_file_id);
  const filename = m.file_name ?? (m.media?.filename as string | undefined) ?? 'archivo';
  switch (m.type) {
    case 'image':
      return (
        <a href={src} target="_blank" rel="noopener noreferrer" className="block">
          <img src={src} alt={m.body ?? 'Imagen'} loading="lazy" className="max-h-80 w-full rounded-md bg-black/5 object-cover" />
        </a>
      );
    case 'sticker':
      return <img src={src} alt="Sticker" loading="lazy" className="h-32 w-32 object-contain" />;
    case 'video':
      return <video src={src} controls preload="metadata" className="max-h-80 w-full rounded-md bg-black" />;
    case 'audio':
      return <audio src={src} controls preload="none" className="w-64 max-w-full" />;
    default:
      return (
        <a href={src} target="_blank" rel="noopener noreferrer" className="flex items-center gap-3 rounded-md bg-black/5 px-3 py-2 hover:bg-black/10">
          <FileText className="h-8 w-8 shrink-0 text-slate-500" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-slate-800">{filename}</span>
            <span className="block text-xs text-slate-500">{[m.file_mime ?? (m.media?.mime as string | undefined), fileSize(m.file_size)].filter(Boolean).join(' · ')}</span>
          </span>
          <Download className="h-4 w-4 text-slate-500" />
        </a>
      );
  }
}

function Content({ m }: { m: Message }) {
  const isMedia = ['image', 'video', 'audio', 'document', 'sticker'].includes(m.type);
  if (isMedia) {
    return (
      <div className="space-y-1.5">
        <MediaContent m={m} />
        {m.body && m.type !== 'audio' && m.type !== 'sticker' && <WaText text={m.body} />}
      </div>
    );
  }
  if (m.type === 'location') {
    const p = m.payload ?? {};
    const href = p.latitude != null && p.longitude != null ? `https://www.google.com/maps?q=${p.latitude},${p.longitude}` : null;
    return (
      <div className="space-y-1">
        <div className="flex items-center gap-2 font-medium text-slate-800">
          <MapPin className="h-4 w-4 text-red-500" /> {p.name ?? 'Ubicación'}
        </div>
        {p.address && <p className="text-xs text-slate-500">{p.address}</p>}
        {href && (
          <a href={href} target="_blank" rel="noopener noreferrer" className="text-xs font-medium text-sky-700 underline">
            Abrir en Google Maps
          </a>
        )}
      </div>
    );
  }
  if (m.type === 'interactive' && m.direction === 'out' && m.payload?.interactive) {
    const it = m.payload.interactive;
    const buttons: string[] =
      it.type === 'button'
        ? (it.action?.buttons ?? []).map((b: any) => b.reply?.title ?? '')
        : (it.action?.sections ?? []).flatMap((s: any) => (s.rows ?? []).map((r: any) => r.title));
    return (
      <div className="space-y-2">
        <WaText text={it.body?.text ?? m.body} />
        <div className={cx('flex gap-1', it.type === 'button' ? 'flex-wrap' : 'flex-col')}>
          {it.type === 'list' && <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{it.action?.button ?? 'Opciones'}</span>}
          {buttons.map((b, i) => (
            <span key={i} className="rounded-md border border-sky-200 bg-white/70 px-2 py-1 text-center text-xs font-medium text-sky-700">
              {b}
            </span>
          ))}
        </div>
      </div>
    );
  }
  if ((m.type === 'interactive' || m.type === 'button') && m.direction === 'in') {
    return (
      <div>
        <span className="mb-0.5 block text-[11px] text-slate-500">↩ Respondió con una opción</span>
        <WaText text={m.body} />
      </div>
    );
  }
  if (m.type === 'reaction') {
    return (
      <span className="text-sm text-slate-600">
        Reaccionó <span className="text-xl">{m.body}</span>
      </span>
    );
  }
  if (m.type === 'unsupported') {
    return <span className="text-sm italic text-slate-500">{m.body ?? 'Mensaje no soportado'}</span>;
  }
  return <WaText text={m.body ?? ''} />;
}

// Memoized: the chat re-renders every bubble on each tick, new message or status change, and a
// long customer text is not cheap to format; a cached message keeps its object until it changes.
export const MessageBubble = memo(function MessageBubble({ m, senderName }: { m: Message; senderName?: string | null }) {
  if (m.direction === 'internal') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950 shadow-sm sm:max-w-[70%]">
          <div className="mb-1 flex items-center gap-1 text-[11px] font-medium text-amber-700">
            <StickyNote className="h-3 w-3" /> Nota interna{senderName ? ` · ${senderName}` : ''}
          </div>
          <WaText text={m.body} />
          <div className="mt-1 text-right text-[10px] text-amber-700/70">{timeOf(m.created_at)}</div>
        </div>
      </div>
    );
  }
  if (m.type === 'system') {
    return (
      <div className="flex justify-center">
        <span className="rounded-lg bg-white/80 px-3 py-1 text-xs text-slate-500 shadow-sm">{m.body}</span>
      </div>
    );
  }
  const out = m.direction === 'out';
  const label = out ? (m.sent_by === 'user' ? senderName : SENT_BY_LABEL[m.sent_by ?? '']) : null;
  // Changes made in WhatsApp (the customer's, or a reply edited in the Business app) update the
  // original message: the text stays readable for the team's record, marked as such.
  const deleted = !!m.payload?.deleted_at;
  const edits: { body?: string | null }[] = Array.isArray(m.payload?.edits) ? m.payload.edits : [];
  const edited = !deleted && !!m.payload?.edited_at;
  return (
    <div className={cx('flex', out ? 'justify-end' : 'justify-start')}>
      <div
        className={cx(
          'relative max-w-[85%] rounded-lg px-3 py-2 text-sm text-slate-800 shadow-sm sm:max-w-[70%]',
          out ? 'rounded-tr-none bg-[#d9fdd3]' : 'rounded-tl-none bg-white',
          m.status === 'failed' && 'ring-1 ring-red-300',
          m.status === 'unknown' && 'ring-1 ring-amber-300',
        )}
      >
        {(label || m.type === 'template') && (
          <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[11px] font-medium text-slate-500">
            {label && <span>{label}</span>}
            {m.type === 'template' && <span className="rounded bg-violet-100 px-1.5 py-px text-violet-700">Plantilla{m.payload?.name ? ` · ${m.payload.name}` : ''}</span>}
          </div>
        )}
        {deleted && (
          <div className="mb-1 flex items-center gap-1 text-[11px] font-medium italic text-slate-500">
            <Ban className="h-3 w-3" /> {out ? 'Mensaje eliminado' : 'El cliente eliminó este mensaje'}
          </div>
        )}
        <div className={cx(deleted && 'opacity-50')}>
          <Content m={m} />
        </div>
        <div className="mt-1 flex items-center justify-end gap-1 text-[10px] text-slate-500">
          {edited && (
            <span
              className="flex items-center gap-0.5 italic"
              title={edits.length ? `Antes:\n${edits.map((e) => e.body ?? '').join('\n')}` : undefined}
            >
              <Pencil className="h-2.5 w-2.5" /> Editado
            </span>
          )}
          {out && m.cost > 0 && <span title="Costo estimado en Meta">${m.cost.toFixed(4)}</span>}
          <span>{timeOf(m.created_at)}</span>
          {out && <StatusIcon status={m.status} />}
        </div>
        {(m.status === 'failed' || m.status === 'unknown') && m.error && (
          <div
            className={cx(
              'mt-1.5 flex items-start gap-1 rounded px-2 py-1 text-xs',
              m.status === 'failed' ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-800',
            )}
          >
            <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
            <span>
              {m.error.message ?? m.error.title ?? (m.status === 'failed' ? 'No se pudo enviar' : 'No pudimos confirmar el envío')}
              {m.error.code ? ` (código ${m.error.code})` : ''}
            </span>
          </div>
        )}
      </div>
    </div>
  );
});
