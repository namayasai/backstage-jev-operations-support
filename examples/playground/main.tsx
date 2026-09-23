import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Box, CssBaseline, Tab, Tabs, Typography, useMediaQuery } from '@material-ui/core';
import { UnifiedThemeProvider, themes } from '@backstage/theme';
import { demoEvaluation, sampleText, type EvaluationRequest } from '../../plugins/jev-operations-support-common/src';
import { JevWorkbench } from '../../plugins/jev-operations-support/src/Workbench';
import { ReportTriage } from '../../plugins/jev-operations-support/src/ReportTriage';
import { AlertInbox, parseAlertNotificationPage } from '../../plugins/jev-operations-support/src/AlertInbox';

const evaluate = async (input: EvaluationRequest) => demoEvaluation(input);
const incident = (text: string) => demoEvaluation({ workflow: 'incident', text, candidates: [] });
const alert = (id: string, title: string, description: string, context: string, minutesAgo: number, details: Record<string, unknown> = {}) => ({
  id, created: new Date(Date.now() - minutesAgo * 60000).toISOString(),
  payload: { topic: 'jev-aws-alerts', title, description, metadata: { jevOperationsSupport: {
    source: 'aws-cloudwatch', context, awsState: 'ALARM', alarmArn: `arn:aws:cloudwatch:ap-northeast-1:123456789012:alarm:${title}`, region: 'ap-northeast-1',
    evaluationStatus: 'evaluated', result: incident(context), updatedAt: new Date(Date.now() - minutesAgo * 60000 + 4000).toISOString(), ...details,
  } } },
});
// Illustrative catalog Group candidates, standing in for a catalog read.
const ownerGroups = [
  { id: 'group:default/sre', entityRef: 'group:default/sre', title: 'SRE', description: 'Site reliability, on-call, and incident response.' },
  { id: 'group:default/payments', entityRef: 'group:default/payments', title: 'Payments platform', description: 'Payment processing, checkout APIs, and billing infrastructure.' },
  { id: 'group:default/identity', entityRef: 'group:default/identity', title: 'Identity platform', description: 'Authentication, authorization, and account access.' },
];
const checkoutContext = 'Following today’s deployment, checkout requests return HTTP 500 for 30% of customers. Database connections are exhausted.';
const fixtures = [
  // Carries a stored owner suggestion, the same way the AWS notifications module saves one
  // when jevOperationsSupport.awsNotifications.ownerSuggestion.enabled is true.
  alert('a1', 'checkout-5xx-rate', 'HTTP 5xx rate above 5% for 5 minutes', checkoutContext, 6, {
    ownerStatus: 'evaluated',
    ownerResult: demoEvaluation({ workflow: 'ownership', text: checkoutContext, candidates: ownerGroups }),
    ownerCandidates: ownerGroups.map(({ id, title }) => ({ id, title })),
    // Service context as the read endpoint attaches it from jevOperationsSupport.awsNotifications.serviceBindings.
    service: { status: 'bound', services: [{
      status: 'available', entityRef: 'component:default/checkout', environment: 'production', kind: 'Component', title: 'Checkout API', type: 'service', lifecycle: 'production',
      system: 'system:default/storefront', dependsOn: ['resource:default/orders-db'], owner: { status: 'resolved', entityRef: 'group:default/payments', title: 'Payments platform' },
      links: [{ url: 'https://example.com/runbooks/checkout', title: 'Checkout runbook' }, { url: 'https://example.com/dashboards/checkout', title: 'Dashboard' }],
    }] },
  }),
  alert('a2', 'identity-login-latency', 'p99 login latency above 3s', 'Login latency p99 is above three seconds in ap-northeast-1. No customer reports yet.', 18, { result: undefined, evaluationStatus: 'not-evaluated', errorCode: 'evaluation-capacity-reached', service: { status: 'unbound' } }),
  alert('a3', 'search-indexer-lag', 'Indexer lag recovered', 'Search indexer lag exceeded ten minutes and has since returned to normal.', 95, { awsState: 'OK' }),
];
const loadNotifications = async () => parseAlertNotificationPage({ totalCount: fixtures.length, notifications: fixtures });

function Playground() {
  const dark = useMediaQuery('(prefers-color-scheme: dark)');
  const [view, setView] = useState(window.location.hash.slice(1) || 'alerts');
  return <UnifiedThemeProvider theme={dark ? themes.dark : themes.light}>
    <CssBaseline />
    <Box p={3}>
      <Typography variant="overline" color="textSecondary">Jev Operations Support · demo data</Typography>
      <Tabs value={view} indicatorColor="primary" textColor="primary" onChange={(_, next) => setView(next)} style={{ marginBottom: 24 }}>
        <Tab value="alerts" label="Alerts" id="jev-tab-alerts" aria-controls="jev-tabpanel-alerts" />
        <Tab value="triage" label="Triage" id="jev-tab-triage" aria-controls="jev-tabpanel-triage" />
        <Tab value="playground" label="Pre-check" id="jev-tab-playground" aria-controls="jev-tabpanel-playground" />
      </Tabs>
      <div hidden={view !== 'alerts'} role="tabpanel" id="jev-tabpanel-alerts" aria-labelledby="jev-tab-alerts"><AlertInbox loadNotifications={loadNotifications} evaluate={evaluate} pollMs={0} active={view === 'alerts'} /></div>
      <div hidden={view !== 'triage'} role="tabpanel" id="jev-tabpanel-triage" aria-labelledby="jev-tab-triage"><ReportTriage evaluate={evaluate} active={view === 'triage'} /></div>
      <div hidden={view !== 'playground'} role="tabpanel" id="jev-tabpanel-playground" aria-labelledby="jev-tab-playground"><JevWorkbench demo evaluate={evaluate} workflowIds={['readiness', 'change-risk', 'templates', 'ownership', 'search']} initialText={sampleText.readiness} active={view === 'playground'} /></div>
    </Box>
  </UnifiedThemeProvider>;
}

createRoot(document.getElementById('root')!).render(<Playground />);
