import { createFrontendPlugin, createRouteRef, PageBlueprint } from '@backstage/frontend-plugin-api';
import { EntityCardBlueprint, EntityContentBlueprint } from '@backstage/plugin-catalog-react/alpha';

const rootRouteRef = createRouteRef();
const jevPage = PageBlueprint.make({
  params: {
    path: '/jev-operations-support',
    routeRef: rootRouteRef,
    title: 'Operations Support',
    icon: <svg viewBox="0 0 24 24" width="24" height="24" fill="none" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" strokeWidth="2" /><circle cx="8" cy="6" r="3" fill="currentColor" /><circle cx="16" cy="12" r="3" fill="currentColor" /><circle cx="11" cy="18" r="3" fill="currentColor" /></svg>,
    loader: () => import('./BackstagePage').then(m => <m.JevPage />),
  },
});

const jevEntityContent = EntityContentBlueprint.make({
  params: {
    path: '/jev-operations-support', title: 'Operations Support',
    loader: () => import('./BackstagePage').then(m => <m.EntityJevContent />),
  },
});

// Read-only entity cards backed by the optional Tech Insights module's scheduled results
// (see entityCards.tsx). `filter` uses the object-predicate form of `@backstage/plugin-catalog-react/alpha`'s
// `EntityCardBlueprint` (verified in node_modules: its own `resolveEntityFilterData` logs a
// deprecation warning for a *string* filter expression like "kind:component" and converts a
// predicate object with `filterPredicateToFilterFunction` from `@backstage/filter-predicates`,
// so the object form below is the current, non-deprecated one). The readiness retriever only
// ever evaluates Component entities server-side; the owner-suggestion retriever's default
// `kinds` are Component/API/Resource/System.
const jevReadinessCard = EntityCardBlueprint.make({
  name: 'readiness',
  params: {
    filter: { kind: 'Component' },
    loader: () => import('./entityCards').then(m => <m.EntityJevReadinessCard />),
  },
});
const jevOwnerSuggestionCard = EntityCardBlueprint.make({
  name: 'owner-suggestion',
  params: {
    filter: { kind: { $in: ['Component', 'API', 'Resource', 'System'] } },
    loader: () => import('./entityCards').then(m => <m.EntityJevOwnerSuggestionCard />),
  },
});

export default createFrontendPlugin({
  pluginId: 'jev-operations-support',
  routes: { root: rootRouteRef },
  extensions: [jevPage, jevEntityContent, jevReadinessCard, jevOwnerSuggestionCard],
});
