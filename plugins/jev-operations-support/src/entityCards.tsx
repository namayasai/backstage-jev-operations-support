import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, Divider, Typography } from '@material-ui/core';
import { Alert, Skeleton } from '@material-ui/lab';
import { Link } from 'react-router-dom';
import { useApi, useRouteRef, discoveryApiRef, fetchApiRef } from '@backstage/core-plugin-api';
import { useEntity, entityRouteRef, catalogApiRef } from '@backstage/plugin-catalog-react';
import { parseEntityRef, stringifyEntityRef } from '@backstage/catalog-model';
import { defaultUnownedOwnerValues, isUnownedOwner, negativeFindingDisclaimer, type Finding } from '@namayasai/backstage-plugin-jev-operations-support-common';
import { FindingCounts } from './Findings';

/**
 * These two cards are read-only: they show the *latest scheduled* Tech Insights result for
 * the current entity, produced on its own cadence by the optional
 * `@namayasai/backstage-plugin-jev-operations-support-tech-insights` module. Neither card
 * triggers an evaluation — there is no Live switch and no "Check now" here, unlike the
 * workbench in `BackstagePage.tsx`. Reading a stale or missing result is always safe; nothing
 * a reader does on this card sends anything to Jev.
 *
 * These retriever ids must match `jevTechInsightsFactRetrieverId` and
 * `jevOwnerSuggestionFactRetrieverId` in the tech-insights module
 * (`plugins/jev-operations-support-tech-insights/src/index.ts`). They are duplicated as
 * string literals rather than imported, because that package is backend-only (it pulls in
 * `@backstage-community/plugin-tech-insights-node`, the catalog client, etc.) and this
 * frontend package must not depend on it, or on the Tech Insights frontend plugin.
 */
const readinessFactRetrieverId = 'jevTechInsightsFactRetriever';
const ownerSuggestionFactRetrieverId = 'jevOwnerSuggestionFactRetriever';

const staleAfterMs = 7 * 24 * 60 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Every fact this card reads is visible to anyone with the Tech Insights `read` permission,
 * independent of whether that reader could otherwise see the referenced entities through
 * catalog permissions. In particular, the owner card's suggestion can name a Group (its ref
 * and title) that the viewer is not themselves permitted to read in the catalog — Tech
 * Insights facts carry no catalog-permission filtering of their own.
 *
 * The shape returned by the Tech Insights backend's `GET /facts/latest?entity=...&ids[0]=...`
 * route: a map keyed by fact retriever id, each with `timestamp`, `version`, and `facts`.
 * Verified against `@backstage-community/plugin-tech-insights-common`'s
 * `TechInsightsClient.getFacts` (`node_modules/@backstage-community/plugin-tech-insights-common/dist/client/TechInsightsClient.esm.js`,
 * which builds exactly this path and query with `qs.stringify({ entity, ids })` — `ids` as a
 * single-element array serializes to `ids[0]=<value>`, not `ids=<value>`, under `qs`'s default
 * array format) and its `InsightFacts` response type
 * (`node_modules/@backstage-community/plugin-tech-insights-common/dist/index.d.ts`). This card
 * calls the route directly with `discoveryApiRef`/`fetchApiRef`, building the same query
 * string by hand (see `factsLatestUrl` below) instead of depending on that client (or the Tech
 * Insights frontend plugin), per the no-frontend-dependency requirement.
 */
type FactState<T> =
  | { status: 'loading' }
  /** The Tech Insights backend itself is not reachable: discovery failed, or its route
   * answered 404. Indistinguishable from the reader's point of view — either way, scheduled
   * checks are not set up — so both are shown with the same quiet line. */
  | { status: 'ti-absent' }
  | { status: 'error'; message: string }
  /** The route answered, but has no row for this entity and retriever yet, or the payload
   * did not look like a fact row at all (defensively treated the same as "no facts"). */
  | { status: 'empty' }
  | { status: 'ready'; facts: Record<string, unknown>; timestamp: string };

