# Verification

The automated suite covers workflow contracts, malformed and contradictory provider responses, uncertainty handling, no-match decisions, risk polarity, result ordering, identity and permission checks, rate limits, provider failures, browser component interactions, catalog API adaptation, and entity navigation state.

`npm run check` runs type checking, all tests, CommonJS/ESM/declaration builds for three packages, and a production build of the fixture playground. A [GitHub Actions example](ci.example.yml) runs the same command on Node.js 22. It is not enabled in this repository because the publishing credential cannot create workflow files. To enable it, copy the example to `.github/workflows/ci.yml` using an account or token with workflow permissions.

The live smoke harness makes eight calls with synthetic English input: one per workflow, plus complete readiness documentation and a template no-match case. The last two cases assert an expected decision; the first six validate the response contract and record the output. Timing includes the client-to-provider round trip in one local run. It is not a latency guarantee or an accuracy benchmark.

The report in [live-smoke.json](live-smoke.json) includes the actual model ID, selected values, probabilities where available, confidence, and timestamps. Credentials and provider error bodies are excluded.

Browser verification exercised all six fixture workflows using the real shared React workbench. The screenshot in [workbench.png](workbench.png) is from this explicitly labeled fixture UI.

Backstage integration adapters are tested with mocked host APIs, including catalog filtering, the authenticated fetch adapter, catalog links, and clearing state on entity navigation. New frontend and backend extension types compile against the installed Backstage libraries. **A complete production Backstage host with your identity provider and permission policy has not been deployed or end-to-end verified.** The standalone playground is not a substitute for that integration check.

Independent review found two defects before release: entity state survived navigation, and contradictory provider decisions were accepted. Both were corrected and regression tested.

The three packed artifacts were also installed into a separate temporary npm consumer with a local shared-package override. This checks package resolution independently of the development workspaces.
