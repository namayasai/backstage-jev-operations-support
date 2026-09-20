// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mocks = vi.hoisted(() => {
  const fns = { fetch: vi.fn(), discovery: vi.fn(), getEntityByRef: vi.fn() };
  return {
    ...fns,
    entity: { apiVersion: 'backstage.io/v1alpha1', kind: 'Component', metadata: { namespace: 'default', name: 'checkout' }, spec: { owner: 'unknown' } },
    apis: {
      discovery: { getBaseUrl: fns.discovery },
      fetch: { fetch: (...args: unknown[]) => fns.fetch(...args) },
      catalog: { getEntityByRef: (...args: unknown[]) => fns.getEntityByRef(...args) },
    },
  };
});
vi.mock('@backstage/core-plugin-api', async importOriginal => ({
  ...await importOriginal<typeof import('@backstage/core-plugin-api')>(),
  discoveryApiRef: 'discovery', fetchApiRef: 'fetch',
  useApi: (ref: string) => mocks.apis[ref as keyof typeof mocks.apis],
  useRouteRef: () => (ref: { namespace: string; kind: string; name: string }) => `/catalog/${ref.namespace}/${ref.kind}/${ref.name}`,
}));
vi.mock('@backstage/plugin-catalog-react', () => ({ entityRouteRef: 'entity', catalogApiRef: 'catalog', useEntity: () => ({ entity: mocks.entity }) }));

import { EntityJevOwnerSuggestionCard, EntityJevReadinessCard } from './entityCards';

beforeEach(() => {
  mocks.entity = { apiVersion: 'backstage.io/v1alpha1', kind: 'Component', metadata: { namespace: 'default', name: 'checkout' }, spec: { owner: 'unknown' } };
  mocks.discovery.mockResolvedValue('https://backstage.example/api/tech-insights');
  // Most tests never reach a live Group-existence check (only an unchanged owner-not-found row
  // does); a never-resolving default makes any test that unexpectedly does reach it hang and
  // fail loudly instead of racing.
  mocks.getEntityByRef.mockReturnValue(new Promise(() => {}));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function factsResponse(retrieverId: string, facts: Record<string, unknown>, timestamp = new Date().toISOString()) {
  return new Response(JSON.stringify({ [retrieverId]: { timestamp, version: '0.1.0', facts } }));
}

/** A fully-shaped owner fact, so each test only needs to override what it cares about. */
function ownerFacts(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    evaluationStatus: 'evaluated', selection: 'unowned', reason: '', checkedOwner: 'unknown',
    suggestedOwnerRef: '', suggestedOwnerTitle: '', confidence: 0, needsReview: true,
    candidateCount: 0, shortened: false, model: 'jev-1.13.0',
    ...overrides,
  };
}

const readinessId = 'jevTechInsightsFactRetriever';
const ownerId = 'jevOwnerSuggestionFactRetriever';

describe('useLatestFact query contract (both cards)', () => {
  it('requests exactly what TechInsightsClient.getFacts sends: entity=<ref>&ids[0]=<retrieverId>', async () => {
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({})));
    render(<MemoryRouter><EntityJevReadinessCard /></MemoryRouter>);
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalled());
    const [url] = mocks.fetch.mock.calls[0];
    expect(String(url)).toBe('https://backstage.example/api/tech-insights/facts/latest?entity=component%3Adefault%2Fcheckout&ids%5B0%5D=jevTechInsightsFactRetriever');
  });

  it('does not crash or warn when the component unmounts before the fetch resolves', async () => {
    let resolve!: (value: Response) => void;
    mocks.fetch.mockReturnValue(new Promise(r => { resolve = r; }));
    const view = render(<MemoryRouter><EntityJevReadinessCard /></MemoryRouter>);
    view.unmount();
    expect(() => resolve(new Response(JSON.stringify({})))).not.toThrow();
    await new Promise(r => setTimeout(r, 0));
  });
});

