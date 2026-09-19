# Publishing and directory submission

Release 0.3.0 covers all five packages on npm: frontend, backend, common, and the two optional backend modules. GitHub source and release artifacts remain available. The Plugin Directory entry was submitted as [Backstage PR #35788](https://github.com/backstage/backstage/pull/35788) and is awaiting upstream review.

## npm publication

Increment the package versions, run the checks, and publish the shared dependency before its consumers, then the backend before the modules that import its `/client` export. Confirm that the logged-in npm account can publish to the `@namayasai` scope:

```sh
npm whoami
npm run check
npm publish --workspace plugins/jev-operations-support-common --access public
npm publish --workspace plugins/jev-operations-support-backend --access public
npm publish --workspace plugins/jev-operations-support --access public
npm publish --workspace plugins/jev-operations-support-tech-insights --access public
npm publish --workspace plugins/jev-operations-support-aws-notifications --access public
```

Complete any npm account or second-factor verification through npm's own login flow. Do not put credentials in this repository. After publication, verify each version with `npm view` and an installation that resolves dependencies from the public registry, and record the result in [verification](verification.md). Consumers can install the current release by name:

```sh
yarn --cwd packages/app add @namayasai/backstage-plugin-jev-operations-support
yarn --cwd packages/backend add @namayasai/backstage-plugin-jev-operations-support-backend
yarn --cwd packages/backend add @namayasai/backstage-plugin-jev-operations-support-aws-notifications
```

Publishing the optional modules removes the need to install them from local tarballs. Do not republish an existing version; npm versions are immutable.

Tag the release `v0.3.0` and attach the packed artifacts to the corresponding [GitHub release](https://github.com/namayasai/backstage-jev-operations-support/releases/tag/v0.3.0).

## Backstage Plugin Directory

The submitted entry is [plugin-directory.yaml](plugin-directory.yaml). It has been checked with Backstage's `scripts/verify-plugin-directory.js`. The original icon is Apache-2.0 licensed with this repository.

For subsequent directory changes, update `microsite/data/plugins/jev-operations-support.yaml` in `backstage/backstage`. Follow the upstream PR template and DCO sign-off requirement, and disclose AI assistance. This is a directory metadata change, so no Backstage package changeset is needed. A fresh check for existing open Jev PRs should precede submission.

Listing depends on upstream review; opening a PR does not mean the plugin is approved or officially maintained by Backstage.
