import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { createJevClient } from '../plugins/jev-operations-support-backend/src/client';
import { buildEvaluation, evaluationRequestSchema, sampleText, sampleCandidates, summarize, workflowIds, type EvaluationRequest } from '../plugins/jev-operations-support-common/src';

// The key is read directly into memory. Never write it, include it in reports, or log provider bodies.
async function main() {
const keyFlag = process.argv.indexOf('--key-file');
const key = keyFlag >= 0 ? (await readFile(process.argv[keyFlag + 1], 'utf8')).trim() : process.env.TYPESAFE_API_KEY;
if (!key || /\s/.test(key)) throw new Error('Set TYPESAFE_API_KEY or pass --key-file pointing to a single raw API key.');
const client = createJevClient({ apiKey: key, model: process.env.JEV_MODEL ?? 'jev-1.13.0', timeoutMs: 30000 });
const cases: { name: string; input: EvaluationRequest; expected?: (result: ReturnType<typeof summarize>) => boolean }[] = workflowIds.map(workflow => ({
  name: workflow,
  input: { workflow, text: sampleText[workflow], candidates: ['templates', 'ownership', 'search'].includes(workflow) ? (workflow === 'templates' ? [
    { id: 'node', title: 'Node.js service', description: 'Node.js HTTP service with PostgreSQL and Kubernetes deployment.' },
    { id: 'static', title: 'Static site', description: 'Static HTML website, with no database or server.' },
  ] : sampleCandidates) : [] },
}));
cases.push({ name: 'readiness-complete', input: { workflow: 'readiness', candidates: [], text: 'Start: run npm ci and npm start after setting DATABASE_URL. Check GET /health returns HTTP 200 and database=connected. Rollback: run kubectl rollout undo deployment/checkout, then confirm GET /health returns 200. Escalation: contact the Payments team through #payments-oncall.' }, expected: r => r.findings.every(f => f.status === 'pass') });
cases.push({ name: 'templates-no-match', input: { workflow: 'templates', candidates: [{ id: 'static', title: 'Static site', description: 'Static HTML, no application server, no database.' }], text: 'I require a stateful Java service with PostgreSQL. A static site cannot meet the requirements.' }, expected: r => r.findings[0].value === 'none' && r.needsReview });
const results = [];
for (const test of cases) {
  const input = evaluationRequestSchema.parse(test.input);
  const { request, checks } = buildEvaluation(input);
  const started = performance.now();
  const response = await client.evaluate(request);
  const result = summarize(input, response, checks);
  const expectationPassed = test.expected ? test.expected(result) : null;
  const row = { name: test.name, elapsedMs: Math.round(performance.now() - started), expectationPassed, result };
  results.push(row);
  console.log(`${test.name}: ${result.findings.length} validated answers, ${row.elapsedMs} ms${expectationPassed === null ? '' : expectationPassed ? ', expected outcome passed' : ', expected outcome FAILED'}`);
}
const report = { testedAt: new Date().toISOString(), note: 'Live API smoke tests with synthetic English inputs. This is not a quality benchmark or a Backstage host end-to-end test.', results };
await writeFile('docs/live-smoke.json', JSON.stringify(report, null, 2) + '\n');
if (results.some(r => r.expectationPassed === false)) process.exitCode = 1;
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Live test failed'); process.exitCode = 1; });
