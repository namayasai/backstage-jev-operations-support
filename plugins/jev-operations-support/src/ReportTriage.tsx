import { useState } from 'react';
import { Box, Button, Card, CardContent, CardHeader, Divider, TextField, Typography } from '@material-ui/core';
import { Alert } from '@material-ui/lab';
import type { Candidate, EvaluationRequest, EvaluationResult } from '@namayasai/backstage-plugin-jev-operations-support-common';
import { FindingCounts, FindingList, PendingChecks } from './Findings';
import { ResponsePlanSection, type RequestResponsePlan } from './ResponsePlan';
import { LiveSwitch } from './LiveSwitch';
import { useLiveEvaluation, useLivePreference, type EvaluateOptions } from './useLiveEvaluation';

const NO_CANDIDATES: Candidate[] = [];
const triageQuestions = ['Reported impact', 'Investigation area'];

/**
 * A report that never became an alarm (a customer message, a chat thread) is triaged
 * with the same questions as an alert, and read the same way. Live is the same preference
 * as the rest of the inbox, so toggling it here or elsewhere updates both.
 */
export interface ReportTriageProps {
  evaluate: (request: EvaluationRequest, options?: EvaluateOptions) => Promise<EvaluationResult>;
  /** Generates response suggestions for an assessment on request. Live and Check now only run Jev. */
  requestResponsePlan?: RequestResponsePlan;
  liveDelayMs?: number;
  live?: boolean;
  active?: boolean;
}

export function ReportTriage({ evaluate, requestResponsePlan, liveDelayMs, live: liveProp, active = true }: ReportTriageProps) {
  const [preference, setLive] = useLivePreference();
  const forcedOff = liveProp === false;
  const live = !forcedOff && preference;
  const [text, setText] = useState('');
  const check = useLiveEvaluation({ evaluate, workflow: 'incident', text, candidates: NO_CANDIDATES, live, delayMs: liveDelayMs, paused: !active });
  const label = check.busy ? 'Assessing…'
    : check.pending && check.retryAt ? 'Retrying automatically after a failure — or choose Check now'
    : check.pending ? 'Waiting for you to pause…'
    : check.stale ? 'Out of date'
    : check.result ? 'Up to date'
    : !live ? 'Live check is off — choose Check now, or turn on Live to check as you type'
    : check.blocker || 'Assessed as you type';
  return <Card component="article" aria-label="Report triage">
    <CardHeader title="Check an incident report" subheader="For reports received verbally, through customer support, or in a message. Describe the symptoms, known customer impact, and recent changes to assess the first response." titleTypographyProps={{ variant: 'h5', component: 'h2' }}
      action={<LiveSwitch live={live} onChange={setLive} forcedOff={forcedOff} style={{ margin: '8px 8px 0 0' }} />} />
    <Divider />
    <CardContent>
      <TextField id="jev-report" label="Report" variant="outlined" fullWidth multiline minRows={5} maxRows={16} value={text} error={check.overLimit} onChange={event => setText(event.target.value)} />
      <Box display="flex" justifyContent="space-between" alignItems="center" flexWrap="wrap" mt={1} mb={2} style={{ gap: 8 }}>
        <Typography variant="body2" color="textSecondary" role="status">{label}</Typography>
        <Box display="flex" alignItems="center" style={{ gap: 8 }}>
          {check.result && <FindingCounts findings={check.result.findings} />}
          <Button variant={live ? 'outlined' : 'contained'} color="primary" size="small" disabled={check.busy || check.overLimit} onClick={check.checkNow}>{check.busy ? 'Checking…' : 'Check now'}</Button>
        </Box>
      </Box>
      {check.error && <Alert severity="error" style={{ marginBottom: 16 }}>{check.error}</Alert>}
      {check.result?.mode === 'demo' && <Alert severity="warning" style={{ marginBottom: 16 }}>Backend demo mode is enabled. These fixed results do not evaluate your report.</Alert>}
      {check.result ? <FindingList findings={check.result.findings} stale={check.stale} headingLevel="h4" /> : <PendingChecks titles={triageQuestions} busy={check.busy} headingLevel="h4" />}
      {check.result && <ResponsePlanSection result={check.result} stale={check.stale} requestPlan={requestResponsePlan} />}
      <Typography variant="caption" color="textSecondary" component="p" style={{ marginTop: 16 }}>This assessment is not stored and creates no alert. The report is sent to Jev through your Backstage backend. It is sent to the response-planning LLM only when you choose Generate response suggestions.</Typography>
    </CardContent>
  </Card>;
}