describe('EntityJevReadinessCard', () => {
  it('shows a loading skeleton before the facts resolve', async () => {
    let resolve!: (value: Response) => void;
    mocks.fetch.mockReturnValue(new Promise(r => { resolve = r; }));
    render(<MemoryRouter><EntityJevReadinessCard /></MemoryRouter>);
    expect(screen.getByRole('article', { name: 'Operational readiness' })).toBeTruthy();
    expect(screen.queryByText(/No scheduled result yet/)).toBeNull();
    resolve(factsResponse(readinessId, { evaluationStatus: 'evaluated', evidenceStatus: 'pass', passCount: 4, reviewCount: 0, attentionCount: 0, checkCount: 4, evaluatedCheckCount: 4, coverage: 1, model: 'jev-1.13.0' }));
    await screen.findByText('Clear');
  });

  it('shows a quiet line, not an error, when the Tech Insights backend is absent (discovery failure)', async () => {
    mocks.discovery.mockRejectedValue(new Error('no plugin registered at tech-insights'));
    render(<MemoryRouter><EntityJevReadinessCard /></MemoryRouter>);
    await screen.findByText(/Scheduled checks are not set up/);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the same quiet line when the route answers 404', async () => {
    mocks.fetch.mockResolvedValue(new Response('{}', { status: 404 }));
    render(<MemoryRouter><EntityJevReadinessCard /></MemoryRouter>);
    await screen.findByText(/Scheduled checks are not set up/);
  });

  it('says plainly that no scheduled result exists yet, when the route has no row for this entity', async () => {
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({})));
    render(<MemoryRouter><EntityJevReadinessCard /></MemoryRouter>);
    await screen.findByText('No scheduled result yet.');
  });

  it('treats a malformed payload the same as no facts, without crashing', async () => {
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ [readinessId]: { version: '0.1.0' /* no timestamp/facts */ } })));
    render(<MemoryRouter><EntityJevReadinessCard /></MemoryRouter>);
    await screen.findByText('No scheduled result yet.');
  });

  it('renders an error, not the quiet notice, for a real fetch failure', async () => {
    mocks.fetch.mockResolvedValue(new Response('{}', { status: 500 }));
    render(<MemoryRouter><EntityJevReadinessCard /></MemoryRouter>);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('HTTP 500');
  });

  it('renders the honest aggregate evidence, counts, caption, and the standing disclaimer — no per-check rows are invented', async () => {
    mocks.fetch.mockResolvedValue(factsResponse(readinessId, {
      fetchStatus: 'fetched', evaluationStatus: 'evaluated', evidenceStatus: 'review',
      passCount: 2, reviewCount: 1, attentionCount: 1, checkCount: 4, evaluatedCheckCount: 4, coverage: 1,
      model: 'jev-1.13.0', source: 'https://docs.example.test/runbook.md', evaluatedAt: new Date().toISOString(), errorCode: '',
    }));
    render(<MemoryRouter><EntityJevReadinessCard /></MemoryRouter>);
    await screen.findByText('Needs review');
    expect(screen.getByText(/4 of 4 checks evaluated/)).toBeTruthy();
    expect(screen.getByText(/2 clear/)).toBeTruthy();
    expect(screen.getByText(/1 attention/)).toBeTruthy();
    expect(screen.getByText(/negative finding/i)).toBeTruthy();
    expect(screen.getByText(/Evaluated .* · jev-1\.13\.0/)).toBeTruthy();
  });

  it('marks a result older than 7 days as stale', async () => {
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    mocks.fetch.mockResolvedValue(factsResponse(readinessId, { evaluationStatus: 'evaluated', evidenceStatus: 'pass', passCount: 1, reviewCount: 0, attentionCount: 0, checkCount: 1, evaluatedCheckCount: 1, coverage: 1, model: 'jev-1.13.0' }, old));
    render(<MemoryRouter><EntityJevReadinessCard /></MemoryRouter>);
    await screen.findByText(/more than 7 days old/);
  });

  it('shows a not-evaluated message honestly, without a fabricated evidence status', async () => {
    mocks.fetch.mockResolvedValue(factsResponse(readinessId, { evaluationStatus: 'not-evaluated', evidenceStatus: 'not-evaluated', passCount: 0, reviewCount: 0, attentionCount: 0, checkCount: 0, evaluatedCheckCount: 0, coverage: 0, model: 'jev-1.13.0', errorCode: 'source-not-configured' }));
    render(<MemoryRouter><EntityJevReadinessCard /></MemoryRouter>);
    await screen.findByText(/Not evaluated yet: source-not-configured/);
    expect(screen.getByText(/Checked .* · jev-1\.13\.0/)).toBeTruthy();
    expect(screen.queryByText(/^Evaluated /)).toBeNull();
  });

  it('never issues an /evaluate request', async () => {
    mocks.fetch.mockResolvedValue(factsResponse(readinessId, { evaluationStatus: 'evaluated', evidenceStatus: 'pass', passCount: 1, reviewCount: 0, attentionCount: 0, checkCount: 1, evaluatedCheckCount: 1, coverage: 1, model: 'jev-1.13.0' }));
    render(<MemoryRouter><EntityJevReadinessCard /></MemoryRouter>);
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalled());
    expect(mocks.fetch.mock.calls.some(([url]) => String(url).includes('/evaluate'))).toBe(false);
  });
});

