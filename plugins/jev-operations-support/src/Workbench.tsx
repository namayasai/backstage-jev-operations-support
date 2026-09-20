import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Box, Button, Card, CardContent, CardHeader, CircularProgress, Divider, Grid, IconButton, TextField, Typography, makeStyles } from '@material-ui/core';
import { Alert, ToggleButton, ToggleButtonGroup } from '@material-ui/lab';
import { CloseIcon } from './icons';
import { buildEvaluation, MAX_EVALUATION_BYTES, negativeFindingDisclaimer, workflows, sampleText, sampleCandidates, type Candidate, type EvaluationRequest, type EvaluationResult, type WorkflowId } from '@namayasai/backstage-plugin-jev-operations-support-common';
import { FindingCounts, FindingList, PendingChecks } from './Findings';
import { LiveSwitch } from './LiveSwitch';
import { candidateWorkflows, useLiveEvaluation, useLivePreference, type EvaluateOptions } from './useLiveEvaluation';

export interface TechDocsOptions {
  entityRef: string;
  annotation?: string;
  unsupportedReason?: string;
  load: (relativePath: string) => Promise<string>;
}

export interface WorkbenchProps {
  evaluate: (request: EvaluationRequest, options?: EvaluateOptions) => Promise<EvaluationResult>;
  loadCandidates?: (workflow: WorkflowId, term: string) => Promise<Candidate[]>;
  renderCandidateLink?: (candidate: Candidate) => ReactNode;
  /** The workflows offered here, in order. A single entry hides the selector. */
  workflowIds?: WorkflowId[];
  initialWorkflow?: WorkflowId;
  initialText?: string;
  contextNote?: ReactNode;
  techDocs?: TechDocsOptions;
  demo?: boolean;
  /** `false` forces automatic sends off for this component regardless of the reader's preference; omitted or `true` follows the reader's preference. */
  live?: boolean;
  liveDelayMs?: number;
  /** Whether this workbench is the view the reader is currently looking at. Hidden views send nothing automatically. */
  active?: boolean;
}

const templateExamples: Candidate[] = [
  { id: 'node', title: 'Node.js + PostgreSQL', description: 'HTTP service with Node.js, PostgreSQL migrations, and Kubernetes deployment.' },
  { id: 'static', title: 'Static website', description: 'Static HTML and CSS website hosted on object storage. No server or database.' },
];

const useStyles = makeStyles(theme => ({
  sticky: { [theme.breakpoints.up('md')]: { position: 'sticky', top: theme.spacing(2) } },
  selector: { flexWrap: 'wrap', marginBottom: theme.spacing(2) },
  counter: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
  source: { border: `1px solid ${theme.palette.divider}`, borderRadius: theme.shape.borderRadius, padding: theme.spacing(1.5, 2), marginBottom: theme.spacing(2) },
  sourceRow: { display: 'flex', gap: theme.spacing(1), alignItems: 'center', marginTop: theme.spacing(1) },
  candidate: { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: theme.spacing(1), alignItems: 'start', border: `1px solid ${theme.palette.divider}`, borderRadius: theme.shape.borderRadius, padding: theme.spacing(1.5), marginTop: theme.spacing(1) },
  candidateFields: { display: 'grid', gap: theme.spacing(1) },
  actions: { display: 'flex', gap: theme.spacing(1), alignItems: 'center', flexWrap: 'wrap', marginTop: theme.spacing(2) },
  state: { display: 'flex', alignItems: 'center', gap: theme.spacing(1), minHeight: 24 },
  empty: { border: `1px dashed ${theme.palette.divider}`, borderRadius: theme.shape.borderRadius, padding: theme.spacing(3), textAlign: 'center' },
}));

/**
 * Evidence on the left, Jev's checks on the right. While live, every settled edit is
 * checked automatically; the previous result stays visible, dimmed, until the new one lands.
 */
