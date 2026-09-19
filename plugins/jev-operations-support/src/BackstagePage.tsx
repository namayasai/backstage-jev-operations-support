import { useApi, useRouteRef, discoveryApiRef, fetchApiRef } from '@backstage/core-plugin-api';
import { catalogApiRef, useEntity, entityRouteRef } from '@backstage/plugin-catalog-react';
import { stringifyEntityRef, parseEntityRef } from '@backstage/catalog-model';
import { Link } from 'react-router-dom';
import type { EvaluationRequest, EvaluationResult, WorkflowId } from '@namayasai/backstage-plugin-jev-operations-support-common';
import { JevWorkbench } from './Workbench';

export function JevPage({ initialText }: { initialText?: string }) {
  const discovery = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);
  const catalog = useApi(catalogApiRef);
  const entityRoute = useRouteRef(entityRouteRef);
  async function evaluate(input: EvaluationRequest): Promise<EvaluationResult> {
    const url = await discovery.getBaseUrl('jev-operations-support');
    const response = await fetchApi.fetch(`${url}/evaluate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? `Evaluation failed (HTTP ${response.status}).`);
    return data;
  }
  async function loadCandidates(workflow: WorkflowId, term: string) {
    const kind = workflow === 'templates' ? 'Template' : workflow === 'ownership' ? 'Group' : undefined;
    const result = await catalog.queryEntities({ limit: 20, ...(kind ? { filter: { kind } } : {}), ...(term.trim() ? { fullTextFilter: { term: term.trim() } } : {}) });
    return result.items.map(entity => ({
      id: stringifyEntityRef(entity), entityRef: stringifyEntityRef(entity),
      title: (entity.metadata.title ?? entity.metadata.name).slice(0, 200),
      description: [entity.metadata.description, entity.kind, ...(entity.metadata.tags ?? [])].filter(Boolean).join(' · ').slice(0, 1500),
    }));
  }
  return <JevWorkbench evaluate={evaluate} loadCandidates={loadCandidates} initialText={initialText} renderCandidateLink={candidate => {
    try { const ref = parseEntityRef(candidate.entityRef!); return <Link to={entityRoute({ ...ref, kind: ref.kind.toLocaleLowerCase('en-US') })}>Open {candidate.title} in catalog →</Link>; }
    catch { return <code>{candidate.entityRef}</code>; }
  }} />;
}

/** Entity context seeds a workbench; paste the actual runbook before checking readiness. */
export function EntityJevContent() {
  const { entity } = useEntity();
  return <JevPage key={stringifyEntityRef(entity)} initialText={`Service: ${stringifyEntityRef(entity)}\n${entity.metadata.description ?? ''}\n\nPaste the relevant runbook or TechDocs excerpt here.`} />;
}
