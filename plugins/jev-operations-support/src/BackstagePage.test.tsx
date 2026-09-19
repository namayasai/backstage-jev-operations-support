// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { demoEvaluation } from '@namayasai/backstage-plugin-jev-operations-support-common';

const mocks = vi.hoisted(() => ({
  entity: { apiVersion: 'backstage.io/v1alpha1', kind: 'Component', metadata: { name: 'checkout', description: 'Payment service' } },
  query: vi.fn(), fetch: vi.fn(), discovery: vi.fn().mockResolvedValue('https://backstage.example/api/jev-operations-support'),
}));
vi.mock('@backstage/core-plugin-api', () => ({
  discoveryApiRef: 'discovery', fetchApiRef: 'fetch',
  useApi: (ref: string) => ref === 'catalog' ? { queryEntities: mocks.query } : ref === 'discovery' ? { getBaseUrl: mocks.discovery } : { fetch: mocks.fetch },
  useRouteRef: () => (ref: { namespace: string; kind: string; name: string }) => `/catalog/${ref.namespace}/${ref.kind}/${ref.name}`,
}));
vi.mock('@backstage/plugin-catalog-react', () => ({ catalogApiRef: 'catalog', entityRouteRef: 'entity', useEntity: () => ({ entity: mocks.entity }) }));
import { EntityJevContent, JevPage } from './BackstagePage';
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
    expect(mocks.query).toHaveBeenCalledWith({ limit: 20, filter: { kind: 'Template' }, fullTextFilter: { term: 'Node' } });
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
    fireEvent.click(screen.getByRole('button', { name: 'Evaluate with Jev →' }));
    await screen.findByText('Decision details');
    mocks.entity = { ...mocks.entity, metadata: { name: 'identity', description: 'Authentication service' } };
    view.rerender(<MemoryRouter><EntityJevContent /></MemoryRouter>);
    await waitFor(() => expect((screen.getByLabelText('Context') as HTMLTextAreaElement).value).toContain('component:default/identity'));
    expect(screen.queryByText('Decision details')).toBeNull();
  });
});
