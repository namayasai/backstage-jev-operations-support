import { createFrontendPlugin, PageBlueprint } from '@backstage/frontend-plugin-api';
import { EntityContentBlueprint } from '@backstage/plugin-catalog-react/alpha';

const jevPage = PageBlueprint.make({
  params: {
    path: '/jev',
    title: 'Jev',
    loader: () => import('./BackstagePage').then(m => <m.JevPage />),
  },
});

const jevEntityContent = EntityContentBlueprint.make({
  params: {
    path: '/jev', title: 'Jev',
    loader: () => import('./BackstagePage').then(m => <m.EntityJevContent />),
  },
});

export default createFrontendPlugin({ pluginId: 'jev', extensions: [jevPage, jevEntityContent] });
