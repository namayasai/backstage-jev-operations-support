# Publishing and directory submission

The repository and GitHub release artifacts are public. npm publication is currently pending npm authentication on the publishing machine. Do not submit the directory PR until all three packages are publicly readable from the npm registry.

## npm publication

After logging into the intended npm account, confirm access to the `@namayasai` scope. Run the checks and publish the shared dependency before its consumers:

```sh
npm whoami
npm run check
npm publish --workspace plugins/jev-operations-support-common --access public
npm publish --workspace plugins/jev-operations-support-backend --access public
npm publish --workspace plugins/jev-operations-support --access public
```

Complete any npm account or second-factor verification through npm's own login flow. Do not put credentials in this repository. Once published, verify each package at version `0.2.0` with `npm view`, then change the installation guide to use normal package names:

```sh
yarn --cwd packages/app add @namayasai/backstage-plugin-jev-operations-support
yarn --cwd packages/backend add @namayasai/backstage-plugin-jev-operations-support-backend
```

The published common package removes the need for the tarball resolution. Update the README's publication status at the same time.

## Backstage Plugin Directory

The prepared entry is [plugin-directory.yaml](plugin-directory.yaml). It has been checked with Backstage's `scripts/verify-plugin-directory.js`; the description is 142 characters. The original icon is Apache-2.0 licensed with this repository.

Add the entry as `microsite/data/plugins/jev-operations-support.yaml` in `backstage/backstage`. Follow the upstream PR template and DCO sign-off requirement, and disclose AI assistance. This is a directory metadata change, so no Backstage package changeset is needed. A fresh check for existing open Jev PRs should precede submission.

Listing depends on upstream review; opening a PR does not mean the plugin is approved or officially maintained by Backstage.
