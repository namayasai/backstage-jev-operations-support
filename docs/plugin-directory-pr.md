<!-- Draft only: verify public npm publication before submitting. -->

## Hey, I just made a Pull Request!

Adds Jev Operations Support to the plugin directory so Backstage adopters can find its operational checks, recommendations, and incident triage workflows. The independently maintained plugin has installation documentation and a screenshot in its [repository](https://github.com/namayasai/backstage-jev-operations-support).

Validation: the plugin-directory validator passed. The plugin's six workflows were exercised in a local Backstage 1.55.0 host against the live Jev API; [scope and evidence](https://github.com/namayasai/backstage-jev-operations-support/blob/main/docs/verification.md) are documented. Prepared with AI assistance.

#### :heavy_check_mark: Checklist

- [ ] A changeset describing the change and affected packages. ([more info](https://github.com/backstage/backstage/blob/master/CONTRIBUTING.md#creating-changesets)) — Not applicable; directory metadata only.
- [x] Added or updated documentation
- [ ] Tests for new functionality and regression tests for bug fixes — No Backstage runtime changes; directory metadata validated.
- [ ] Screenshots attached (for UI changes) — No Backstage UI changes in this PR; plugin screenshots are in its README.
- [ ] All your commits have a `Signed-off-by` line in the message. ([more info](https://github.com/backstage/backstage/blob/master/CONTRIBUTING.md#developer-certificate-of-origin)) — Check after creating the submission commit.
