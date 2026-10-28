import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Coins, MessageCircle, Trophy, UserPlus } from 'lucide-react';
import { api, qs } from '../lib/api';
import { credits, duration, money, number, SOURCE_LABEL } from '../lib/format';
import { BarList, ColumnChart, LineChart, SERIES } from '../components/charts';
import { Avatar, Card, EmptyState, Input, Page, PageHeader, PageLoader, Select, Stat, Tabs, cx } from '../components/ui';

interface Report {
  totals: { new_leads: number; messages_in: number; messages_out: number; active_conversations: number; won: number; won_value: number; spend: number };
  daily: { day: string; leads: number; messages_in: number; messages_out: number }[];
  sources: { source: string; count: number }[];
  funnels: { funnel_id: string; funnel: string; stage_id: string; stage: string; color: string; kind: string; count: number; value: number }[];
  agents: { user_id: string; name: string; open_leads: number; messages_sent: number; won: number; avg_first_response_seconds: number | null }[];
}

const RANGES = [
  { id: '7', label: '7 días' },
  { id: '30', label: '30 días' },
  { id: '90', label: '90 días' },
  { id: 'custom', label: 'Personalizado' },
] as const;

function isoDay(d: Date) {
  return d.toISOString().slice(0, 10);
}

export default function ReportsPage() {
  const [range, setRange] = useState<(typeof RANGES)[number]['id']>('30');
  const [custom, setCustom] = useState({ from: isoDay(new Date(Date.now() - 30 * 86400000)), to: isoDay(new Date()) });
  const [funnelId, setFunnelId] = useState<string>('');
  const [view, setView] = useState<'chart' | 'table'>('chart');

  const params = useMemo(() => {
    if (range === 'custom') return custom;
    const days = Number(range);
    return { from: isoDay(new Date(Date.now() - (days - 1) * 86400000)), to: isoDay(new Date()) };
  }, [range, custom]);

  const report = useQuery({ queryKey: ['report', params], queryFn: () => api.get<Report>(`/api/reports/overview${qs(params)}`) });
  const r = report.data;

  const funnels = useMemo(() => {
    const m = new Map<string, { id: string; name: string; stages: Report['funnels'] }>();
    for (const row of r?.funnels ?? []) {
      if (!m.has(row.funnel_id)) m.set(row.funnel_id, { id: row.funnel_id, name: row.funnel, stages: [] });
      m.get(row.funnel_id)!.stages.push(row);
    }
    return [...m.values()];
  }, [r]);
  const funnel = funnels.find((f) => f.id === funnelId) ?? funnels[0];

  return (
    <Page wide>
      <PageHeader title="Reportes" description="Cómo va tu embudo, tu equipo y tu gasto en WhatsApp." />

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-slate-300 bg-white p-0.5">
          {RANGES.map((x) => (
            <button
              key={x.id}
              onClick={() => setRange(x.id)}
              className={cx('rounded-md px-3 py-1.5 text-sm font-medium', range === x.id ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-100')}
            >
              {x.label}
            </button>
          ))}
        </div>
        {range === 'custom' && (
          <>
            <Input type="date" className="w-40" value={custom.from} max={custom.to} onChange={(e) => setCustom({ ...custom, from: e.target.value })} />
            <span className="text-slate-400">a</span>
            <Input type="date" className="w-40" value={custom.to} min={custom.from} onChange={(e) => setCustom({ ...custom, to: e.target.value })} />
          </>
        )}
      </div>

      {report.isLoading || !r ? (
        <PageLoader />
      ) : (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label="Leads nuevos" value={number(r.totals.new_leads)} icon={<UserPlus className="h-4 w-4" />} hint={`${number(r.totals.active_conversations)} conversaciones activas`} />
            <Stat label="Mensajes" value={number(r.totals.messages_in + r.totals.messages_out)} icon={<MessageCircle className="h-4 w-4" />} hint={`${number(r.totals.messages_in)} recibidos · ${number(r.totals.messages_out)} enviados`} />
            <Stat label="Ventas ganadas" value={number(r.totals.won)} icon={<Trophy className="h-4 w-4" />} hint={`${money(r.totals.won_value)} en valor`} />
            <Stat label="Gasto en WhatsApp" value={credits(r.totals.spend)} icon={<Coins className="h-4 w-4" />} hint="Costo de Meta en el periodo" />
          </div>

          <div className="flex justify-end">
            <Tabs
              tabs={[
                { id: 'chart', label: 'Gráficas' },
                { id: 'table', label: 'Tabla por día' },
              ]}
              value={view}
              onChange={setView}
            />
          </div>

          {view === 'chart' ? (
            <div className="grid gap-6 xl:grid-cols-2">
              <Card title="Leads nuevos por día">
                <ColumnChart labels={r.daily.map((d) => d.day)} values={r.daily.map((d) => d.leads)} unit="leads nuevos" />
              </Card>
              <Card title="Mensajes por día">
                <LineChart
                  labels={r.daily.map((d) => d.day)}
                  series={[
                    { name: 'Recibidos', values: r.daily.map((d) => d.messages_in), color: SERIES[0] },
                    { name: 'Enviados', values: r.daily.map((d) => d.messages_out), color: SERIES[1] },
                  ]}
                />
              </Card>
            </div>
          ) : (
            <Card padded={false}>
              <div className="scroll-thin max-h-96 overflow-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-slate-50 text-left text-xs uppercase text-slate-500">
                    <tr>
                      <th className="px-4 py-2">Día</th>
                      <th className="px-4 py-2 text-right">Leads nuevos</th>
                      <th className="px-4 py-2 text-right">Recibidos</th>
                      <th className="px-4 py-2 text-right">Enviados</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {[...r.daily].reverse().map((d) => (
                      <tr key={d.day}>
                        <td className="px-4 py-2">{new Date(`${d.day}T12:00:00`).toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short' })}</td>
                        <td className="px-4 py-2 text-right">{d.leads}</td>
                        <td className="px-4 py-2 text-right">{d.messages_in}</td>
                        <td className="px-4 py-2 text-right">{d.messages_out}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          <div className="grid gap-6 xl:grid-cols-[2fr_1fr]">
            <Card
              title="Embudo actual"
              description="Leads por etapa y valor acumulado (hoy, sin importar el periodo)."
              actions={
                funnels.length > 1 && (
                  <Select className="h-8 w-48" value={funnel?.id} onChange={(e) => setFunnelId(e.target.value)}>
                    {funnels.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </Select>
                )
              }
            >
              {funnel ? (
                <BarList items={funnel.stages.map((s) => ({ label: s.stage, value: s.count, dot: s.color, sub: money(s.value) }))} />
              ) : (
                <EmptyState title="Sin embudos" />
              )}
            </Card>
            <Card title="Origen de los leads">
              {r.sources.length ? (
                <BarList items={r.sources.map((s) => ({ label: SOURCE_LABEL[s.source] ?? s.source, value: s.count }))} color={SERIES[2]} />
              ) : (
                <p className="text-sm text-slate-500">Sin leads en el periodo.</p>
              )}
            </Card>
          </div>

          <Card title="Rendimiento del equipo" description="Primera respuesta: tiempo promedio entre el primer mensaje del lead y la primera respuesta humana." padded={false}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                  <tr>
                    <th className="px-5 py-2">Agente</th>
                    <th className="px-5 py-2 text-right">Leads abiertos</th>
                    <th className="px-5 py-2 text-right">Mensajes enviados</th>
                    <th className="px-5 py-2 text-right">Ventas ganadas</th>
                    <th className="px-5 py-2 text-right">Primera respuesta</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {r.agents.map((a) => (
                    <tr key={a.user_id}>
                      <td className="px-5 py-3">
                        <span className="flex items-center gap-2">
                          <Avatar name={a.name} size="sm" /> {a.name}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-right">{number(a.open_leads)}</td>
                      <td className="px-5 py-3 text-right">{number(a.messages_sent)}</td>
                      <td className="px-5 py-3 text-right">{number(a.won)}</td>
                      <td className="px-5 py-3 text-right">{duration(a.avg_first_response_seconds)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}
    </Page>
  );
}
