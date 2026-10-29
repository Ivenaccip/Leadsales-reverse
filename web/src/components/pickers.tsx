import { useMemo, useState } from 'react';
import { Check, Plus, Search } from 'lucide-react';
import { errorMessage } from '../lib/api';
import type { Funnel, Member, Tag } from '../lib/types';
import { cx, Select, TagChip } from './ui';

export const TAG_NAME_HINT = 'Máximo 40 caracteres, sin ; , ni | (separan etiquetas al importar un CSV).';

/** Same rule as the server: ; , and | split a CSV tags cell, so a name with one would not import back whole. */
export function tagNameProblem(name: string): string | null {
  const n = name.trim();
  if (/[;,|]/.test(n)) return 'El nombre de una etiqueta no puede llevar ; , ni |';
  if (n.length > 40) return 'El nombre de una etiqueta admite máximo 40 caracteres';
  return null;
}

/** Multi-select of tags with search; optionally lets the user create a tag. */
export function TagMultiSelect({
  tags,
  value,
  onChange,
  onCreate,
  placeholder = 'Agregar etiqueta…',
}: {
  tags: Tag[];
  value: string[];
  onChange: (ids: string[]) => void;
  onCreate?: (name: string) => Promise<Tag>;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const selected = tags.filter((t) => value.includes(t.id));
  const filtered = tags.filter((t) => t.name.toLowerCase().includes(q.toLowerCase()));
  const exact = tags.some((t) => t.name.toLowerCase() === q.trim().toLowerCase());
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);

  return (
    <div className="relative">
      <div className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2 py-1.5">
        {selected.map((t) => (
          <TagChip key={t.id} name={t.name} color={t.color} onRemove={() => toggle(t.id)} />
        ))}
        <button type="button" onClick={() => setOpen((v) => !v)} className="inline-flex items-center gap-1 rounded px-1 text-xs text-slate-500 hover:text-brand-700">
          <Plus className="h-3.5 w-3.5" /> {selected.length ? '' : placeholder}
        </button>
      </div>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute left-0 right-0 z-40 mt-1 rounded-lg border border-slate-200 bg-white p-1 shadow-lg">
            <div className="flex items-center gap-2 border-b border-slate-100 px-2 pb-1">
              <Search className="h-4 w-4 text-slate-400" />
              <input
                autoFocus
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setCreateError(null);
                }}
                placeholder="Buscar…"
                className="h-8 flex-1 text-sm outline-none"
              />
            </div>
            <div className="scroll-thin max-h-56 overflow-y-auto py-1">
              {filtered.map((t) => (
                <button key={t.id} type="button" onClick={() => toggle(t.id)} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-slate-50">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: t.color }} />
                  <span className="flex-1 truncate">{t.name}</span>
                  {value.includes(t.id) && <Check className="h-4 w-4 text-brand-600" />}
                </button>
              ))}
              {onCreate && q.trim() && !exact && tagNameProblem(q) && <p className="px-2 py-1.5 text-xs text-amber-700">{tagNameProblem(q)}</p>}
              {onCreate && q.trim() && !exact && !tagNameProblem(q) && (
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      const t = await onCreate(q.trim());
                      onChange([...value, t.id]);
                      setQ('');
                    } catch (err) {
                      setCreateError(errorMessage(err));
                    }
                  }}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-brand-700 hover:bg-brand-50"
                >
                  <Plus className="h-4 w-4" /> Crear “{q.trim()}”
                </button>
              )}
              {createError && <p className="px-2 py-1.5 text-xs text-red-600">{createError}</p>}
              {!filtered.length && !q && <p className="px-2 py-2 text-xs text-slate-400">No hay etiquetas</p>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** Stage select grouped by funnel. */
export function StageSelect({
  funnels,
  value,
  onChange,
  allowEmpty,
  emptyLabel = 'Sin etapa',
  funnelId,
  className,
}: {
  funnels: Funnel[];
  value: string | null | undefined;
  onChange: (stageId: string | null) => void;
  allowEmpty?: boolean;
  emptyLabel?: string;
  funnelId?: string;
  className?: string;
}) {
  const list = funnelId ? funnels.filter((f) => f.id === funnelId) : funnels;
  return (
    <Select className={className} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
      {allowEmpty && <option value="">{emptyLabel}</option>}
      {list.map((f) =>
        list.length > 1 ? (
          <optgroup key={f.id} label={f.name}>
            {f.stages.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </optgroup>
        ) : (
          f.stages.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))
        ),
      )}
    </Select>
  );
}

export function MemberSelect({
  members,
  value,
  onChange,
  emptyLabel = 'Sin asignar',
  className,
}: {
  members: Member[];
  value: string | null | undefined;
  onChange: (userId: string | null) => void;
  emptyLabel?: string;
  className?: string;
}) {
  return (
    <Select className={className} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">{emptyLabel}</option>
      {members
        .filter((m) => m.is_active)
        .map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
    </Select>
  );
}

/** Multi-select of stages as toggleable pills (used for audiences and filters). */
export function StagePills({ funnel, value, onChange }: { funnel: Funnel; value: string[]; onChange: (ids: string[]) => void }) {
  const set = useMemo(() => new Set(value), [value]);
  return (
    <div className="flex flex-wrap gap-1.5">
      {funnel.stages.map((s) => {
        const on = set.has(s.id);
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => onChange(on ? value.filter((x) => x !== s.id) : [...value, s.id])}
            className={cx('rounded-full border px-2.5 py-1 text-xs font-medium transition-colors', on ? 'text-white' : 'bg-white text-slate-600 hover:bg-slate-50')}
            style={on ? { background: s.color, borderColor: s.color } : { borderColor: '#cbd5e1' }}
          >
            {s.name}
          </button>
        );
      })}
    </div>
  );
}
