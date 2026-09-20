import { useEffect, useState } from 'react';
import { Box, Button, Card, CardContent, CardHeader, Divider, TextField, Typography } from '@material-ui/core';
import { Alert } from '@material-ui/lab';
import { Link } from 'react-router-dom';
import { useApi } from '@backstage/core-plugin-api';
import { catalogApiRef } from '@backstage/plugin-catalog-react';
import { parseEntityRef } from '@backstage/catalog-model';
import { workflows, type Candidate, type EvaluationRequest, type EvaluationResult } from '@namayasai/backstage-plugin-jev-operations-support-common';
import { FindingList } from './Findings';
import { LiveSwitch } from './LiveSwitch';
import { useLiveEvaluation, useLivePreference, type EvaluateOptions } from './useLiveEvaluation';
import { useJevEvaluate } from './useJevEvaluate';
import { loadCatalogCandidates } from './catalogCandidates';

const templatesPrompt = workflows.find(w => w.id === 'templates')!.prompt;

export interface JevTemplateAdvisorProps {
  /** Where a recommended template's creation page lives. Default: the stock Scaffolder route. */
  templateHref?: (ref: { namespace: string; name: string }) => string;
  liveDelayMs?: number;
  /** Override for tests; defaults to the shared `/evaluate` call. */
  evaluate?: (request: EvaluationRequest, options?: EvaluateOptions) => Promise<EvaluationResult>;
  /** `false` forces automatic sends off for this component regardless of the reader's preference; omitted or `true` follows the reader's preference. */
  live?: boolean;
}

function defaultTemplateHref({ namespace, name }: { namespace: string; name: string }): string {
  return `/create/templates/${namespace}/${name}`;
}

/**
 * A card that recommends a catalog `Template` for what the reader describes, using the
 * `templates` workflow. Deliberately has no dependency on scaffolder packages: it only
 * needs the catalog (for the shortlist) and a link to the template's own creation page.
 */
export function JevTemplateAdvisor({ templateHref = defaultTemplateHref, liveDelayMs, evaluate: evaluateOverride, live: liveProp }: JevTemplateAdvisorProps) {
  const catalog = useApi(catalogApiRef);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [catalogState, setCatalogState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [catalogError, setCatalogError] = useState('');
  const [text, setText] = useState('');
  const [preference, setLive] = useLivePreference();
  const forcedOff = liveProp === false;
  const live = liveProp !== false && preference;
  const defaultEvaluate = useJevEvaluate();
  const evaluate = evaluateOverride ?? defaultEvaluate;

  useEffect(() => {
    let mounted = true;
    loadCatalogCandidates(catalog, 'templates', '').then(values => {
      if (!mounted) return;
      setCandidates(values);
      setCatalogState('ready');
    }).catch(reason => {
      if (!mounted) return;
      setCatalogError(reason instanceof Error ? reason.message : 'The catalog could not be loaded.');
      setCatalogState('error');
    });
    return () => { mounted = false; };
  }, [catalog]);

  const check = useLiveEvaluation({ evaluate, workflow: 'templates', text, candidates, live, delayMs: liveDelayMs, paused: catalogState !== 'ready' });
  const recommendation = check.result?.findings.find(finding => finding.id === 'recommendation');
  // A real candidate is attached only when Jev chose one; "none" (or an uncertain answer that
  // still resolves to the literal string "none") means no listed template fits.
  const templateRef = recommendation?.candidate?.entityRef ? tryParseRef(recommendation.candidate.entityRef) : undefined;

  return <Card component="article" aria-label="Template advisor">
    <CardHeader title="Which template fits?" subheader="Describe what you are building; Jev recommends a template from this catalog's registered templates."
      titleTypographyProps={{ variant: 'h5', component: 'h2' }}
      action={<LiveSwitch live={live} onChange={setLive} forcedOff={forcedOff} style={{ margin: '8px 8px 0 0' }} />} />
    <Divider />
    <CardContent>
      {catalogState === 'error' && <Alert severity="error" style={{ marginBottom: 16 }}>{catalogError}</Alert>}
      {catalogState === 'loading' && <Typography variant="body2" color="textSecondary">Loading templates from the catalog…</Typography>}
      {catalogState === 'ready' && !candidates.length && <Typography variant="body2" color="textSecondary">No templates are registered in the catalog.</Typography>}
      {catalogState === 'ready' && Boolean(candidates.length) && <>
        <TextField id="jev-template-advisor" label="What are you building?" variant="outlined" fullWidth multiline minRows={4} maxRows={12} placeholder={templatesPrompt} value={text} error={check.overLimit} onChange={e => setText(e.target.value)} />
        <Box display="flex" justifyContent="flex-end" mt={1} mb={2}>
          <Button variant={live ? 'outlined' : 'contained'} color="primary" size="small" disabled={check.busy || check.overLimit} onClick={check.checkNow}>{check.busy ? 'Checking…' : 'Check now'}</Button>
        </Box>
        {check.error && <Alert severity="error" style={{ marginBottom: 16 }}>{check.error}</Alert>}
        {check.result && <>
          <FindingList findings={check.result.findings} candidates={check.resultCandidates} stale={check.stale} />
          {recommendation && (recommendation.candidate
            ? (templateRef
              ? <Box mt={2}><Link to={templateHref(templateRef)}>Create with {recommendation.candidate.title} →</Link></Box>
              : <Typography variant="body2" color="textSecondary" style={{ marginTop: 16 }}>Jev suggested {recommendation.candidate.title}, but its catalog reference could not be resolved.</Typography>)
            : <Typography variant="body2" color="textSecondary" style={{ marginTop: 16 }}>No listed template fits what you described.</Typography>)}
        </>}
      </>}
    </CardContent>
  </Card>;
}

function tryParseRef(entityRef: string): { namespace: string; name: string } | undefined {
  try { const ref = parseEntityRef(entityRef); return { namespace: ref.namespace, name: ref.name }; }
  catch { return undefined; }
}
