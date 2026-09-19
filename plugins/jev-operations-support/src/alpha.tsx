import { createFrontendPlugin, createRouteRef, PageBlueprint } from '@backstage/frontend-plugin-api';
import { EntityContentBlueprint } from '@backstage/plugin-catalog-react/alpha';

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

export default createFrontendPlugin({ pluginId: 'jev-operations-support', routes: { root: rootRouteRef }, extensions: [jevPage, jevEntityContent] });
