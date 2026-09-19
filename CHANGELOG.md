# Changelog

## 0.2.0

Renamed the project to **Jev Operations Support** to make its purpose clear in a Backstage plugin directory and navigation menu.

- Repository: `namayasai/backstage-jev-operations-support`.
- Packages: `@namayasai/backstage-plugin-jev-operations-support`, plus `-backend` and `-common`.
- Backend plugin ID and page route: `jev-operations-support`.
- Configuration section: `jevOperationsSupport`.
- Evaluation permission: `jev-operations-support.evaluate`.
- Verified all six workflows against live Jev from a Backstage 1.55.0 development host, including catalog candidate loading, entity links, and the entity tab.
- Added an explicit route reference and page icon so the new frontend's default sidebar can discover the navigation item.

Users of the 0.1.0 GitHub tarballs must update the package imports, config section, permission policy, and route. The six workflow IDs and request formats are unchanged. Version 0.1.0 was not published to npm.

## 0.1.0

Initial experimental GitHub release with six workflows, authenticated backend, legacy/new frontend extensions, a fixture playground, and live Jev smoke tests.
