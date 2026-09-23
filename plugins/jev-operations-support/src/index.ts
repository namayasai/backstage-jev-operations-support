import { createComponentExtension, createPlugin, createRoutableExtension, createRouteRef } from '@backstage/core-plugin-api';
import { entityRouteRef } from '@backstage/plugin-catalog-react';
export const rootRouteRef = createRouteRef({ id: 'jev-operations-support' });
export const alertsRouteRef = createRouteRef({ id: 'jev-alerts' });
export const triageRouteRef = createRouteRef({ id: 'jev-triage' });
export const jevPlugin = createPlugin({ id: 'jev-operations-support', routes: { root: rootRouteRef, alerts: alertsRouteRef, triage: triageRouteRef } });
export const JevPage = jevPlugin.provide(createRoutableExtension({
  name: 'JevPage', mountPoint: rootRouteRef,
  component: () => import('./BackstagePage').then(m => m.JevStandalonePage),
}));
export const JevAlertsPage = jevPlugin.provide(createRoutableExtension({
  name: 'JevAlertsPage', mountPoint: alertsRouteRef,
  component: () => import('./BackstagePage').then(m => m.JevAlertsStandalonePage),
}));
export const JevTriagePage = jevPlugin.provide(createRoutableExtension({
  name: 'JevTriagePage', mountPoint: triageRouteRef,
  component: () => import('./BackstagePage').then(m => m.JevTriageStandalonePage),
}));
export const EntityJevContent = jevPlugin.provide(createRoutableExtension({
  name: 'EntityJevContent', mountPoint: entityRouteRef,
  component: () => import('./BackstagePage').then(m => m.EntityJevContent),
}));
// Read-only entity cards backed by the optional Tech Insights module's scheduled results
// (see entityCards.tsx). Not routable — plain component extensions, for a host's own
// EntityPage layout — so createComponentExtension is used instead of createRoutableExtension.
export const EntityJevReadinessCard = jevPlugin.provide(createComponentExtension({
  name: 'EntityJevReadinessCard',
  component: { lazy: () => import('./entityCards').then(m => m.EntityJevReadinessCard) },
}));
export const EntityJevOwnerSuggestionCard = jevPlugin.provide(createComponentExtension({
  name: 'EntityJevOwnerSuggestionCard',
  component: { lazy: () => import('./entityCards').then(m => m.EntityJevOwnerSuggestionCard) },
}));
export { JevWorkbench } from './Workbench';
export type { WorkbenchProps, TechDocsOptions } from './Workbench';
export { AlertInbox, categorizeAlert } from './AlertInbox';
export type { AlertInboxProps, AlertNotificationPage, AlertService, AlertServiceContext, AlertServiceOwner, AwsAlertNotification, JevAwsAlertMetadata } from './AlertInbox';

export { ReportTriage } from './ReportTriage';
export type { ReportTriageProps } from './ReportTriage';
