import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';

const session = { isAdmin: false };
vi.mock('../lib/session', () => ({ useSession: () => session }));

const { default: CreditsPage, ledgerQuery } = await import('../pages/Credits');

const summary = {
  billing_mode: 'prepaid',
  balance: 12.5,
  spent_this_month: 40,
  spent_total: 300,
  billable_messages_this_month: 800,
  by_category: [],
};

function render(isAdmin: boolean) {
  session.isAdmin = isAdmin;
  const qc = new QueryClient();
  qc.setQueryData(['credits'], summary);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <CreditsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('credits page for agents (#43)', () => {
  it('never shows a false "Sin movimientos": agents get a note instead of the ledger', () => {
    const html = render(false);
    expect(html).not.toContain('Sin movimientos');
    expect(html).toContain('Solo los administradores');
  });

  it('admins still get the ledger section', () => {
    const html = render(true);
    expect(html).not.toContain('Solo los administradores');
    expect(html).toContain('Movimientos');
  });

  it('the admin-only ledger endpoint is not called for agents', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ entries: [] }), { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    for (const [isAdmin, calls] of [
      [false, 0],
      [true, 1],
    ] as const) {
      fetch.mockClear();
      const qc = new QueryClient();
      const unsub = new QueryObserver(qc, ledgerQuery(1, isAdmin)).subscribe(() => {});
      await new Promise((r) => setTimeout(r, 0));
      unsub();
      expect(fetch.mock.calls.filter((c) => String((c as unknown[])[0]).startsWith('/api/credits/ledger'))).toHaveLength(calls);
    }
  });
});
