import { describe, expect, it } from 'vitest';
import { matchesDocumentationPath, parsePullRequestEvent } from './github';

describe('GitHub webhook document filters', () => {
  it('allows direct and nested paths for a double-star glob', () => {
    expect(matchesDocumentationPath('docs/runbook.md', ['docs/**/*.md'])).toBe(true);
    expect(matchesDocumentationPath('docs/operations/runbook.md', ['docs/**/*.md'])).toBe(true);
    expect(matchesDocumentationPath('docs/runbook.txt', ['docs/**/*.md'])).toBe(false);
  });

  it('requires a repository, PR number, and pinned head SHA', () => {
    const event = parsePullRequestEvent({
      action: 'opened', number: 12, repository: { full_name: 'acme/service' },
      pull_request: { head: { sha: 'a'.repeat(40), repo: { full_name: 'acme/service' } }, base: { sha: 'b'.repeat(40) } },
    });
    expect(event).toMatchObject({ action: 'opened', repository: 'acme/service', pullRequestNumber: 12, headSha: 'a'.repeat(40) });
    expect(parsePullRequestEvent({ action: 'opened', repository: { full_name: 'acme/service' }, pull_request: { head: { sha: 'not-a-sha' } } })).toBeUndefined();
  });
});
