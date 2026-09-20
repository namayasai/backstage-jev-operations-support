import { describe, expect, it, vi } from 'vitest';
import { resolveGitHubWebhookConfig, type ConfigReader } from './config';
import type { GitHubClient } from './client';

function reader(values: Record<string, unknown>): ConfigReader {
  return {
    getOptionalString: key => values[key] as string | undefined,
    getOptionalBoolean: key => values[key] as boolean | undefined,
    getOptionalNumber: key => values[key] as number | undefined,
    getOptionalStringArray: key => values[key] as string[] | undefined,
    getOptional: key => values[key],
  };
}
const valid = {
  'jevOperationsSupport.githubWebhook.secret': 'shh',
  'jevOperationsSupport.githubWebhook.token': 'tok',
  'jevOperationsSupport.githubWebhook.repositories': ['acme/service'],
  'jevOperationsSupport.githubWebhook.documentationPaths': ['docs/**'],
};
const fakeClient = {} as GitHubClient;

describe('GitHub webhook config validation', () => {
  it('is disabled by default and requires secret and token together', () => {
    expect(resolveGitHubWebhookConfig(reader({}))).toBeUndefined();
    expect(() => resolveGitHubWebhookConfig(reader({ 'jevOperationsSupport.githubWebhook.secret': 'shh' }))).toThrow('secret and token must be configured together');
  });

  it('defaults to report: none and blockOn: never, matching today\'s behaviour exactly', () => {
    const createClient = vi.fn().mockReturnValue(fakeClient);
    const resolved = resolveGitHubWebhookConfig(reader(valid), createClient);
    expect(resolved).toMatchObject({ report: 'none', blockOn: 'never', queueLength: 20, timeoutMs: 8000 });
    expect(createClient).toHaveBeenCalledWith('tok');
  });

  it('rejects an unknown report or blockOn value', () => {
    expect(() => resolveGitHubWebhookConfig(reader({ ...valid, 'jevOperationsSupport.githubWebhook.report': 'comment' }), () => fakeClient)).toThrow('report must be one of');
    expect(() => resolveGitHubWebhookConfig(reader({ ...valid, 'jevOperationsSupport.githubWebhook.blockOn': 'always' }), () => fakeClient)).toThrow('blockOn must be');
  });

  it('caps the synchronous deadline at 8000 ms but allows up to 60000 ms once reporting is on', () => {
    expect(() => resolveGitHubWebhookConfig(reader({ ...valid, 'jevOperationsSupport.githubWebhook.timeoutMs': 20000 }), () => fakeClient)).toThrow('between 1000 and 8000');
    expect(resolveGitHubWebhookConfig(reader({ ...valid, 'jevOperationsSupport.githubWebhook.report': 'status', 'jevOperationsSupport.githubWebhook.timeoutMs': 20000 }), () => fakeClient)?.timeoutMs).toBe(20000);
    expect(() => resolveGitHubWebhookConfig(reader({ ...valid, 'jevOperationsSupport.githubWebhook.report': 'status', 'jevOperationsSupport.githubWebhook.timeoutMs': 70000 }), () => fakeClient)).toThrow('between 1000 and 60000');
  });

  it('rejects an out-of-range queue length', () => {
    expect(() => resolveGitHubWebhookConfig(reader({ ...valid, 'jevOperationsSupport.githubWebhook.queueLength': 0 }), () => fakeClient)).toThrow('queueLength must be an integer between 1 and 200');
    expect(() => resolveGitHubWebhookConfig(reader({ ...valid, 'jevOperationsSupport.githubWebhook.queueLength': 1.5 }), () => fakeClient)).toThrow('queueLength');
  });

  it('still validates the pre-existing repository and documentation path shapes', () => {
    expect(() => resolveGitHubWebhookConfig(reader({ ...valid, 'jevOperationsSupport.githubWebhook.repositories': [] }), () => fakeClient)).toThrow('must contain at least one repository');
    expect(() => resolveGitHubWebhookConfig(reader({ ...valid, 'jevOperationsSupport.githubWebhook.documentationPaths': ['../etc'] }), () => fakeClient)).toThrow('invalid path pattern');
  });

  describe('validation order: report/blockOn/queueLength are checked before "is the webhook configured at all"', () => {
    it('rejects an unknown report value even with no secret/token configured', () => {
      expect(() => resolveGitHubWebhookConfig(reader({ 'jevOperationsSupport.githubWebhook.report': 'comment-only' }))).toThrow('report must be one of');
    });
    it('rejects an unknown blockOn value even with no secret/token configured', () => {
      expect(() => resolveGitHubWebhookConfig(reader({ 'jevOperationsSupport.githubWebhook.blockOn': 'sometimes' }))).toThrow('blockOn must be');
    });
    it('rejects an out-of-range queueLength even with no secret/token configured', () => {
      expect(() => resolveGitHubWebhookConfig(reader({ 'jevOperationsSupport.githubWebhook.queueLength': 0 }))).toThrow('queueLength must be an integer between 1 and 200');
    });
    it('is a startup error to set report other than none without secret and token', () => {
      expect(() => resolveGitHubWebhookConfig(reader({ 'jevOperationsSupport.githubWebhook.report': 'status' }))).toThrow('requires secret and token');
      expect(() => resolveGitHubWebhookConfig(reader({ 'jevOperationsSupport.githubWebhook.report': 'status+comment' }))).toThrow('requires secret and token');
    });
    it('is still undefined (disabled) when report is left at none and nothing else is configured', () => {
      expect(resolveGitHubWebhookConfig(reader({}))).toBeUndefined();
      expect(resolveGitHubWebhookConfig(reader({ 'jevOperationsSupport.githubWebhook.report': 'none' }))).toBeUndefined();
    });
  });

  describe('changeReview', () => {
    it('defaults to a disabled block, no behavioural change from before it existed', () => {
      const resolved = resolveGitHubWebhookConfig(reader(valid), () => fakeClient);
      expect(resolved?.changeReview).toEqual({ enabled: false, paths: [], maxFiles: 20, maxPatchBytes: 12000 });
    });

    it('is validated even when the webhook is otherwise unconfigured', () => {
      expect(() => resolveGitHubWebhookConfig(reader({ 'jevOperationsSupport.githubWebhook.changeReview': { enabled: true } })))
        .toThrow('changeReview.paths must list at least one path glob');
      expect(() => resolveGitHubWebhookConfig(reader({ 'jevOperationsSupport.githubWebhook.changeReview': { enabled: 'yes' } })))
        .toThrow('changeReview.enabled must be a boolean');
    });

    it('refuses enabled: true with report: none -- a result nobody could ever see', () => {
      expect(() => resolveGitHubWebhookConfig(reader({
        ...valid, 'jevOperationsSupport.githubWebhook.report': 'none',
        'jevOperationsSupport.githubWebhook.changeReview': { enabled: true, paths: ['src/**'] },
      }), () => fakeClient)).toThrow('needs report: status or status+comment to be visible');
    });

    it('accepts enabled: true with report: status', () => {
      const resolved = resolveGitHubWebhookConfig(reader({
        ...valid, 'jevOperationsSupport.githubWebhook.report': 'status',
        'jevOperationsSupport.githubWebhook.changeReview': { enabled: true, paths: ['src/**'], maxFiles: 5, maxPatchBytes: 2000 },
      }), () => fakeClient);
      expect(resolved?.changeReview).toEqual({ enabled: true, paths: ['src/**'], maxFiles: 5, maxPatchBytes: 2000 });
    });

    it('requires secret and token when changeReview.enabled is true, even with report left at none', () => {
      expect(() => resolveGitHubWebhookConfig(reader({
        'jevOperationsSupport.githubWebhook.changeReview': { enabled: true, paths: ['src/**'] },
      }))).toThrow(/report: status or status\+comment|requires secret and token/);
    });
  });
});
