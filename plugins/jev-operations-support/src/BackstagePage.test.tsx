// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { demoEvaluation } from '@namayasai/backstage-plugin-jev-operations-support-common';

const mocks = vi.hoisted(() => {
  const fns = { query: vi.fn(), fetch: vi.fn(), config: vi.fn().mockReturnValue(undefined), discovery: vi.fn().mockResolvedValue('https://backstage.example/api/jev-operations-support') };
  return { ...fns, entity: { apiVersion: 'backstage.io/v1alpha1', kind: 'Component', metadata: { name: 'checkout', description: 'Payment service' } },
    apis: { catalog: { queryEntities: fns.query }, discovery: { getBaseUrl: fns.discovery }, config: { getOptionalString: fns.config }, fetch: { fetch: (...args: unknown[]) => fns.fetch(...args) } } };
});
vi.mock('@backstage/core-plugin-api', async importOriginal => ({
  ...await importOriginal<typeof import('@backstage/core-plugin-api')>(),
  discoveryApiRef: 'discovery', fetchApiRef: 'fetch', configApiRef: 'config',
  // Like the real hook, the same API instance is returned on every render.
  useApi: (ref: string) => mocks.apis[ref as keyof typeof mocks.apis] ?? mocks.apis.fetch,
  useRouteRef: () => (ref: { namespace: string; kind: string; name: string }) => `/catalog/${ref.namespace}/${ref.kind}/${ref.name}`,
}));
vi.mock('@backstage/plugin-catalog-react', () => ({ catalogApiRef: 'catalog', entityRouteRef: 'entity', useEntity: () => ({ entity: mocks.entity }) }));
import { EntityJevContent, JevPage, buildTechDocsPageUrl, extractTechDocsText, normalizeTechDocsPath, responseError } from './BackstagePage';
import { resetLivePreferenceForTests } from './useLiveEvaluation';
beforeEach(() => { window.localStorage.clear(); resetLivePreferenceForTests(); mocks.discovery.mockResolvedValue('https://backstage.example/api/jev-operations-support'); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('Backstage integration adapters', () => {
  it('loads a filtered authorized catalog shortlist and posts via the host fetch API', async () => {
    mocks.query.mockResolvedValue({ items: [{ apiVersion: 'scaffolder.backstage.io/v1beta3', kind: 'Template', metadata: { name: 'node-service', title: 'Node service', description: 'Node.js service with Postgres' } }] });
    mocks.fetch.mockImplementation(async (url, init) => String(url).includes('/aws-alerts?') ? new Response('{}', { status: 404 }) : new Response(JSON.stringify(demoEvaluation(JSON.parse(init.body)))));
    render(<MemoryRouter><JevPage /></MemoryRouter>);
    fireEvent.click(screen.getByRole('tab', { name: 'Pre-check' }));
    fireEvent.click(screen.getByRole('tab', { name: /Template advisor/ }));
    fireEvent.change(screen.getByLabelText('Service requirements'), { target: { value: 'Create a Node.js service with Postgres' } });
    fireEvent.change(screen.getByLabelText('Catalog filter'), { target: { value: 'Node' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Load from catalog' }));
    await screen.findByDisplayValue('Node service');
    expect(mocks.query).toHaveBeenCalledWith({
      limit: 20,
      filter: { kind: 'Template' },
      orderFields: [{ field: 'kind', order: 'asc' }, { field: 'metadata.namespace', order: 'asc' }, { field: 'metadata.name', order: 'asc' }],
      fullTextFilter: { term: 'Node', fields: ['metadata.name', 'metadata.title', 'metadata.description', 'metadata.tags'] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Run pre-check' }));
    const link = await screen.findByRole('link', { name: 'Open Node service in catalog →' });
    expect(link.getAttribute('href')).toBe('/catalog/default/template/node-service');
    expect(mocks.fetch.mock.calls.some(([url]) => url === 'https://backstage.example/api/jev-operations-support/evaluate')).toBe(true);
    expect(screen.getByText(/Backend demo mode is enabled/)).toBeTruthy();
  });
  it('renders separate Alerts and Playground pages without the old top-level switcher', async () => {
    mocks.fetch.mockResolvedValue(new Response('{}', { status: 404 }));
    const view = render(<MemoryRouter><JevPage page="alerts" /></MemoryRouter>);
    await screen.findByText(/AWS alerts are unavailable/);
    expect(screen.queryByRole('tablist', { name: 'Operations Support views' })).toBeNull();
    expect(screen.queryByLabelText('Runbook or operating procedure')).toBeNull();
    view.unmount();
    mocks.fetch.mockClear();
    render(<MemoryRouter><JevPage page="playground" /></MemoryRouter>);
    expect(screen.getByRole('tablist', { name: 'Decision workflows' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Incident triage' })).toBeNull();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('drops the old text and results when the catalog entity changes', async () => {
    mocks.entity.metadata.name = 'checkout';
    mocks.fetch.mockImplementation(async (_url, init) => new Response(JSON.stringify(demoEvaluation(JSON.parse(init.body)))));
    const view = render(<MemoryRouter><EntityJevContent /></MemoryRouter>);
    expect((screen.getByLabelText('Runbook or operating procedure') as HTMLTextAreaElement).value).toBe('');
    expect(screen.getByText(/Entity context/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Runbook or operating procedure'), { target: { value: 'A sufficiently detailed runbook with startup and health checks.' } });
    // The automatic (quiet) TechDocs load races this change; wait for it to settle so the
    // manual "Run pre-check" click below is not a no-op against a still-disabled button.
    await waitFor(() => expect((screen.getByRole('button', { name: 'Run pre-check' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Run pre-check' }));
    await screen.findByText(/Up to date/);
    mocks.entity = { ...mocks.entity, metadata: { name: 'identity', description: 'Authentication service' } };
    view.rerender(<MemoryRouter><EntityJevContent /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByText(/component:default\/identity/).length).toBeGreaterThan(0));
    expect(screen.queryByText(/Up to date/)).toBeNull();
    expect((screen.getByLabelText('Runbook or operating procedure') as HTMLTextAreaElement).value).toBe('');
  });

  it('loads the entity TechDocs on its own and checks readiness once Live is turned on', async () => {
    window.localStorage.setItem('jev-operations-support.live', 'on');
    mocks.entity = { apiVersion: 'backstage.io/v1alpha1', kind: 'Component', metadata: { name: 'checkout', description: 'Payment service' } };
    mocks.discovery.mockImplementation(async (plugin: string) => plugin === 'techdocs' ? 'https://backstage.example/api/techdocs' : 'https://backstage.example/api/jev-operations-support');
    mocks.fetch.mockImplementation(async (url: string, init: RequestInit) => String(url).includes('/techdocs/')
      // The real techdocs backend returns generated HTML as text/plain; charset=utf-8.
      ? new Response('<main><h1>手順書</h1><p>起動: npm start</p></main>', { headers: { 'content-type': 'text/plain; charset=utf-8' } })
      : new Response(JSON.stringify(demoEvaluation(JSON.parse(String(init.body))))));
    render(<MemoryRouter><EntityJevContent /></MemoryRouter>);
    await waitFor(() => expect((screen.getByLabelText('Runbook or operating procedure') as HTMLTextAreaElement).value).toContain('起動: npm start'));
    expect(mocks.fetch.mock.calls.some(([url]) => String(url) === 'https://backstage.example/api/techdocs/static/docs/default/component/checkout/index.html')).toBe(true);
    await screen.findByText(/Up to date/, undefined, { timeout: 3000 });
    const evaluation = mocks.fetch.mock.calls.find(([url]) => String(url).endsWith('/evaluate'));
    expect(JSON.parse(String(evaluation![1].body))).toMatchObject({ workflow: 'readiness' });
  });

  it('sends nothing from an entity tab with untouched storage, since Live defaults to off', async () => {
    mocks.discovery.mockImplementation(async (plugin: string) => plugin === 'techdocs' ? 'https://backstage.example/api/techdocs' : 'https://backstage.example/api/jev-operations-support');
    mocks.fetch.mockImplementation(async () => new Response('<main><p>起動: npm start で起動します</p></main>', { headers: { 'content-type': 'text/plain; charset=utf-8' } }));
    // A short, injectable delay makes this deterministic: with Live off, pending never becomes
    // true regardless of the quiet period, so no real wait anywhere near the 900ms default is needed.
    render(<MemoryRouter><EntityJevContent liveDelayMs={5} /></MemoryRouter>);
    await waitFor(() => expect((screen.getByLabelText('Runbook or operating procedure') as HTMLTextAreaElement).value).toContain('npm start'));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(mocks.fetch.mock.calls.some(([url]) => String(url).endsWith('/evaluate'))).toBe(false);
  });

  it('opens on the alert inbox and keeps the other views unloaded until visited', async () => {
    mocks.fetch.mockImplementation(async (url: string) => String(url).includes('/aws-alerts?')
      ? new Response(JSON.stringify({ totalCount: 1, notifications: [{ id: 'n1', origin: 'plugin:jev-operations-support', payload: { topic: 'jev-aws-alerts', title: 'checkout alarm', description: 'Error rate high', scope: 'aws-cloudwatch:m1', metadata: { jevOperationsSupport: { source: 'aws-cloudwatch', context: 'Checkout requests fail for customers.', awsState: 'ALARM', alarmArn: 'arn:aws:cloudwatch:ap-northeast-1:123:alarm:checkout', region: 'ap-northeast-1', evaluationStatus: 'not-evaluated' } } } }] }))
      : new Response('{}'));
    render(<MemoryRouter><JevPage /></MemoryRouter>);
    await screen.findAllByText('checkout alarm');
    expect(screen.queryByLabelText('Runbook or operating procedure')).toBeNull();
    // The authenticated module endpoint, not the standard Notifications list.
    expect(String(mocks.fetch.mock.calls[0][0])).toBe('https://backstage.example/api/jev-operations-support/aws-alerts?limit=20&offset=0');
    expect(mocks.discovery).not.toHaveBeenCalledWith('notifications');
    // Start a report in the inbox before leaving it; a remount would discard this draft text.
    fireEvent.click(screen.getByRole('button', { name: 'Triage a report' }));
    fireEvent.change(screen.getByLabelText('Report'), { target: { value: 'Customers cannot check out.' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Pre-check' }));
    await screen.findByLabelText('Runbook or operating procedure');
    // Returning to the inbox does not reload it: the view stayed mounted.
    fireEvent.click(screen.getByRole('tab', { name: 'Alerts' }));
    expect(mocks.fetch.mock.calls.filter(([url]) => String(url).includes('/aws-alerts?'))).toHaveLength(1);
    // The half-written report, and the pane showing it, both survived the round trip.
    expect(screen.getByRole('article', { name: 'Report triage' })).toBeTruthy();
    expect((screen.getByLabelText('Report') as HTMLTextAreaElement).value).toBe('Customers cannot check out.');
  });

  it('sends nothing from the playground while live check is off', async () => {
    window.localStorage.setItem('jev-operations-support.live', 'off');
    mocks.fetch.mockImplementation(async (url: string) => String(url).includes('/aws-alerts?') ? new Response('{}', { status: 404 }) : new Response('{}'));
    render(<MemoryRouter><JevPage liveDelayMs={5} /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('tab', { name: 'Pre-check' }));
    fireEvent.change(await screen.findByLabelText('Runbook or operating procedure'), { target: { value: 'A sufficiently detailed runbook' } });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(mocks.fetch.mock.calls.some(([url]) => String(url).endsWith('/evaluate'))).toBe(false);
  });

  it('opens on document review when the optional AWS module is not installed, and explains how to enable it', async () => {
    mocks.fetch.mockImplementation(async () => new Response(JSON.stringify({ error: { name: 'NotFoundError', message: 'no route' } }), { status: 404 }));
    render(<MemoryRouter><JevPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Pre-check' }).getAttribute('aria-selected')).toBe('true'));
    fireEvent.click(screen.getByRole('tab', { name: 'Alerts' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('jevOperationsSupport.awsNotifications'));
  });

  it('extracts TechDocs safely and rejects unsafe paths', async () => {
    const text = extractTechDocsText('<header>nav</header><main><h1>Runbook</h1><ul><li>Start</li><li>Check</li></ul><table><tr><th>Step</th><td>Run</td></tr></table><pre><code>npm start</code></pre><script>secret()</script></main>');
    expect(text).toContain('Runbook');
    expect(text).toContain('Start\n');
    expect(text).toContain('npm start');
    expect(text).toContain('Step | Run');
    expect(text).not.toContain('nav');
    expect(text).not.toContain('secret');
    expect(() => normalizeTechDocsPath('../private')).toThrow();
    expect(() => normalizeTechDocsPath('https://example.com')).toThrow();
    expect(normalizeTechDocsPath('operations/runbook/')).toEqual(['operations', 'runbook']);
    const entity = { ...mocks.entity, metadata: { ...mocks.entity.metadata, name: 'checkout' } } as any;
    expect(buildTechDocsPageUrl('https://backstage.example/api/techdocs', entity, 'operations/runbook')).toBe('https://backstage.example/api/techdocs/static/docs/default/component/checkout/operations/runbook/index.html');
    const retryError = await responseError(new Response(JSON.stringify({ error: { name: 'AuthenticationError', message: 'Missing credentials' } }), { status: 401 }), 'TechDocs failed');
    expect(retryError.message).toContain('Missing credentials');
    const htmlError = await responseError(new Response('<html>gateway error</html>', { status: 502 }), 'Evaluation failed');
    expect(htmlError.message).toBe('Evaluation failed (HTTP 502).');
    const throttled = await responseError(new Response(JSON.stringify({ error: 'Busy' }), { status: 429, headers: { 'Retry-After': '12' } }), 'Evaluation failed');
    expect(throttled.message).toContain('Retry after 12 seconds');
    // The parsed Retry-After is also carried as retryAfterMs, so useLiveEvaluation's backoff can honour it.
    expect((throttled as Error & { retryAfterMs?: number }).retryAfterMs).toBe(12000);
    expect((htmlError as Error & { retryAfterMs?: number }).retryAfterMs).toBeUndefined();
  });
});