export function JevWorkbench({ evaluate, loadCandidates, renderCandidateLink, workflowIds, initialWorkflow, initialText, contextNote, techDocs, demo = false, live: liveProp, liveDelayMs, active = true }: WorkbenchProps) {
  const classes = useStyles();
  const offered = useMemo(() => workflows.filter(w => !workflowIds || workflowIds.includes(w.id)), [workflowIds]);
  const [workflow, setWorkflow] = useState<WorkflowId>(initialWorkflow ?? offered[0]?.id ?? 'readiness');
  const [text, setText] = useState(initialText ?? '');
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [catalogTerm, setCatalogTerm] = useState('');
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [sourceError, setSourceError] = useState('');
  const [techDocsPath, setTechDocsPath] = useState('index.html');
  const [techDocsBusy, setTechDocsBusy] = useState(false);
  const [techDocsSource, setTechDocsSource] = useState('');
  const [techDocsNote, setTechDocsNote] = useState('');
  const [preference, setLive] = useLivePreference();
  const forcedOff = liveProp === false;
  const live = liveProp !== false && preference;
  // Switching workflows keeps text the reader wrote, but must not resend it just because the workflow changed.
  const [held, setHeld] = useState(false);
  const catalogRun = useRef(0);
  const techDocsRun = useRef(0);
  const current = workflows.find(w => w.id === workflow)!;
  const needsCandidates = candidateWorkflows.includes(workflow);
  const check = useLiveEvaluation({ evaluate, workflow, text, candidates, live, delayMs: liveDelayMs, paused: catalogBusy || techDocsBusy || !active, hold: held });
  const pendingTitles = useMemo(() => buildEvaluation({ workflow, text: '', candidates: needsCandidates ? candidates : [] }).checks.map(c => c.title || 'Untitled candidate'), [workflow, candidates, needsCandidates]);

  async function fromCatalog(target: WorkflowId, term: string) {
    if (!loadCandidates) return;
    const run = ++catalogRun.current;
    setSourceError(''); setCatalogBusy(true);
    try {
      const values = await loadCandidates(target, term);
      if (run !== catalogRun.current) return;
      setCandidates(values);
      if (!values.length) setSourceError('No catalog entries matched. Try a different filter or add candidates manually.');
    } catch (reason) {
      if (run === catalogRun.current) setSourceError(reason instanceof Error ? reason.message : 'Catalog could not be loaded.');
    } finally {
      if (run === catalogRun.current) setCatalogBusy(false);
    }
  }

  /** `quiet` is the automatic first load: a missing page is normal there, not an error. */
  async function fromTechDocs(quiet = false) {
    if (!techDocs) return;
    if (techDocs.unsupportedReason) { if (!quiet) setSourceError(techDocs.unsupportedReason); return; }
    const run = ++techDocsRun.current;
    setSourceError(''); setTechDocsNote(''); setTechDocsBusy(true);
    try {
      const value = await techDocs.load(techDocsPath);
      if (!value.trim()) throw new Error('The selected TechDocs page has no readable text. Choose another page.');
      if (run !== techDocsRun.current) return;
      setText(value); setTechDocsSource(techDocsPath); setHeld(false);
    } catch (reason) {
      if (run !== techDocsRun.current) return;
      if (quiet) setTechDocsNote('No TechDocs page was loaded automatically. Choose a page, or paste the document below.');
      else setSourceError(reason instanceof Error ? reason.message : 'TechDocs could not be loaded.');
    } finally {
      if (run === techDocsRun.current) setTechDocsBusy(false);
    }
  }

  function loadExample(target: WorkflowId) {
    setSourceError(''); setTechDocsSource(''); setText(sampleText[target]); setHeld(false);
    setCandidates(target === 'templates' ? templateExamples : candidateWorkflows.includes(target) ? sampleCandidates : []);
  }

  function switchWorkflow(target: WorkflowId) {
    catalogRun.current++; setCatalogBusy(false);
    setWorkflow(target); setCandidates([]); setCatalogTerm(''); setSourceError('');
    // An untouched example follows the workflow; text the reader wrote stays with them.
    const untouched = !text.trim() || Object.values(sampleText).includes(text);
    if (untouched && demo) loadExample(target);
    else if (untouched) { setText(''); setTechDocsSource(''); }
    // Reader-written text follows the reader across workflows, but switching must not resend
    // the same text just because the workflow changed: hold it until they act on it again.
    else setHeld(true);
    if (!(untouched && demo) && candidateWorkflows.includes(target)) fromCatalog(target, '');
  }

  // The page opens with its sources already in place: the entity's docs, or the catalog shortlist.
  useEffect(() => {
    if (demo && !initialText) { loadExample(workflow); return; }
    if (techDocs && !initialText) fromTechDocs(true);
    if (needsCandidates) fromCatalog(workflow, '');
    // Runs once per mount; the entity tab remounts this component per entity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sourceBusy = catalogBusy || techDocsBusy;
  const checked = check.result && !check.stale;
  const stateLabel = check.busy ? 'Checking with Jev…'
    // A pending retry after a failure is not "waiting for you to pause": the input is already
    // settled and Jev itself, not the reader, is the reason nothing has been sent yet.
    : check.pending && check.retryAt ? 'Retrying automatically after a failure — or choose Check now'
    : check.pending ? 'Waiting for you to pause…'
    : check.stale ? (live ? 'Out of date' : 'Out of date — live check is off')
    : checked ? `Up to date · ${new Date(check.result!.evaluatedAt).toLocaleTimeString()}`
    : held ? 'Not checked for this workflow yet — edit the text or choose Check now'
    : live ? 'Checks run as you type' : 'Live check is off — choose Check now, or turn on Live to check as you type';

  return <Grid container spacing={3} alignItems="flex-start">
    <Grid item xs={12} md={7}>
      <Card>
        <CardHeader title={current.title} subheader={current.description} titleTypographyProps={{ variant: 'h5', component: 'h2' }} />
        <Divider />
        <CardContent>
          {demo && <Alert severity="warning" role="note" style={{ marginBottom: 16 }}>Demo mode — results are fixed illustrative examples. No API call is made, and your text is not evaluated.</Alert>}
          {offered.length > 1 && <ToggleButtonGroup exclusive size="small" value={workflow} className={classes.selector} aria-label="Decision workflows" onChange={(_, next: WorkflowId | null) => { if (next && next !== workflow) switchWorkflow(next); }}>
            {offered.map(w => <ToggleButton key={w.id} value={w.id}>{w.title}</ToggleButton>)}
          </ToggleButtonGroup>}
          {contextNote && <Box className={classes.source} role="note"><Typography variant="subtitle2">Entity context</Typography><Typography variant="body2" color="textSecondary" component="div">{contextNote}</Typography></Box>}
          {techDocs && <Box className={classes.source}>
            <Typography variant="subtitle2">TechDocs for {techDocs.entityRef}</Typography>
            <Typography variant="caption" color="textSecondary">{techDocs.annotation ? `techdocs-ref: ${techDocs.annotation} (display only) · ` : ''}The page is loaded into the editor below, where you can review or trim it.</Typography>
            <div className={classes.sourceRow}>
              <TextField id="jev-techdocs-path" label="Relative page path" variant="outlined" size="small" fullWidth value={techDocsPath} placeholder="index.html or operations/runbook" disabled={techDocsBusy || Boolean(techDocs.unsupportedReason)} onChange={e => { setTechDocsPath(e.target.value); setSourceError(''); }} onKeyDown={e => { if (e.key === 'Enter') fromTechDocs(); }} />
              <Button variant="outlined" disabled={techDocsBusy || Boolean(techDocs.unsupportedReason)} onClick={() => fromTechDocs()} style={{ whiteSpace: 'nowrap' }}>{techDocsBusy ? 'Loading…' : 'Load page'}</Button>
            </div>
            {techDocs.unsupportedReason && <Typography variant="caption" color="textSecondary" role="status" component="p">{techDocs.unsupportedReason}</Typography>}
            {techDocsNote && !techDocsSource && <Typography variant="caption" color="textSecondary" role="status" component="p">{techDocsNote}</Typography>}
            {techDocsSource && <Typography variant="caption" color="textSecondary" role="status" component="p">Loaded {techDocs.entityRef}/{techDocsSource} ({techDocsSource === 'index.html' ? 'full rendered page' : 'selected page; it may be a partial excerpt'}).</Typography>}
          </Box>}
          <TextField id="jev-context" label="Context" variant="outlined" fullWidth multiline minRows={needsCandidates ? 4 : 12} maxRows={28} value={text} placeholder={current.prompt} onChange={e => { setText(e.target.value); setTechDocsSource(''); setHeld(false); }} error={check.overLimit} />
          <Box display="flex" justifyContent="space-between" flexWrap="wrap" mt={0.5}>
            <Typography variant="caption" color="textSecondary">{current.prompt}</Typography>
            <Typography variant="caption" color={check.overLimit ? 'error' : 'textSecondary'} className={classes.counter}>{text.length.toLocaleString()} / 16,000 chars · {check.requestBytes.toLocaleString()} / {MAX_EVALUATION_BYTES.toLocaleString()} bytes</Typography>
          </Box>
          {needsCandidates && <Box mt={3}>
            <Box display="flex" justifyContent="space-between" alignItems="baseline">
              <Typography variant="subtitle1" component="h3">Candidates</Typography>
              <Typography variant="caption" color="textSecondary" className={classes.counter}>{candidates.length} / 20</Typography>
            </Box>
            <Typography variant="caption" color="textSecondary">Jev judges only this shortlist, not the entire catalog. Descriptions are sent with your context.</Typography>
            {loadCandidates && <div className={classes.sourceRow}>
              <TextField id="jev-catalog-filter" label="Catalog filter" variant="outlined" size="small" fullWidth placeholder="Optional keyword, e.g. payments" value={catalogTerm} onChange={e => setCatalogTerm(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') fromCatalog(workflow, catalogTerm); }} />
              <Button variant="outlined" disabled={catalogBusy} onClick={() => fromCatalog(workflow, catalogTerm)} style={{ whiteSpace: 'nowrap' }}>{catalogBusy ? 'Loading…' : 'Load from catalog'}</Button>
            </div>}
            {candidates.map((c, i) => <div className={classes.candidate} key={c.id}>
              <div className={classes.candidateFields}>
                <TextField variant="outlined" size="small" fullWidth value={c.title} inputProps={{ 'aria-label': `Candidate ${i + 1} title`, maxLength: 200 }} onChange={e => { setCandidates(old => old.map((x, j) => j === i ? { ...x, title: e.target.value } : x)); setHeld(false); }} />
                <TextField variant="outlined" size="small" fullWidth multiline maxRows={4} value={c.description} inputProps={{ 'aria-label': `Candidate ${i + 1} description`, maxLength: 1500 }} onChange={e => { setCandidates(old => old.map((x, j) => j === i ? { ...x, description: e.target.value } : x)); setHeld(false); }} />
              </div>
              <IconButton size="small" aria-label={`Remove candidate ${i + 1}`} onClick={() => { setCandidates(old => old.filter((_, j) => j !== i)); setHeld(false); }}><CloseIcon fontSize="small" /></IconButton>
            </div>)}
            <div className={classes.actions}><Button size="small" disabled={candidates.length >= 20} onClick={() => { setCandidates(old => [...old, { id: crypto.randomUUID(), title: '', description: '' }]); setHeld(false); }}>+ Add candidate</Button></div>
          </Box>}
          {sourceError && <Alert severity="error" style={{ marginTop: 16 }}>{sourceError}</Alert>}
          <div className={classes.actions}>
            <Button size="small" onClick={() => loadExample(workflow)}>Load example input</Button>
            <Typography variant="caption" color="textSecondary">{demo ? 'Fixtures stay in your browser.' : 'Checks send this context and candidate descriptions to TypeSafe through your Backstage backend.'}</Typography>
          </div>
        </CardContent>
      </Card>
    </Grid>
    <Grid item xs={12} md={5} className={classes.sticky}>
      <Card>
        <CardHeader title={workflow === 'search' ? 'Ranked candidates' : 'Jev checks'} titleTypographyProps={{ variant: 'h5', component: 'h2' }}
          action={<LiveSwitch live={live} onChange={setLive} forcedOff={forcedOff} style={{ margin: '8px 8px 0 0' }} />} />
        <Divider />
        <CardContent>
          <Box display="flex" justifyContent="space-between" alignItems="center" flexWrap="wrap" mb={2} style={{ gap: 8 }}>
            <div className={classes.state} role="status">{check.busy && <CircularProgress size={14} />}<Typography variant="body2" color="textSecondary">{stateLabel}</Typography></div>
            <Button variant={live ? 'outlined' : 'contained'} color="primary" size="small" disabled={check.busy || sourceBusy || check.overLimit} onClick={() => { setHeld(false); check.checkNow(); }}>{check.busy ? 'Checking…' : 'Check now'}</Button>
          </Box>
          {check.error && <Alert severity="error" style={{ marginBottom: 16 }}>{check.error}</Alert>}
          {check.result ? <>
            {check.result.mode === 'demo' && !demo && <Alert severity="warning" role="note" style={{ marginBottom: 16 }}>Backend demo mode is enabled. These fixed results do not evaluate your input.</Alert>}
            <Box display="flex" justifyContent="space-between" alignItems="center" flexWrap="wrap" mb={1.5} style={{ gap: 8 }}>
              <FindingCounts findings={check.result.findings} />
              <Typography variant="caption" color="textSecondary">{check.result.mode === 'demo' ? 'ILLUSTRATIVE RESULT' : check.result.model}</Typography>
            </Box>
            <FindingList findings={check.result.findings} candidates={check.resultCandidates} renderCandidateLink={renderCandidateLink} stale={check.stale} />
            <Typography variant="caption" color="textSecondary" component="p" style={{ marginTop: 16 }}>{check.result.needsReview ? 'Review the highlighted items with the responsible team.' : 'Verify recommendations against the original sources.'} {negativeFindingDisclaimer}</Typography>
          </> : pendingTitles.length ? <>
            <PendingChecks titles={pendingTitles} busy={check.busy} />
            {check.blocker && !check.error && <Typography variant="caption" color="textSecondary" component="p" style={{ marginTop: 12 }}>{check.blocker}</Typography>}
          </> : <div className={classes.empty}><Typography variant="body2" color="textSecondary">{catalogBusy ? 'Loading the catalog shortlist…' : 'Add candidates to rank them against your question.'}</Typography></div>}
        </CardContent>
      </Card>
    </Grid>
  </Grid>;
}
