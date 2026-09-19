# Verification

The automated suite covers workflow contracts, malformed and contradictory provider responses, uncertainty handling, no-match decisions, risk polarity, result ordering, identity and permission checks, rate limits, provider failures, browser component interactions, catalog API adaptation, and entity navigation state.

`npm run check` runs type checking, all tests, CommonJS/ESM/declaration builds for three packages, and a production build of the fixture playground. A [GitHub Actions example](ci.example.yml) runs the same command on Node.js 22. It is not enabled in this repository because the publishing credential cannot create workflow files. To enable it, copy the example to `.github/workflows/ci.yml` using an account or token with workflow permissions.

The live smoke harness makes eight calls with synthetic English input: one per workflow, plus complete readiness documentation and a template no-match case. The last two cases assert an expected decision; the first six validate the response contract and record the output. Timing includes the client-to-provider round trip in one local run. It is not a latency guarantee or an accuracy benchmark.

The report in [live-smoke.json](live-smoke.json) includes the actual model ID, selected values, probabilities where available, confidence, and timestamps. Credentials and provider error bodies are excluded.

Browser verification exercised all six fixture workflows using the shared React workbench. Current screenshots show the [real Backstage host](backstage-workbench.png) and a [live Jev result](backstage-result.png).

## Real Backstage host

Version 0.2.0 was installed as packed artifacts in a separate **Backstage 1.55.0** host generated with `@backstage/create-app@0.9.2`, using Node.js 22.23.2 and Yarn 4.13.0. The host used the new frontend system, the normal auth/catalog/permission backend plugins, a development guest identity, an allow-all permission policy, and an in-memory SQLite database. Only official synthetic example catalog entries were loaded.

All six workflows were exercised through the actual Backstage browser UI and called the live `jev-1.13.0` API. Template, ownership, and search candidates came from the real Catalog API. A result link opened the corresponding catalog entity, whose Operations Support tab correctly seeded the entity context. An unauthenticated HTTP evaluation request returned **401**. See [the recorded host checks](backstage-host-smoke.json).

This verifies a local integration, not a production identity provider, an organization's permission policy, or model accuracy. Host-specific production validation remains the installer's responsibility. The legacy frontend adapter is covered by component/type checks; this end-to-end run used the new frontend system.

Backstage integration adapters also have automated tests for catalog filtering, the host fetch API, catalog links, and clearing state on entity navigation.

Independent review found two defects before release: entity state survived navigation, and contradictory provider decisions were accepted. Both were corrected and regression tested.

The three packed artifacts were also installed into a separate temporary npm consumer with a local shared-package override. This checks package resolution independently of the development workspaces.

## npm registry artifacts

All three version 0.2.0 packages were downloaded anonymously from the public npm registry. Their registry SHA-512 integrity values were verified, and every runtime JavaScript, declaration, and backend configuration file matched the GitHub release artifacts used in the Backstage host test. See [publication verification](npm-publication.json).
