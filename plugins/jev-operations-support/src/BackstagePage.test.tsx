// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { demoEvaluation } from '@namayasai/backstage-plugin-jev-operations-support-common';

const mocks = vi.hoisted(() => ({
  entity: { apiVersion: 'backstage.io/v1alpha1', kind: 'Component', metadata: { name: 'checkout', description: 'Payment service' } },
  query: vi.fn(), fetch: vi.fn(), config: vi.fn().mockReturnValue(undefined), discovery: vi.fn().mockResolvedValue('https://backstage.example/api/jev-operations-support'),
}));
vi.mock('@backstage/core-plugin-api', () => ({
  discoveryApiRef: 'discovery', fetchApiRef: 'fetch', configApiRef: 'config',
  useApi: (ref: string) => ref === 'catalog' ? { queryEntities: mocks.query } : ref === 'discovery' ? { getBaseUrl: mocks.discovery } : ref === 'config' ? { getOptionalString: mocks.config } : { fetch: mocks.fetch },
  useRouteRef: () => (ref: { namespace: string; kind: string; name: string }) => `/catalog/${ref.namespace}/${ref.kind}/${ref.name}`,
}));
vi.mock('@backstage/plugin-catalog-react', () => ({ catalogApiRef: 'catalog', entityRouteRef: 'entity', useEntity: () => ({ entity: mocks.entity }) }));
import { EntityJevContent, JevPage, buildTechDocsPageUrl, extractTechDocsText, normalizeTechDocsPath, responseError } from './BackstagePage';
beforeEach(() => { mocks.discovery.mockResolvedValue('https://backstage.example/api/jev-operations-support'); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('Backstage integration adapters', () => {
  it('loads a filtered authorized catalog shortlist and posts via the host fetch API', async () => {
    mocks.query.mockResolvedValue({ items: [{ apiVersion: 'scaffolder.backstage.io/v1beta3', kind: 'Template', metadata: { name: 'node-service', title: 'Node service', description: 'Node.js service with Postgres' } }] });
    mocks.fetch.mockImplementation(async (_url, init) => new Response(JSON.stringify(demoEvaluation(JSON.parse(init.body)))));
    render(<MemoryRouter><JevPage /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: /Template advisor/ }));
    fireEvent.change(screen.getByLabelText('Context'), { target: { value: 'Create a Node.js service with Postgres' } });
    fireEvent.change(screen.getByLabelText('Catalog filter'), { target: { value: 'Node' } });
    fireEvent.click(screen.getByRole('button', { name: 'Load from catalog' }));
    await screen.findByDisplayValue('Node service');
    expect(mocks.query).toHaveBeenCalledWith({
      limit: 20,
      filter: { kind: 'Template' },
      orderFields: [{ field: 'kind', order: 'asc' }, { field: 'metadata.namespace', order: 'asc' }, { field: 'metadata.name', order: 'asc' }],
      fullTextFilter: { term: 'Node', fields: ['metadata.name', 'metadata.title', 'metadata.description', 'metadata.tags'] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Evaluate with Jev →' }));
    const link = await screen.findByRole('link', { name: 'Open Node service in catalog →' });
    expect(link.getAttribute('href')).toBe('/catalog/default/template/node-service');
    expect(mocks.fetch.mock.calls[0][0]).toBe('https://backstage.example/api/jev-operations-support/evaluate');
    expect(screen.getByText(/Backend demo mode is enabled/)).toBeTruthy();
  });
  it('drops the old text and results when the catalog entity changes', async () => {
    mocks.entity.metadata.name = 'checkout';
    mocks.fetch.mockImplementation(async (_url, init) => new Response(JSON.stringify(demoEvaluation(JSON.parse(init.body)))));
    const view = render(<MemoryRouter><EntityJevContent /></MemoryRouter>);
    expect((screen.getByLabelText('Context') as HTMLTextAreaElement).value).toBe('');
    expect(screen.getByText(/Entity context/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Context'), { target: { value: 'A sufficiently detailed runbook with startup and health checks.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Evaluate with Jev →' }));
    await screen.findByText('Decision details');
    mocks.entity = { ...mocks.entity, metadata: { name: 'identity', description: 'Authentication service' } };
    view.rerender(<MemoryRouter><EntityJevContent /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByText(/component:default\/identity/).length).toBeGreaterThan(0));
    expect(screen.queryByText('Decision details')).toBeNull();
  });

  it('loads a TechDocs page into the editor without evaluating it', async () => {
    mocks.entity = { apiVersion: 'backstage.io/v1alpha1', kind: 'Component', metadata: { name: 'checkout', description: 'Payment service' } };
    mocks.discovery.mockImplementation(async (plugin: string) => plugin === 'techdocs' ? 'https://backstage.example/api/techdocs' : 'https://backstage.example/api/jev-operations-support');
    mocks.fetch.mockImplementation(async (url: string, init: RequestInit) => String(url).includes('/techdocs/')
      // The real techdocs backend returns generated HTML as text/plain; charset=utf-8.
      ? new Response('<main><h1>手順書</h1><p>起動: npm start</p></main>', { headers: { 'content-type': 'text/plain; charset=utf-8' } })
      : new Response(JSON.stringify(demoEvaluation(JSON.parse(String(init.body))))));
    render(<MemoryRouter><EntityJevContent /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Load into editor' }));
    await waitFor(() => expect((screen.getByLabelText('Context') as HTMLTextAreaElement).value).toContain('起動: npm start'));
    expect(mocks.fetch.mock.calls.some(([url]) => String(url) === 'https://backstage.example/api/techdocs/static/docs/default/component/checkout/index.html')).toBe(true);
    expect(mocks.fetch.mock.calls.some(([url]) => String(url).endsWith('/evaluate'))).toBe(false);
  });

  it('loads AWS alerts from the plugin endpoint only after selecting the alerts view', async () => {
    mocks.fetch.mockImplementation(async (url: string) => String(url).includes('/aws-alerts?')
      ? new Response(JSON.stringify({ totalCount: 1, notifications: [{ id: 'n1', origin: 'plugin:jev-operations-support', payload: { topic: 'jev-aws-alerts', title: 'checkout alarm', description: 'Error rate high', scope: 'aws-cloudwatch:m1', metadata: { jevOperationsSupport: { source: 'aws-cloudwatch', context: 'Checkout requests fail for customers.', awsState: 'ALARM', alarmArn: 'arn:aws:cloudwatch:ap-northeast-1:123:alarm:checkout', region: 'ap-northeast-1', evaluationStatus: 'not-evaluated' } } } }] }))
      : new Response('{}'));
    render(<MemoryRouter><JevPage /></MemoryRouter>);
    expect(mocks.fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'AWS alerts' }));
    await screen.findAllByText('checkout alarm');
    // The authenticated module endpoint, not the standard Notifications list.
    expect(String(mocks.fetch.mock.calls[0][0])).toBe('https://backstage.example/api/jev-operations-support/aws-alerts?limit=20&offset=0');
    expect(mocks.discovery).not.toHaveBeenCalledWith('notifications');
    // The alerts view carries the shared stylesheet, which the workbench would otherwise own.
    expect([...document.querySelectorAll('style')].some(node => node.textContent?.includes('.jev-alert'))).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Operations workbench' }));
    await screen.findByLabelText('Context');
    expect(mocks.fetch.mock.calls.some(([url]) => String(url).endsWith('/evaluate'))).toBe(false);
  });

  it('explains how to enable AWS alerts when the optional module is not installed', async () => {
    mocks.fetch.mockImplementation(async () => new Response(JSON.stringify({ error: { name: 'NotFoundError', message: 'no route' } }), { status: 404 }));
    render(<MemoryRouter><JevPage /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'AWS alerts' }));
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
  });
});