/**
 * Builds `GET {baseUrl}/facts/latest?entity=<ref>&ids[0]=<factRetrieverId>` byte-for-byte the
 * same way `TechInsightsClient.getFacts` does (see the doc comment on `FactState` above):
 * `qs.stringify({ entity, ids: [factRetrieverId] })` percent-encodes `:`/`/` the same way
 * `encodeURIComponent` does for the plain ref and id strings used here, and always emits the
 * bracketed `ids[0]=` form for a single-element array — never the bare `ids=` form
 * `URLSearchParams.append` would produce.
 */
function factsLatestUrl(baseUrl: string, entityRef: string, factRetrieverId: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/facts/latest?entity=${encodeURIComponent(entityRef)}&ids%5B0%5D=${encodeURIComponent(factRetrieverId)}`;
}

function useLatestFact(factRetrieverId: string): FactState<unknown> {
  const { entity } = useEntity();
  const discovery = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);
  const entityRef = stringifyEntityRef(entity);
  const [state, setState] = useState<FactState<unknown>>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });
    (async () => {
      let baseUrl: string;
      try {
        baseUrl = await discovery.getBaseUrl('tech-insights');
      } catch {
        if (!controller.signal.aborted) setState({ status: 'ti-absent' });
        return;
      }
      let response: Response;
      try {
        response = await fetchApi.fetch(factsLatestUrl(baseUrl, entityRef, factRetrieverId), { signal: controller.signal });
      } catch (error) {
        // An abort (unmount, or a newer entity/retriever superseding this request) is not a
        // failure to report — the component either unmounted or a fresher request is already
        // in flight, either way this stale one is simply dropped.
        if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return;
        setState({ status: 'error', message: 'The Tech Insights backend could not be reached.' });
        return;
      }
      if (response.status === 404) {
        if (!controller.signal.aborted) setState({ status: 'ti-absent' });
        return;
      }
      if (!response.ok) {
        if (!controller.signal.aborted) setState({ status: 'error', message: `Tech Insights returned an error (HTTP ${response.status}).` });
        return;
      }
      let payload: unknown;
      try { payload = await response.json(); } catch { if (!controller.signal.aborted) setState({ status: 'error', message: 'Tech Insights returned a non-JSON response.' }); return; }
      if (controller.signal.aborted) return;
      const entry = isRecord(payload) ? payload[factRetrieverId] : undefined;
      if (!isRecord(entry) || typeof entry.timestamp !== 'string' || !isRecord(entry.facts)) {
        setState({ status: 'empty' });
        return;
      }
      setState({ status: 'ready', facts: entry.facts, timestamp: entry.timestamp });
    })();
    return () => controller.abort();
  }, [discovery, fetchApi, entityRef, factRetrieverId]);

  return state;
}

/**
 * Whether a catalog Group ref currently exists, checked live (not from any stored fact).
 * `undefined` skips the check entirely (returns `'checking'` forever — the caller is expected
 * to pass `undefined` only when it does not intend to use the result).
 *
 * `CatalogApi.getEntityByRef` takes no `AbortSignal` (`CatalogRequestOptions` carries only
 * `token`), so this cannot cancel the in-flight network request the way `useLatestFact` does;
 * it instead ignores a response that arrives after the effect was cleaned up (unmount, or a
 * newer `ref` superseding this one), the same "abort" in spirit even without a true cancelled
 * request.
 */
type GroupExistenceState = 'checking' | 'exists' | 'missing' | 'error';

function useGroupExistence(ref: string | undefined): GroupExistenceState {
  const catalogApi = useApi(catalogApiRef);
  const [state, setState] = useState<GroupExistenceState>('checking');

  useEffect(() => {
    if (!ref) {
      setState('checking');
      return undefined;
    }
    let active = true;
    setState('checking');
    catalogApi.getEntityByRef(ref).then(
      entity => { if (active) setState(entity ? 'exists' : 'missing'); },
      () => { if (active) setState('error'); },
    );
    return () => { active = false; };
  }, [catalogApi, ref]);

  return state;
}

function isStale(timestamp: string): boolean {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) && Date.now() - parsed > staleAfterMs;
}

function formatTimestamp(timestamp: string): string {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return 'an unknown time';
  const diffMs = Date.now() - parsed;
  const diffMinutes = Math.round(diffMs / 60_000);
  if (diffMinutes < 1) return 'just now';
  if (diffMinutes < 60) return `${diffMinutes} minute${diffMinutes === 1 ? '' : 's'} ago`;
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
  const diffDays = Math.round(diffHours / 24);
  return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
}

/** The quiet, non-error line shown whenever the Tech Insights backend or module is absent. */
function TechInsightsAbsentNotice() {
  return <Typography variant="body2" color="textSecondary">Scheduled checks are not set up: install the Tech Insights backend and the Jev Tech Insights module.</Typography>;
}

function str(raw: Record<string, unknown>, key: string): string {
  return typeof raw[key] === 'string' ? (raw[key] as string) : '';
}
function num(raw: Record<string, unknown>, key: string): number {
  const value = raw[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

// ---------------------------------------------------------------------------------------
// Readiness card
// ---------------------------------------------------------------------------------------

type ReadinessFacts = {
  fetchStatus: string;
  evaluationStatus: string;
  evidenceStatus: string;
  passCount: number;
  reviewCount: number;
  attentionCount: number;
  checkCount: number;
  evaluatedCheckCount: number;
  coverage: number;
  model: string;
  errorCode: string;
};

/** Reads exactly what `jevTechInsightsFactSchema` stores
 * (`plugins/jev-operations-support-tech-insights/src/index.ts`) — an aggregate evidence
 * status and check counts, never a per-check breakdown, since the retriever does not store
 * one. An unknown or malformed payload parses to `undefined` rather than throwing or
 * inventing fields. */
function parseReadinessFacts(raw: Record<string, unknown>): ReadinessFacts | undefined {
  if (typeof raw.evaluationStatus !== 'string' || typeof raw.evidenceStatus !== 'string') return undefined;
  return {
    fetchStatus: str(raw, 'fetchStatus'),
    evaluationStatus: str(raw, 'evaluationStatus'),
    evidenceStatus: str(raw, 'evidenceStatus'),
    passCount: num(raw, 'passCount'),
    reviewCount: num(raw, 'reviewCount'),
    attentionCount: num(raw, 'attentionCount'),
    checkCount: num(raw, 'checkCount'),
    evaluatedCheckCount: num(raw, 'evaluatedCheckCount'),
    coverage: num(raw, 'coverage'),
    model: str(raw, 'model'),
    errorCode: str(raw, 'errorCode'),
  };
}

const evidenceStatusLabels: Record<string, string> = { pass: 'Clear', review: 'Needs review', attention: 'Attention', 'not-evaluated': 'Not evaluated' };

/** Synthesizes minimal `Finding`s carrying only a `status`, so the shared `FindingCounts`
 * chips can be reused from stored aggregate counts. These are not real per-check findings —
 * the retriever stores no per-check identity — so nothing else about them is rendered. */
function countFindings(facts: ReadinessFacts): Finding[] {
  const make = (status: Finding['status'], count: number): Finding[] => Array.from({ length: count }, (_, index) => ({
    id: `${status}-${index}`, title: '', statement: '', status, value: 0, kind: 'noul', guidance: '',
  }));
  return [...make('pass', facts.passCount), ...make('attention', facts.attentionCount), ...make('review', facts.reviewCount)];
}

/** Latest scheduled readiness result from the opt-in Tech Insights fact retriever. Read-only:
 * no evaluation is triggered from this card. Shows a loading skeleton while the first fetch is
 * in flight — unlike the owner card below, an ordinary entity is expected to have a readiness
 * result, so a brief loading shell is not visual noise for the common case. */
export function EntityJevReadinessCard() {
  const state = useLatestFact(readinessFactRetrieverId);
  return <Card component="article" aria-label="Operational readiness">
    <CardHeader title="Operational readiness" titleTypographyProps={{ variant: 'h5', component: 'h2' }} />
    <Divider />
    <CardContent>
      {state.status === 'loading' && <><Skeleton width="70%" /><Skeleton width="40%" /></>}
      {state.status === 'ti-absent' && <TechInsightsAbsentNotice />}
      {state.status === 'error' && <Alert severity="error">{state.message}</Alert>}
      {state.status === 'empty' && <Typography variant="body2" color="textSecondary">No scheduled result yet.</Typography>}
      {state.status === 'ready' && (() => {
        const facts = parseReadinessFacts(state.facts);
        if (!facts) return <Typography variant="body2" color="textSecondary">No scheduled result yet.</Typography>;
        return <>
          {facts.evaluationStatus === 'evaluated' ? <>
            <Typography variant="body1">{evidenceStatusLabels[facts.evidenceStatus] ?? facts.evidenceStatus}</Typography>
            <Typography variant="caption" color="textSecondary" component="p">
              {facts.evaluatedCheckCount} of {facts.checkCount} checks evaluated ({Math.round(facts.coverage * 100)}% coverage — retrieval coverage, not a confidence score).
            </Typography>
            <FindingCounts findings={countFindings(facts)} />
            <Typography variant="body2" style={{ marginTop: 8 }}>{negativeFindingDisclaimer}</Typography>
          </> : <Typography variant="body2" color="textSecondary">
            Not evaluated yet{facts.errorCode ? `: ${facts.errorCode}` : ''}.
          </Typography>}
          <Typography variant="caption" color="textSecondary" component="p" style={{ marginTop: 8 }}>
            {facts.evaluationStatus === 'evaluated' ? 'Evaluated' : 'Checked'} {formatTimestamp(state.timestamp)} · {facts.model || 'unknown model'}
            {isStale(state.timestamp) ? ' — this result is more than 7 days old.' : ''}
          </Typography>
        </>;
      })()}
    </CardContent>
  </Card>;
}

// ---------------------------------------------------------------------------------------
// Owner suggestion card
// ---------------------------------------------------------------------------------------

type OwnerFacts = {
  evaluationStatus: string;
  /** Why the entity was picked up: 'unowned' | 'owner-not-found'. Always present, evaluated or
   * not — but never trusted on its own to decide what to render; see `EntityJevOwnerSuggestionCard`. */
  selection: string;
  /** Only ever a failure/not-evaluated code; empty when evaluationStatus is 'evaluated'. */
  reason: string;
  /** The raw spec.owner value this row was computed for — compared against the entity's
   * *current* spec.owner to detect a stale row (see `EntityJevOwnerSuggestionCard`). */
  checkedOwner: string;
  suggestedOwnerRef: string;
  suggestedOwnerTitle: string;
  confidence: number;
  needsReview: boolean;
  model: string;
};

/** Reads exactly what `jevOwnerSuggestionFactSchema` stores. An unknown or malformed payload
 * parses to `undefined`. */
function parseOwnerFacts(raw: Record<string, unknown>): OwnerFacts | undefined {
  if (typeof raw.evaluationStatus !== 'string' || typeof raw.selection !== 'string') return undefined;
  return {
    evaluationStatus: raw.evaluationStatus,
    selection: raw.selection,
    reason: str(raw, 'reason'),
    checkedOwner: str(raw, 'checkedOwner'),
    suggestedOwnerRef: str(raw, 'suggestedOwnerRef'),
    suggestedOwnerTitle: str(raw, 'suggestedOwnerTitle'),
    confidence: num(raw, 'confidence'),
    needsReview: raw.needsReview === true,
    model: str(raw, 'model'),
  };
}

/** Words-plus-percent confidence wording, in the same spirit as the shared
 * `formatFindingValue` (an answer read in words, with the percentage alongside rather than
 * standing alone). */
function confidenceWords(confidence: number): string {
  const percent = `${Math.round(confidence * 100)}%`;
  if (confidence >= 0.8) return `High confidence (${percent})`;
  if (confidence >= 0.5) return `Moderate confidence (${percent})`;
  return `Low confidence (${percent})`;
}

function ownerString(entity: { spec?: unknown }): string {
  const spec = entity.spec as Record<string, unknown> | undefined;
  return typeof spec?.owner === 'string' ? spec.owner : '';
}

export interface EntityJevOwnerSuggestionCardProps {
  /** Must match the backend's `jevOperationsSupport.techInsights.ownerSuggestion.unownedValues`
   * when a host overrides it — the card has no way to read backend config, and disagreeing
   * about which entities are unowned would make this card mislabel a stale-but-still-unowned
   * row, or hide a suggestion that is actually still current. Defaults to the same list the
   * retriever itself defaults to. */
  unownedValues?: string[];
}

/**
 * Latest scheduled owner suggestion from the opt-in Tech Insights fact retriever.
 *
 * The "why was this entity picked up" wording is never taken from the stored fact's own
 * `selection`/`reason` on faith: it is re-derived from the entity's *live* `spec.owner` (using
 * the same `isUnownedOwner` rule the retriever itself uses), because the stored row can be
 * stale — the owner may have been set, or changed again, since the row was written. Two cases
 * can render a suggestion:
 * - the live owner is unowned by value right now (regardless of what the row's `selection`
 *   says — a row computed for a *different* unowned form, e.g. one written while the owner was
 *   still empty and now says `guests`, is still an accurate "no owner is set" today), or
 * - the row's `selection` was `owner-not-found`, the live owner is unchanged from
 *   `checkedOwner` (the value the row was actually computed for), **and** a live catalog lookup
 *   (`catalogApiRef.getEntityByRef`, not the stored fact) confirms that Group still does not
 *   exist — a fact row is a scheduled snapshot, so a Group merely *parsing* as the owner and
 *   matching `checkedOwner` is not enough on its own to assert it still does not exist: it may
 *   have been created since the row was written. While that live lookup is in flight, or if it
 *   fails, nothing is asserted — the card renders nothing rather than a claim it cannot back up.
 *
 * Any other live owner — including a real owner that replaced whatever the row was computed
 * for — renders nothing at all, the same as no fact row existing.
 */
export function EntityJevOwnerSuggestionCard({ unownedValues = [...defaultUnownedOwnerValues] }: EntityJevOwnerSuggestionCardProps = {}) {
  const { entity } = useEntity();
  const entityRoute = useRouteRef(entityRouteRef);
  const state = useLatestFact(ownerSuggestionFactRetrieverId);
  const liveOwner = ownerString(entity);
  const liveOwnerIsUnowned = isUnownedOwner(liveOwner, unownedValues);
  const facts = state.status === 'ready' ? parseOwnerFacts(state.facts) : undefined;
  // A live existence check is only needed for the one case that would otherwise assert a
  // catalog fact from a possibly-stale row: an unchanged owner-not-found row, for an owner that
  // is not (by value) unowned. Computed unconditionally so the hook below is always called with
  // a stable argument identity across renders that do not need it (undefined skips the check).
  const needsGroupExistenceCheck = Boolean(facts && !liveOwnerIsUnowned && facts.selection === 'owner-not-found' && liveOwner === facts.checkedOwner);
  const groupExistence = useGroupExistence(needsGroupExistenceCheck ? liveOwner : undefined);

  // No shell flash for the common case (an already-owned entity, which never gets a fact row):
  // unlike the readiness card, this card renders nothing at all while loading, so a page full
  // of ordinary owned entities never briefly shows an empty card frame.
  if (state.status === 'loading') return null;
  if (state.status === 'empty') return null;

  if (state.status === 'ready') {
    if (!facts) return null;

    const rowMatchesLiveOwner = liveOwnerIsUnowned || (facts.selection === 'owner-not-found' && liveOwner === facts.checkedOwner);
    if (!rowMatchesLiveOwner) return null; // the row is stale: the entity's owner moved on since it was computed

    if (needsGroupExistenceCheck) {
      // 'checking': the lookup is in flight — say nothing yet, rather than assert the row's
      // stale claim while it is still being confirmed.
      // 'exists': the Group has been created since the row was written — the row is stale.
      // 'error': the lookup itself failed — never assert a catalog fact we could not confirm.
      // Only 'missing' (the Group still does not exist, confirmed live) proceeds to render.
      if (groupExistence !== 'missing') return null;
    }

    const problemLabel = liveOwnerIsUnowned ? 'No owner is set.' : `Owner ${liveOwner} does not exist in the catalog.`;

    let suggestionLink: JSX.Element | undefined;
    if (facts.suggestedOwnerRef) {
      try {
        const ref = parseEntityRef(facts.suggestedOwnerRef);
        suggestionLink = <Link to={entityRoute({ ...ref, kind: ref.kind.toLocaleLowerCase('en-US') })}>Open {facts.suggestedOwnerTitle || facts.suggestedOwnerRef} in catalog →</Link>;
      } catch {
        suggestionLink = <code>{facts.suggestedOwnerRef}</code>;
      }
    }
    const needsReview = facts.needsReview || !facts.suggestedOwnerRef;
    return <Card component="article" aria-label="Owner suggestion">
      <CardHeader title="Owner suggestion" titleTypographyProps={{ variant: 'h5', component: 'h2' }} />
      <Divider />
      <CardContent>
        <Typography variant="body1">{problemLabel}</Typography>
        {facts.evaluationStatus === 'evaluated' ? <>
          {facts.suggestedOwnerRef
            ? <Typography variant="body1" style={{ marginTop: 8 }}>Suggested owner: {suggestionLink}</Typography>
            : <Typography variant="body2" color="textSecondary" style={{ marginTop: 8 }}>Jev could not single out a team from the catalog.</Typography>}
          {facts.suggestedOwnerRef && <Typography variant="caption" color="textSecondary" component="p">{confidenceWords(facts.confidence)}</Typography>}
          {needsReview && <Typography variant="body2" color="textSecondary" style={{ marginTop: 8 }}>This suggestion needs review.</Typography>}
          <Typography variant="body2" style={{ marginTop: 8 }}>This is a suggestion. It does not change the entity&apos;s owner.</Typography>
        </> : <Typography variant="body2" color="textSecondary" style={{ marginTop: 8 }}>Jev has not produced a suggestion yet{facts.reason ? ` (${facts.reason})` : ''}.</Typography>}
        <Typography variant="caption" color="textSecondary" component="p" style={{ marginTop: 8 }}>
          {facts.evaluationStatus === 'evaluated' ? 'Evaluated' : 'Checked'} {formatTimestamp(state.timestamp)} · {facts.model || 'unknown model'}
          {isStale(state.timestamp) ? ' — this result is more than 7 days old.' : ''}
        </Typography>
      </CardContent>
    </Card>;
  }

  // 'ti-absent' and 'error' still show a card frame — an installation problem is worth saying
  // even on an ordinary owned entity's page — just not the empty-shell loading/no-row states.
  return <Card component="article" aria-label="Owner suggestion">
    <CardHeader title="Owner suggestion" titleTypographyProps={{ variant: 'h5', component: 'h2' }} />
    <Divider />
    <CardContent>
      {state.status === 'ti-absent' && <TechInsightsAbsentNotice />}
      {state.status === 'error' && <Alert severity="error">{state.message}</Alert>}
    </CardContent>
  </Card>;
}
