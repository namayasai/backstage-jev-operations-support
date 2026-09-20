import { Box, Divider, Typography } from '@material-ui/core';
import { Alert } from '@material-ui/lab';
import { responsePlanOutcomeSchema } from '@namayasai/backstage-plugin-jev-operations-support-common';

/** LLM output is rendered as text, never HTML, links, executable commands, or a proven diagnosis. */
export function ResponsePlanPanel({ value, stale = false }: { value?: unknown; stale?: boolean }) {
  const parsed = responsePlanOutcomeSchema.safeParse(value);
  if (value === undefined) return <Typography variant="body2" color="textSecondary">No response suggestions accompany this assessment. Configure a planning LLM to generate them for manual triage and incoming ALARM notifications.</Typography>;
  if (!parsed.success) return <Alert severity="warning">The response suggestions could not be validated. The Jev assessment remains available.</Alert>;
  const result = parsed.data;
  if (result.status === 'pending') return <Typography role="status">The LLM is preparing response suggestions…</Typography>;
  if (result.status === 'failed') return <Alert severity="warning">{result.code === 'busy' ? 'The LLM is busy' : result.code === 'timeout' ? 'The LLM request timed out' : 'The LLM request did not complete'}. No response suggestions were generated. The Jev assessment remains available.</Alert>;
  return <Box component="section" aria-label="LLM response suggestions" mt={3} style={{ opacity: stale ? 0.6 : 1, overflowWrap: 'anywhere' }}>
    <Divider style={{ marginBottom: 16 }} />
    <Typography variant="h6" component="h3">Response suggestions (LLM)</Typography>
    <Typography variant="caption" color="textSecondary">{result.provider} · {result.model} · {new Date(result.generatedAt).toLocaleString()}</Typography>
    {result.mode === 'demo' && <Alert severity="info" style={{ marginTop: 12 }}>Fixed demo suggestions for display verification. They were not generated from this report.</Alert>}
    {stale && <Alert severity="warning" style={{ marginTop: 12 }}>The report has changed. These suggestions refer to the previous input.</Alert>}
    <Typography paragraph style={{ marginTop: 12 }}>{result.plan.summary}</Typography>
    <Typography variant="body2" color="textSecondary" paragraph>These are proposals, not a confirmed diagnosis. Verify the evidence and prerequisites before deciding how to respond.</Typography>
    <Typography variant="subtitle1" component="h4">Possible causes and verification</Typography>
    {result.plan.hypotheses.length ? result.plan.hypotheses.map((item, i) => <Box key={i} my={1}>
      <Typography variant="body2"><strong>{i + 1}. {item.cause}</strong></Typography>
      <Typography variant="body2">Evidence: {item.evidence}</Typography>
      <Typography variant="body2">Verify: {item.verification}</Typography>
    </Box>) : <Typography variant="body2">There is not enough information to identify a possible cause.</Typography>}
    <Typography variant="subtitle1" component="h4">Checks to run first</Typography>
    <ul>{result.plan.checks.map((item, i) => <li key={i}><Typography variant="body2">{item}</Typography></li>)}</ul>
    <Typography variant="subtitle1" component="h4">Response options</Typography>
    {result.plan.actions.length ? result.plan.actions.map((item, i) => <Box key={i} my={1}>
      <Typography variant="body2"><strong>{i + 1}. {item.action}</strong></Typography>
      <Typography variant="body2">Prerequisites: {item.preconditions}</Typography>
      <Typography variant="body2">Risk: {item.risk}</Typography>
      <Typography variant="body2">Recovery check: {item.verification}</Typography>
    </Box>) : <Typography variant="body2">No intervention is proposed yet. Gather the missing information first.</Typography>}
    <Typography variant="subtitle1" component="h4">Missing information</Typography>
    <ul>{result.plan.unknowns.map((item, i) => <li key={i}><Typography variant="body2">{item}</Typography></li>)}</ul>
  </Box>;
}
