import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { createJevClient } from '../plugins/jev-operations-support-backend/src/client';
import { buildEvaluation, evaluationRequestSchema, summarize, type EvaluationRequest, type EvaluationResult } from '../plugins/jev-operations-support-common/src';

type ExpectedStatus = EvaluationResult['findings'][number]['status'];
type Fixture = EvaluationRequest & { id: string; expected: Record<string, ExpectedStatus> };
type CheckResult = { id: string; status: ExpectedStatus; expectedStatus: ExpectedStatus | null; match: boolean | null; value?: number | string; confidence?: number | null };
type FixtureRun = { fixture: string; attempt: number; elapsedMs?: number; model?: string; needsReview?: boolean; checks?: CheckResult[]; error?: string };

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function readKey(): Promise<string> {
  const keyFile = argument('--key-file');
  const key = keyFile ? await readFile(keyFile, 'utf8') : process.env.TYPESAFE_API_KEY;
  if (!key || /\s/.test(key.trim()) || !key.trim()) throw new Error('Set TYPESAFE_API_KEY or pass --key-file pointing to a single raw API key.');
  return key.trim();
}

async function main() {
  const fixtures = JSON.parse(await readFile(new URL('../docs/evaluation-fixtures.json', import.meta.url), 'utf8')) as Fixture[];
  const repeat = Number(argument('--repeat') ?? '1');
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 10) throw new Error('--repeat must be an integer between 1 and 10.');
  for (const fixture of fixtures) {
    const input = evaluationRequestSchema.parse({ workflow: fixture.workflow, text: fixture.text, candidates: fixture.candidates });
    const { checks } = buildEvaluation(input);
    const expectedKeys = Object.keys(fixture.expected).sort();
    const checkKeys = checks.map(check => check.id).sort();
    if (expectedKeys.length !== checkKeys.length || expectedKeys.some((key, index) => key !== checkKeys[index])) {
      throw new Error(`Fixture ${fixture.id} expected labels must exactly cover: ${checkKeys.join(', ')}.`);
    }
  }
  const key = await readKey();
  const client = createJevClient({ apiKey: key, model: process.env.JEV_MODEL ?? 'jev-1.13.0', timeoutMs: 30000 });
  const results: FixtureRun[] = [];

  for (const fixture of fixtures) {
    for (let attempt = 1; attempt <= repeat; attempt++) {
      const input = evaluationRequestSchema.parse({ workflow: fixture.workflow, text: fixture.text, candidates: fixture.candidates });
      const { request, checks } = buildEvaluation(input);
      const started = performance.now();
      try {
        const response = await client.evaluate(request);
        const result = summarize(input, response, checks);
        const checkResults: CheckResult[] = result.findings.map(finding => ({
          id: finding.id,
          status: finding.status,
          expectedStatus: fixture.expected[finding.id],
          match: fixture.expected[finding.id] === finding.status,
          value: finding.value,
          confidence: finding.confidence ?? null,
        }));
        results.push({
          fixture: fixture.id,
          attempt,
          elapsedMs: Math.round(performance.now() - started),
          model: result.model,
          needsReview: result.needsReview,
          checks: checkResults,
        });
        console.log(`${fixture.id} #${attempt}: ${checkResults.map(check => `${check.id}=${check.status}`).join(', ')}; review=${result.needsReview}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Provider evaluation failed.';
        results.push({ fixture: fixture.id, attempt, elapsedMs: Math.round(performance.now() - started), error: message });
        console.error(`${fixture.id} #${attempt}: ${message}`);
      }
    }
  }

  const checks = results.flatMap(result => result.checks ?? []);
  const errorCount = results.filter(result => result.error).length;
  const mismatchCount = checks.filter(check => check.match === false).length;
  const report = {
    testedAt: new Date().toISOString(),
    model: process.env.JEV_MODEL ?? 'jev-1.13.0',
    fixtureFile: 'docs/evaluation-fixtures.json',
    repeat,
    note: 'Opt-in live evaluation uses synthetic fixtures with explicit expected labels. It is an evaluation aid, not a production accuracy guarantee.',
    summary: {
      fixtureRuns: results.length,
      checks: checks.length,
      reviewCount: checks.filter(check => check.status === 'review').length,
      reviewRate: checks.length ? checks.filter(check => check.status === 'review').length / checks.length : 0,
      expectedComparisons: checks.filter(check => check.expectedStatus !== null).length,
      expectedMatches: checks.filter(check => check.match === true).length,
      mismatchCount,
      errorCount,
    },
    results,
  };
  const output = argument('--output') ?? 'docs/evaluation-live.json';
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(`Wrote ${output}; review rate ${(report.summary.reviewRate * 100).toFixed(1)}% (${report.summary.reviewCount}/${report.summary.checks}).`);
  if (mismatchCount || errorCount) process.exitCode = 1;
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Live evaluation failed');
  process.exitCode = 1;
});
