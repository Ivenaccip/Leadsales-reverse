import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowDownLeft, ArrowUpRight, Coins, Info, Receipt } from 'lucide-react';
import { api } from '../lib/api';
import { CATEGORY_LABEL, credits, dateTime, formatPhone, MARKET_LABEL, number } from '../lib/format';
import { useCredits } from '../lib/queries';
import { BarList, SERIES } from '../components/charts';
import { Alert, Badge, Button, Card, EmptyState, Page, PageHeader, PageLoader, Stat } from '../components/ui';

interface LedgerEntry {
  id: string;
  amount: number;
  balance_after: number;
  kind: 'topup' | 'charge' | 'refund' | 'adjustment';
  description: string | null;
  created_at: string;
  created_by_name: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  broadcast_name: string | null;
}

const KIND: Record<LedgerEntry['kind'], { label: string; color: 'green' | 'gray' | 'blue' | 'yellow' }> = {
  topup: { label: 'Recarga', color: 'green' },
  charge: { label: 'Consumo', color: 'gray' },
  refund: { label: 'Reembolso', color: 'blue' },
  adjustment: { label: 'Ajuste', color: 'yellow' },
};

const CATS = ['marketing', 'utility', 'authentication', 'service'];

export default function CreditsPage() {
  const summary = useCredits();
  const [page, setPage] = useState(1);
  const ledger = useQuery({
    queryKey: ['ledger', page],
    queryFn: async () => (await api.get<{ entries: LedgerEntry[] }>(`/api/credits/ledger?page=${page}`)).entries,
  });
  const rates = useQuery({
    queryKey: ['rates'],
    queryFn: async () => (await api.get<{ rates: { market: string; category: string; price: number }[] }>('/api/credits/rates')).rates,
  });

  if (!summary.data) return <PageLoader />;
  const s = summary.data;
  const prepaid = s.billing_mode === 'prepaid';
  const markets = [...new Set((rates.data ?? []).map((r) => r.market))];
  const price = (m: string, c: string) => rates.data?.find((r) => r.market === m && r.category === c)?.price;

  return (
    <Page>
      <PageHeader
        title="Créditos"
        description={
          prepaid
            ? 'Tu saldo prepagado. Cada plantilla enviada descuenta su costo real de Meta; si Meta no la cobra, se te reembolsa.'
            : 'Sin mensualidad: Meta cobra directamente a tu tarjeta los mensajes que envías. Aquí ves el gasto estimado y conciliado.'
        }
      />
      <div className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {prepaid ? (
            <Stat label="Saldo disponible" value={credits(s.balance)} icon={<Coins className="h-4 w-4" />} hint="Créditos en USD" />
          ) : (
            <Stat label="Modelo" value="Pago directo a Meta" icon={<Coins className="h-4 w-4" />} hint="Tu tarjeta en WhatsApp Manager" />
          )}
          <Stat label="Gasto este mes" value={credits(s.spent_this_month)} />
          <Stat label="Mensajes cobrables este mes" value={number(s.billable_messages_this_month)} />
          <Stat label="Gasto histórico" value={credits(s.spent_total)} />
        </div>

        {prepaid && s.balance < 1 && (
          <Alert tone="warning" title="Saldo bajo">
            Cuando no hay saldo, las plantillas y difusiones se detienen. Pide una recarga al administrador de tu comunidad.
          </Alert>
        )}

        <div className="grid gap-6 lg:grid-cols-[1fr_2fr]">
          <Card title="Este mes por categoría">
            {s.by_category.length ? (
              <BarList items={s.by_category.map((c) => ({ label: CATEGORY_LABEL[c.category] ?? c.category, value: c.cost, sub: `${number(c.messages)} msjs` }))} format={credits} color={SERIES[0]} />
            ) : (
              <p className="text-sm text-slate-500">Aún no hay consumo este mes.</p>
            )}
          </Card>
          <Card
            title="Tarifas de referencia de Meta (USD por mensaje)"
            description="Meta cobra por plantilla entregada según la categoría y el país del destinatario. Las respuestas dentro de la ventana de 24 h solo se cobran si Meta las marca como cobrables."
            padded={false}
          >
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                  <tr>
                    <th className="px-4 py-2">Mercado</th>
                    {CATS.map((c) => (
                      <th key={c} className="px-4 py-2 text-right">
                        {CATEGORY_LABEL[c]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {markets.map((m) => (
                    <tr key={m}>
                      <td className="px-4 py-2 text-slate-700">{MARKET_LABEL[m] ?? m}</td>
                      {CATS.map((c) => (
                        <td key={c} className="px-4 py-2 text-right font-mono text-xs">
                          {price(m, c) != null ? `$${price(m, c)!.toFixed(4)}` : '—'}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="flex gap-2 px-4 py-3 text-xs text-slate-500">
              <Info className="h-4 w-4 shrink-0" /> Valores de referencia que el administrador de la instancia actualiza. El cargo final se ajusta con el precio que Meta reporta en cada webhook.
            </p>
          </Card>
        </div>

        <Card title="Movimientos" padded={false}>
          {ledger.isLoading ? (
            <PageLoader />
          ) : !ledger.data?.length ? (
            <EmptyState icon={<Receipt className="h-6 w-6" />} title="Sin movimientos" description="Aquí verás cada plantilla cobrada, reembolso y recarga." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                  <tr>
                    <th className="px-4 py-2">Fecha</th>
                    <th className="px-4 py-2">Tipo</th>
                    <th className="px-4 py-2">Detalle</th>
                    <th className="px-4 py-2 text-right">Monto</th>
                    {prepaid && <th className="px-4 py-2 text-right">Saldo</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {ledger.data.map((e) => (
                    <tr key={e.id}>
                      <td className="whitespace-nowrap px-4 py-2 text-slate-500">{dateTime(e.created_at)}</td>
                      <td className="px-4 py-2">
                        <Badge color={KIND[e.kind].color}>{KIND[e.kind].label}</Badge>
                      </td>
                      <td className="px-4 py-2 text-slate-700">
                        {e.description}
                        {(e.contact_name || e.contact_phone) && <span className="text-slate-500"> · {e.contact_name ?? formatPhone(e.contact_phone)}</span>}
                        {e.broadcast_name && <span className="text-slate-500"> · Difusión “{e.broadcast_name}”</span>}
                        {e.created_by_name && e.kind === 'topup' && <span className="text-slate-500"> · por {e.created_by_name}</span>}
                      </td>
                      <td className={`whitespace-nowrap px-4 py-2 text-right font-mono text-xs ${e.amount >= 0 ? 'text-emerald-700' : 'text-slate-800'}`}>
                        <span className="inline-flex items-center gap-1">
                          {e.amount >= 0 ? <ArrowDownLeft className="h-3 w-3" /> : <ArrowUpRight className="h-3 w-3" />}
                          {credits(Math.abs(e.amount))}
                        </span>
                      </td>
                      {prepaid && <td className="whitespace-nowrap px-4 py-2 text-right font-mono text-xs">{credits(e.balance_after)}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="flex justify-between border-t border-slate-100 px-4 py-3">
            <Button size="sm" variant="outline" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
              Anterior
            </Button>
            <Button size="sm" variant="outline" disabled={(ledger.data?.length ?? 0) < 100} onClick={() => setPage((p) => p + 1)}>
              Siguiente
            </Button>
          </div>
        </Card>
      </div>
    </Page>
  );
}
