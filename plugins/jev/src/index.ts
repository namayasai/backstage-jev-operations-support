import { createPlugin, createRoutableExtension, createRouteRef } from '@backstage/core-plugin-api';
import { entityRouteRef } from '@backstage/plugin-catalog-react';
export const rootRouteRef = createRouteRef({ id: 'jev' });
export const jevPlugin = createPlugin({ id: 'jev', routes: { root: rootRouteRef } });
export const JevPage = jevPlugin.provide(createRoutableExtension({
  name: 'JevPage', mountPoint: rootRouteRef,
  component: () => import('./BackstagePage').then(m => m.JevPage),
}));
export const EntityJevContent = jevPlugin.provide(createRoutableExtension({
  name: 'EntityJevContent', mountPoint: entityRouteRef,
  component: () => import('./BackstagePage').then(m => m.EntityJevContent),
}));
export { JevWorkbench } from './Workbench';
export type { WorkbenchProps } from './Workbench';