describe('EntityJevOwnerSuggestionCard', () => {
  it('renders nothing while loading, so an ordinary owned entity never shows an empty card shell', () => {
    mocks.fetch.mockReturnValue(new Promise(() => {})); // never resolves within this test
    const view = render(<MemoryRouter><EntityJevOwnerSuggestionCard /></MemoryRouter>);
    expect(view.container.textContent).toBe('');
    expect(screen.queryByRole('article')).toBeNull();
  });

  it('renders nothing when there is no fact row for this entity (a real owner produces no row)', async () => {
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({})));
    const view = render(<MemoryRouter><EntityJevOwnerSuggestionCard /></MemoryRouter>);
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalled());
    expect(view.container.textContent).toBe('');
    expect(screen.queryByRole('article')).toBeNull();
  });

  it('still shows the quiet Tech Insights notice once loading resolves to "absent", even with no fact row yet', async () => {
    mocks.discovery.mockRejectedValue(new Error('absent'));
    render(<MemoryRouter><EntityJevOwnerSuggestionCard /></MemoryRouter>);
    await screen.findByText(/Scheduled checks are not set up/);
  });

  it('still shows an error frame once loading resolves to a real fetch failure', async () => {
    mocks.fetch.mockResolvedValue(new Response('{}', { status: 500 }));
    render(<MemoryRouter><EntityJevOwnerSuggestionCard /></MemoryRouter>);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('HTTP 500');
  });

  it('reports "No owner is set" for a live-unowned entity, with the suggestion link, confidence, and the standing disclaimer', async () => {
    mocks.entity = { ...mocks.entity, spec: { owner: 'unknown' } };
    mocks.fetch.mockResolvedValue(factsResponse(ownerId, ownerFacts({
      selection: 'unowned', checkedOwner: 'unknown', suggestedOwnerRef: 'group:default/payments-team', suggestedOwnerTitle: 'Payments team',
      confidence: 0.92, needsReview: false, candidateCount: 3,
    })));
    render(<MemoryRouter><EntityJevOwnerSuggestionCard /></MemoryRouter>);
    await screen.findByText('No owner is set.');
    const link = screen.getByRole('link', { name: 'Open Payments team in catalog →' });
    expect(link.getAttribute('href')).toBe('/catalog/default/group/payments-team');
    expect(screen.getByText(/High confidence \(92%\)/)).toBeTruthy();
    expect(screen.queryByText('This suggestion needs review.')).toBeNull();
    expect(screen.getByText(/does not change the entity's owner/)).toBeTruthy();
  });

  it('reports "No owner is set" even when the row was computed for a different unowned form than the live owner', async () => {
    // The row was written while the owner was 'guests'; the reader has since cleared it
    // entirely. Both are "no real owner" under the shared rule, so the message is still
    // accurate — it must not be suppressed just because checkedOwner !== the live value.
    mocks.entity = { ...mocks.entity, spec: { owner: '' } };
    mocks.fetch.mockResolvedValue(factsResponse(ownerId, ownerFacts({ selection: 'unowned', checkedOwner: 'guests' })));
    render(<MemoryRouter><EntityJevOwnerSuggestionCard /></MemoryRouter>);
    await screen.findByText('No owner is set.');
  });

  it('reports a dangling group owner once a LIVE catalog lookup confirms it still does not exist, never from the stored row alone', async () => {
    mocks.entity = { ...mocks.entity, spec: { owner: 'group:default/ghost-team' } };
    mocks.fetch.mockResolvedValue(factsResponse(ownerId, ownerFacts({
      selection: 'owner-not-found', checkedOwner: 'group:default/ghost-team', suggestedOwnerRef: '', suggestedOwnerTitle: '',
      confidence: 0, needsReview: true, candidateCount: 2,
    })));
    mocks.getEntityByRef.mockResolvedValue(undefined); // confirmed: the Group still does not exist
    render(<MemoryRouter><EntityJevOwnerSuggestionCard /></MemoryRouter>);
    await waitFor(() => expect(mocks.getEntityByRef).toHaveBeenCalledWith('group:default/ghost-team'));
    await screen.findByText('Owner group:default/ghost-team does not exist in the catalog.');
    expect(screen.getByText('Jev could not single out a team from the catalog.')).toBeTruthy();
    expect(screen.getByText('This suggestion needs review.')).toBeTruthy();
  });

  it('renders nothing while the live Group-existence check is in flight', async () => {
    mocks.entity = { ...mocks.entity, spec: { owner: 'group:default/ghost-team' } };
    mocks.fetch.mockResolvedValue(factsResponse(ownerId, ownerFacts({ selection: 'owner-not-found', checkedOwner: 'group:default/ghost-team' })));
    // mocks.getEntityByRef defaults (see beforeEach) to a promise that never resolves.
    const view = render(<MemoryRouter><EntityJevOwnerSuggestionCard /></MemoryRouter>);
    await waitFor(() => expect(mocks.getEntityByRef).toHaveBeenCalled());
    expect(view.container.textContent).toBe('');
  });

  it('renders nothing (never asserts a stale claim) when the Group has since been created', async () => {
    mocks.entity = { ...mocks.entity, spec: { owner: 'group:default/ghost-team' } };
    mocks.fetch.mockResolvedValue(factsResponse(ownerId, ownerFacts({ selection: 'owner-not-found', checkedOwner: 'group:default/ghost-team' })));
    mocks.getEntityByRef.mockResolvedValue({ apiVersion: 'backstage.io/v1alpha1', kind: 'Group', metadata: { namespace: 'default', name: 'ghost-team' } });
    const view = render(<MemoryRouter><EntityJevOwnerSuggestionCard /></MemoryRouter>);
    await waitFor(() => expect(mocks.getEntityByRef).toHaveBeenCalled());
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(view.container.textContent).toBe('');
  });

  it('renders nothing (never guesses) when the live Group-existence lookup itself fails', async () => {
    mocks.entity = { ...mocks.entity, spec: { owner: 'group:default/ghost-team' } };
    mocks.fetch.mockResolvedValue(factsResponse(ownerId, ownerFacts({ selection: 'owner-not-found', checkedOwner: 'group:default/ghost-team' })));
    mocks.getEntityByRef.mockRejectedValue(new Error('catalog unavailable'));
    const view = render(<MemoryRouter><EntityJevOwnerSuggestionCard /></MemoryRouter>);
    await waitFor(() => expect(mocks.getEntityByRef).toHaveBeenCalled());
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(view.container.textContent).toBe('');
  });

  it('never performs a live Group-existence check for the "no owner is set" case (nothing to verify)', async () => {
    mocks.entity = { ...mocks.entity, spec: { owner: 'unknown' } };
    mocks.fetch.mockResolvedValue(factsResponse(ownerId, ownerFacts({ selection: 'unowned', checkedOwner: 'unknown' })));
    render(<MemoryRouter><EntityJevOwnerSuggestionCard /></MemoryRouter>);
    await screen.findByText('No owner is set.');
    expect(mocks.getEntityByRef).not.toHaveBeenCalled();
  });

  it('renders nothing for a stale row: a real owner now set that the row was never computed for', async () => {
    // The row says owner-not-found for 'group:default/ghost-team', but the entity now has a
    // real, different owner — the row is stale and must not be shown as if it still applied.
    mocks.entity = { ...mocks.entity, spec: { owner: 'group:default/platform' } };
    mocks.fetch.mockResolvedValue(factsResponse(ownerId, ownerFacts({ selection: 'owner-not-found', checkedOwner: 'group:default/ghost-team' })));
    const view = render(<MemoryRouter><EntityJevOwnerSuggestionCard /></MemoryRouter>);
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalled());
    expect(view.container.textContent).toBe('');
  });

  it('shows why no suggestion exists yet, for an entity that was selected but not evaluated', async () => {
    mocks.fetch.mockResolvedValue(factsResponse(ownerId, ownerFacts({
      evaluationStatus: 'not-evaluated', selection: 'unowned', reason: 'jev-not-configured', needsReview: false,
    })));
    render(<MemoryRouter><EntityJevOwnerSuggestionCard /></MemoryRouter>);
    await screen.findByText(/Jev has not produced a suggestion yet \(jev-not-configured\)/);
    expect(screen.getByText(/^Checked /)).toBeTruthy();
    expect(screen.queryByText(/^Evaluated /)).toBeNull();
  });

  it('treats an unknown/malformed fact payload (missing selection) as no row, rendering nothing rather than crashing', async () => {
    mocks.fetch.mockResolvedValue(factsResponse(ownerId, { unexpected: 'shape' }));
    const view = render(<MemoryRouter><EntityJevOwnerSuggestionCard /></MemoryRouter>);
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalled());
    expect(view.container.textContent).toBe('');
  });

  it('honours a custom unownedValues prop the same way the retriever would', async () => {
    mocks.entity = { ...mocks.entity, spec: { owner: 'team-nobody' } };
    mocks.fetch.mockResolvedValue(factsResponse(ownerId, ownerFacts({ selection: 'unowned', checkedOwner: 'team-nobody' })));
    render(<MemoryRouter><EntityJevOwnerSuggestionCard unownedValues={['team-nobody']} /></MemoryRouter>);
    await screen.findByText('No owner is set.');
  });

  it('never issues an /evaluate request', async () => {
    mocks.fetch.mockResolvedValue(factsResponse(ownerId, ownerFacts()));
    render(<MemoryRouter><EntityJevOwnerSuggestionCard /></MemoryRouter>);
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalled());
    expect(mocks.fetch.mock.calls.some(([url]) => String(url).includes('/evaluate'))).toBe(false);
  });
});
