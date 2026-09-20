import { createGitHubClient, type GitHubClient } from './client';
import { resolveChangeReviewSettings, ChangeReviewConfigError } from './changeReview';
import type { GitHubWebhookRouterOptions } from './router';

/** The subset of `@backstage/config`'s `Config` this module reads. Kept narrow and structural (rather than
 * importing `Config` itself) so it can be exercised directly with a plain object in tests. */
export interface ConfigReader {
  getOptionalString(key: string): string | undefined;
  getOptionalBoolean(key: string): boolean | undefined;
  getOptionalNumber(key: string): number | undefined;
  getOptionalStringArray(key: string): string[] | undefined;
  /** Mirrors `@backstage/config`'s own `getOptional`: the raw (unvalidated) value at `key`, or `undefined`.
   * Used only for the `changeReview` block, whose own shape validator (`resolveChangeReviewSettings`) takes an
   * `unknown` root rather than a set of scalar/array readers. */
  getOptional(key: string): unknown;
}

/** Resolves and validates `jevOperationsSupport.githubWebhook`. Returns `undefined` when the integration is not
 * configured at all (both `secret` and `token` absent, and `report` left at its `none` default); throws a
 * descriptive `Error` for any other invalid combination, so a misconfiguration fails the backend at startup rather
 * than at the first webhook delivery. `report`/`blockOn`/`queueLength` are read and validated unconditionally,
 * before the secret/token check: an unknown value is a startup error even when the webhook is otherwise
 * unconfigured, and `report` other than `none` without a secret and token is itself a startup error rather than a
 * silently-ignored setting. */
export function resolveGitHubWebhookConfig(config: ConfigReader, createClient: (token: string) => GitHubClient = token => createGitHubClient({ token })): GitHubWebhookRouterOptions | undefined {
  const report = config.getOptionalString('jevOperationsSupport.githubWebhook.report') ?? 'none';
  if (!['none', 'status', 'status+comment'].includes(report)) throw new Error('jevOperationsSupport.githubWebhook.report must be one of "none", "status", or "status+comment"');
  const blockOn = config.getOptionalString('jevOperationsSupport.githubWebhook.blockOn') ?? 'never';
  if (!['never', 'attention'].includes(blockOn)) throw new Error('jevOperationsSupport.githubWebhook.blockOn must be "never" or "attention"');
  const queueLength = config.getOptionalNumber('jevOperationsSupport.githubWebhook.queueLength') ?? 20;
  if (!Number.isInteger(queueLength) || queueLength < 1 || queueLength > 200) throw new Error('jevOperationsSupport.githubWebhook.queueLength must be an integer between 1 and 200');

  // Validated unconditionally too, exactly like report/blockOn/queueLength above: a broken changeReview block is a
  // startup error even when the webhook is otherwise unconfigured, so it never surfaces only once an operator
  // later fills in secret/token.
  let changeReview;
  try {
    changeReview = resolveChangeReviewSettings(config.getOptional('jevOperationsSupport.githubWebhook.changeReview'));
  } catch (error) {
    if (error instanceof ChangeReviewConfigError) throw new Error(`jevOperationsSupport.githubWebhook.${error.message}`);
    throw error;
  }
  // Never send a diff for a result nobody can see: change review posts nothing anywhere unless the report the
  // rest of this webhook already produces is itself visible.
  if (changeReview.enabled && report === 'none') {
    throw new Error(
      'jevOperationsSupport.githubWebhook.changeReview needs report: status or status+comment to be visible; with report: none the change-review result would never be written anywhere.',
    );
  }

  const secret = config.getOptionalString('jevOperationsSupport.githubWebhook.secret');
  const token = config.getOptionalString('jevOperationsSupport.githubWebhook.token');
  if (Boolean(secret) !== Boolean(token)) throw new Error('jevOperationsSupport.githubWebhook.secret and token must be configured together');
  if (!secret || !token) {
    if (report !== 'none') throw new Error('jevOperationsSupport.githubWebhook.report requires secret and token to also be configured');
    if (changeReview.enabled) throw new Error('jevOperationsSupport.githubWebhook.changeReview.enabled requires secret and token to also be configured');
    return undefined;
  }

  const repositories = config.getOptionalStringArray('jevOperationsSupport.githubWebhook.repositories') ?? [];
  const documentationPaths = config.getOptionalStringArray('jevOperationsSupport.githubWebhook.documentationPaths') ?? [];
  if (!repositories.length) throw new Error('jevOperationsSupport.githubWebhook.repositories must contain at least one repository');
  if (!documentationPaths.length) throw new Error('jevOperationsSupport.githubWebhook.documentationPaths must contain at least one Markdown path pattern');
  if (repositories.some(repository => !/^[^/\s]+\/[^/\s]+$/.test(repository))) throw new Error('jevOperationsSupport.githubWebhook.repositories must use owner/name entries');
  if (documentationPaths.some(path => !path.trim() || path.includes('..'))) throw new Error('jevOperationsSupport.githubWebhook.documentationPaths contains an invalid path pattern');

  // Reporting runs in the background, so it can afford a much larger per-delivery deadline than the synchronous
  // (report: none) path, which holds GitHub's own webhook connection open for the whole evaluation.
  const webhookTimeoutMs = config.getOptionalNumber('jevOperationsSupport.githubWebhook.timeoutMs') ?? 8000;
  const webhookTimeoutMax = report === 'none' ? 8000 : 60000;
  if (!Number.isInteger(webhookTimeoutMs) || webhookTimeoutMs < 1000 || webhookTimeoutMs > webhookTimeoutMax) throw new Error(`jevOperationsSupport.githubWebhook.timeoutMs must be an integer between 1000 and ${webhookTimeoutMax}`);

  const maxDocuments = config.getOptionalNumber('jevOperationsSupport.githubWebhook.maxDocuments') ?? 3;
  if (!Number.isInteger(maxDocuments) || maxDocuments < 1 || maxDocuments > 10) throw new Error('jevOperationsSupport.githubWebhook.maxDocuments must be an integer between 1 and 10');

  return {
    secret,
    client: createClient(token),
    repositories,
    documentationPaths,
    allowForks: config.getOptionalBoolean('jevOperationsSupport.githubWebhook.allowForks') ?? false,
    timeoutMs: webhookTimeoutMs,
    maxDocuments,
    report: report as GitHubWebhookRouterOptions['report'],
    blockOn: blockOn as GitHubWebhookRouterOptions['blockOn'],
    queueLength,
    changeReview,
  };
}
