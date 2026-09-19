# Publishing and directory submission

Version 0.2.0 of the frontend, backend, and common packages is public on npm. GitHub source and release artifacts remain available. The Plugin Directory entry was submitted as [Backstage PR #35788](https://github.com/backstage/backstage/pull/35788) and is awaiting upstream review.

## npm publication

For future releases, increment the package versions, run the checks, and publish the shared dependency before its consumers. Confirm that the logged-in npm account can publish to the `@namayasai` scope:

```sh
npm whoami
npm run check
npm publish --workspace plugins/jev-operations-support-common --access public
npm publish --workspace plugins/jev-operations-support-backend --access public
npm publish --workspace plugins/jev-operations-support --access public
```

Complete any npm account or second-factor verification through npm's own login flow. Do not put credentials in this repository. Verify the new version with `npm view` and an installation that resolves dependencies from the public registry. Consumers can install the current release by name:

```sh
yarn --cwd packages/app add @namayasai/backstage-plugin-jev-operations-support
yarn --cwd packages/backend add @namayasai/backstage-plugin-jev-operations-support-backend
```

The published common package removes the need for the tarball resolution. Do not republish an existing version; npm versions are immutable.

## Backstage Plugin Directory

The submitted entry is [plugin-directory.yaml](plugin-directory.yaml). It has been checked with Backstage's `scripts/verify-plugin-directory.js`; the description is 142 characters. The original icon is Apache-2.0 licensed with this repository.

For subsequent directory changes, update `microsite/data/plugins/jev-operations-support.yaml` in `backstage/backstage`. Follow the upstream PR template and DCO sign-off requirement, and disclose AI assistance. This is a directory metadata change, so no Backstage package changeset is needed. A fresh check for existing open Jev PRs should precede submission.

Listing depends on upstream review; opening a PR does not mean the plugin is approved or officially maintained by Backstage.
