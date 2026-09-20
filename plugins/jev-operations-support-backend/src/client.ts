import { type JevRequest, type JevResponse, validateResponse } from '@namayasai/backstage-plugin-jev-operations-support-common';
import { Buffer } from 'node:buffer';

export class ProviderError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

/** Several modules share this client, so a caller cancellation must not claim a webhook-specific cause. */
function cancelledError(): ProviderError {
  return new ProviderError(503, 'Jev evaluation was cancelled before a decision was returned.');
}

export function createJevClient(options: { apiKey: string; model: string; timeoutMs?: number; fetch?: typeof fetch }) {
  const fetcher = options.fetch ?? fetch;
  return {
    /** The optional caller signal is combined with the client deadline and also bounds the response body read. */
    async evaluate(request: JevRequest, parentSignal?: AbortSignal): Promise<JevResponse> {
      const deadline = AbortSignal.timeout(options.timeoutMs ?? 15000);
      const signal = parentSignal ? AbortSignal.any([parentSignal, deadline]) : deadline;
      try {
        const response = await fetcher('https://api.typesafe.ai/v1/systemone', {
          method: 'POST', redirect: 'error',
          headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...request, model: options.model }),
          signal,
        });
        if (parentSignal?.aborted) throw cancelledError();
        if (!response.ok) {
          // Never reflect provider bodies: they may contain submitted documents or credentials.
          if (response.status === 429 || response.status === 529) throw new ProviderError(503, 'Jev is busy. Wait before retrying.');
          throw new ProviderError(502, `Jev rejected the evaluation (HTTP ${response.status}). Check the backend configuration.`);
        }
        try { return validateResponse(await readWithSignal(() => response.json(), signal), request); }
        catch (error) {
          if (error instanceof ProviderError) throw error;
          if (parentSignal?.aborted) throw cancelledError();
          // A body that never arrives is a deadline, not an invalid decision.
          if (signal.aborted) throw new ProviderError(502, 'Jev could not be reached or timed out. Try again later.');
          throw new ProviderError(502, 'Jev returned an invalid or incomplete response. No decision was accepted.');
        }
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        if (parentSignal?.aborted) throw cancelledError();
        throw new ProviderError(502, 'Jev could not be reached or timed out. Try again later.');
      }
    },
  };
}

/** Applies the deadline to body reading too, for fetch implementations that do not abort the body themselves. */
async function readWithSignal<T>(read: () => Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error('response read aborted'));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([read(), aborted]); }
  finally { if (abort) signal.removeEventListener('abort', abort); }
}

export type GitHubPullRequest = {
  number: number;
  headSha: string;
  baseSha: string;
  headRepoFullName: string;
  /** Forwarded as written to the (opt-in) change-review context — see `changeReview.ts`'s own honesty note that
   * title/description are sent verbatim, with no sensitivity filtering. Absent from GitHub's response only in
   * practice-unreachable cases; falls back to an empty title / null body rather than throwing, since neither field
   * is load-bearing for the readiness path that has used this method for longer than change review has existed. */
  title: string;
  body: string | null;
};

export type GitHubChangedFile = {
  filename: string;
  status?: string;
  /** The following four fields exist only for the opt-in change-review feature (`changeReview.ts` consumes them
   * through `buildChangeReviewContext`); the readiness path never reads them. Populated only by
   * `listChangedFilesForChangeReview` in practice, but parsed here too so both listing methods share one entry
   * parser and neither can drift from the other's idea of a "changed file". */
  additions?: number;
  deletions?: number;
  patch?: string;
  previous_filename?: string;
};

/** Hard ceiling (UTF-16 code units) on a single file's raw `patch` text kept in memory, applied before
 * `changeReview.ts` ever sees it and regardless of whether change review is even enabled for this delivery. GitHub
 * itself does not send a patch for a binary or very large diff, but a large *text* diff's patch can still be
 * several hundred KB; `changeReview.ts` only ever uses up to `maxPatchBytes` (at most 16000) per delivery, so
 * keeping many times that per file is a generous safety margin, not a functional limit — `changeReview.ts`'s own
 * budget accounting truncates far below this regardless. */
const MAX_RAW_PATCH_CODE_UNITS = 200_000;

/** Truncates to at most `maxUnits` UTF-16 code units without splitting a surrogate pair, used only for the raw
 * patch ceiling above — a local copy rather than importing `changeReview.ts`'s equivalent private helper, since
 * this client module must stay usable (and testable) without pulling in the change-review core at all. */
function truncateCodeUnitsSafe(value: string, maxUnits: number): string {
  if (value.length <= maxUnits) return value;
  let cut = value.slice(0, maxUnits);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
}

export type GitHubFile = {
  path: string;
  content: string;
  size: number;
};

export class GitHubClientError extends Error {
  /** The HTTP status GitHub returned, when there was one — absent for a transport-level failure (DNS, TLS, a
   * connection that never completed at all). Callers that retry a write use this instead of `retryable` alone to
   * tell a rate limit or a transient server error (worth retrying) apart from a permission or not-found error
   * (retrying changes nothing). */
  constructor(public readonly retryable: boolean, message: string, public readonly status?: number) {
    super(message);
    this.name = 'GitHubClientError';
  }
}

export class GitHubLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubLimitError';
  }
}

/** A bounded response body, distinct from file-count or document limits. */
export class GitHubResponseSizeError extends GitHubLimitError {
  constructor() { super('GitHub response exceeded the configured response size limit.'); this.name = 'GitHubResponseSizeError'; }
}

export type GitHubClient = ReturnType<typeof createGitHubClient>;

/** GitHub's commit status states. There is deliberately no `pending` retry loop here: the caller decides when to move a status forward. */
export type GitHubCommitStatusState = 'pending' | 'success' | 'failure' | 'error';

export type GitHubIssueComment = { id: number; body: string; login: string };

export function createGitHubClient(options: {
  token: string;
  fetch?: typeof fetch;
  /** Test-only override; production always uses the fixed api.github.com origin. */
  apiBaseUrl?: string;
  maxResponseBytes?: number;
}) {
  const fetcher = options.fetch ?? fetch;
  const apiBase = new URL(options.apiBaseUrl ?? 'https://api.github.com/');
  const maxResponseBytes = options.maxResponseBytes ?? 1024 * 1024;
  // Cached once per client: the token's identity never changes mid-process, and every write path needs it
  // to find its own prior comment without trusting an unauthenticated `login` field from the payload.
  let cachedLogin: Promise<string> | undefined;

  async function request(path: string, init: { method: string; body?: unknown }, signal: AbortSignal): Promise<Response> {
    try {
      return await fetcher(new URL(path, apiBase).toString(), {
        method: init.method,
        redirect: 'error',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${options.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'backstage-jev-operations-support',
          ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal,
      });
    } catch {
      throw new GitHubClientError(true, 'GitHub could not be reached or the request timed out. Redeliver the event manually.');
    }
  }

  async function readJsonBody<T>(response: Response, signal: AbortSignal): Promise<T> {
    const status = response.status;
    let bytes: ArrayBuffer;
    try { bytes = await readWithSignal(() => response.arrayBuffer(), signal); }
    catch { throw new GitHubClientError(true, 'GitHub returned an unreadable response. Redeliver the event manually.', status); }
    if (bytes.byteLength > maxResponseBytes) throw new GitHubResponseSizeError();
    if (!response.ok) {
      if (status === 404) throw new GitHubClientError(false, 'The GitHub pull request or repository is no longer available.', status);
      // 401 (bad/expired token) and 422 (malformed request) will not succeed on retry; 403 (which GitHub also uses
      // for its secondary rate limit, alongside real permission errors) and 429, plus any 5xx, are worth retrying.
      if (status === 401 || status === 422) throw new GitHubClientError(false, 'GitHub rejected the API request. Check the configured token.', status);
      const retryable = status === 403 || status === 429 || status >= 500;
      throw new GitHubClientError(retryable, 'GitHub rejected the API request. Check the configured token and redeliver the event manually.', status);
    }
    try { return JSON.parse(new TextDecoder().decode(bytes)) as T; }
    catch { throw new GitHubClientError(true, 'GitHub returned invalid JSON. Redeliver the event manually.', status); }
  }

  async function getJson<T>(path: string, signal: AbortSignal): Promise<T> {
    return readJsonBody<T>(await request(path, { method: 'GET' }, signal), signal);
  }

  /** Parses one raw pull-request-files entry into `GitHubChangedFile`, shared by both listing methods below so
   * neither can drift from the other's idea of what fields a "changed file" carries. `includePatchFields` is
   * false for every readiness read (`listChangedFiles`, and a `listChangedFilesTolerant` call with change review
   * disabled): `additions`/`deletions`/`patch`/`previous_filename` are then never even parsed out of the raw
   * response, let alone retained in the returned objects -- not merely unused by readiness, but genuinely absent
   * from what this module keeps in memory when change review is off (F7: no new data retained on the
   * unaffected path). */
  function parseChangedFileEntry(file: unknown, includePatchFields: boolean): GitHubChangedFile {
    const value = file as { filename?: unknown; status?: unknown; additions?: unknown; deletions?: unknown; patch?: unknown; previous_filename?: unknown };
    const filename = typeof value.filename === 'string' ? value.filename : '';
    if (!filename) throw new GitHubClientError(true, 'GitHub returned an invalid changed-file entry. Redeliver the event manually.');
    const status = typeof value.status === 'string' ? value.status : undefined;
    if (!includePatchFields) return { filename, status };
    const additions = typeof value.additions === 'number' ? value.additions : undefined;
    const deletions = typeof value.deletions === 'number' ? value.deletions : undefined;
    const patch = typeof value.patch === 'string' ? truncateCodeUnitsSafe(value.patch, MAX_RAW_PATCH_CODE_UNITS) : undefined;
    const previous_filename = typeof value.previous_filename === 'string' ? value.previous_filename : undefined;
    return { filename, status, additions, deletions, patch, previous_filename };
  }

  /**
   * Shared pagination for the pull-request files endpoint, used by both `listChangedFiles` (`mode: 'throw'`,
   * readiness's all-or-nothing behaviour -- `perPage` fixed at 100,
   * `includePatchFields` always false) and `listChangedFilesTolerant` (`mode: 'tolerant'`, used only by the
   * background queue worker -- truncates instead of throwing, and can be asked to keep `patch`/`additions`/
   * `deletions`/`previous_filename`, which `listChangedFiles` never parses).
   *
   * Count limits return the collected files with `truncated: true`. Response-size limits do the same after
   * page 1; on page 1 a response-size limit throws because nothing usable has been parsed yet:
   *  - the file-count/page-count limit (`maxFiles`/`maxPages`), exactly as `listChangedFiles` already enforced;
   *  - a single page's response exceeding `maxResponseBytes` (1 MiB by default) -- realistic once `patch` fields
   *    are included, since a page of 100 large diffs can exceed that on its own. `readJsonBody` already throws
   *    `GitHubResponseSizeError` for this; caught here by type so it can be
   *    downgraded to a truncation past page 1, exactly like the count-based limit above.
   */
  async function paginateChangedFiles(
    repository: string, pullRequestNumber: number,
    optionsForList: { maxPages: number; maxFiles: number; perPage: number; includePatchFields: boolean },
    signal: AbortSignal, mode: 'throw' | 'tolerant',
  ): Promise<{ files: GitHubChangedFile[]; truncated: boolean }> {
    const all: GitHubChangedFile[] = [];
    const { perPage } = optionsForList;
    for (let page = 1; page <= optionsForList.maxPages; page++) {
      let raw: unknown;
      let link: string | null = null;
      try {
        const response = await request(`/repos/${encodeRepository(repository)}/pulls/${pullRequestNumber}/files?per_page=${perPage}&page=${page}`, { method: 'GET' }, signal);
        link = response.headers.get('link');
        raw = await readJsonBody<unknown>(response, signal);
      } catch (error) {
        // A response-size failure on page 1 means NOTHING was collected at all -- there is no partial result to
        // truncate to, so this is a genuine error for every caller (`mode` does not matter here). Past page 1, a
        // tolerant caller already has real, honest data to fall back to.
        if (mode === 'tolerant' && page > 1 && error instanceof GitHubResponseSizeError) return { files: all, truncated: true };
        throw error;
      }
      // The pull request files endpoint returns a JSON array of file entries.
      const files = Array.isArray(raw) ? (raw as unknown[]) : undefined;
      if (!files) throw new GitHubClientError(true, 'GitHub returned no changed-file list. Redeliver the event manually.');
      if (files.length > perPage || all.length + files.length > optionsForList.maxFiles) {
        if (mode === 'throw') throw new GitHubLimitError('The pull request changed more files than the configured limit.');
        const remaining = Math.max(0, optionsForList.maxFiles - all.length);
        for (const file of files.slice(0, remaining)) all.push(parseChangedFileEntry(file, optionsForList.includePatchFields));
        return { files: all, truncated: true };
      }
      for (const file of files) all.push(parseChangedFileEntry(file, optionsForList.includePatchFields));
      // A full final page is complete when GitHub explicitly omits a next link. If the whole header is
      // missing, retain the conservative count-based fallback used by older proxies and clients.
      if (files.length < perPage || (link !== null && !/;\s*rel="next"/.test(link))) return { files: all, truncated: false };
    }
    if (mode === 'throw') throw new GitHubLimitError('The pull request changed-file list exceeded the configured page limit.');
    return { files: all, truncated: true };
  }

  /** A write only needs to know it did not fail; the body (if any) is not consumed by any caller today. */
  async function writeJson(path: string, method: 'POST' | 'PATCH', body: unknown, signal: AbortSignal): Promise<void> {
    const response = await request(path, { method, body }, signal);
    await readJsonBody<unknown>(response, signal);
  }

  return {
    async getPullRequest(repository: string, number: number, signal: AbortSignal): Promise<GitHubPullRequest> {
      const raw = await getJson<unknown>(`/repos/${encodeRepository(repository)}/pulls/${number}`, signal);
      const value = raw as { number?: unknown; head?: { sha?: unknown; repo?: { full_name?: unknown } | null }; base?: { sha?: unknown }; title?: unknown; body?: unknown };
      const headSha = typeof value.head?.sha === 'string' ? value.head.sha : '';
      const baseSha = typeof value.base?.sha === 'string' ? value.base.sha : '';
      const headRepoFullName = typeof value.head?.repo?.full_name === 'string' ? value.head.repo.full_name : '';
      if (!isSha(headSha) || !isSha(baseSha) || !isRepository(headRepoFullName)) {
        throw new GitHubClientError(true, 'GitHub returned an incomplete pull request. Redeliver the event manually.');
      }
      // title/body are only ever consumed by the opt-in change-review path (`changeReview.ts`, forwarded exactly
      // as written -- see its own honesty note). Neither is load-bearing for the readiness path this method has
      // served for longer, so a missing/malformed value falls back rather than failing the whole read.
      const title = typeof value.title === 'string' ? value.title : '';
      const body = typeof value.body === 'string' ? value.body : null;
      return { number, headSha, baseSha, headRepoFullName, title, body };
    },

    /** Used only by the synchronous (`report: none`) webhook path. Byte-for-byte unchanged: fixed `perPage: 100`,
     * throws on any limit, never parses `additions`/`deletions`/`patch`/`previous_filename`. */
    async listChangedFiles(repository: string, pullRequestNumber: number, optionsForList: { maxPages: number; maxFiles: number }, signal: AbortSignal): Promise<GitHubChangedFile[]> {
      const { files } = await paginateChangedFiles(repository, pullRequestNumber, { ...optionsForList, perPage: 100, includePatchFields: false }, signal, 'throw');
      return files;
    },

    /**
     * Used only by the background queue worker (`router.ts`'s `processQueueJob`), ONCE per delivery, shared by
     * both readiness and change review -- see the module doc comment on `paginateChangedFiles` for exactly how
     * and when this truncates instead of throwing. `includePatchFields` should be true only when
     * `changeReview.enabled`; when false, this call parses and retains nothing beyond `filename`/`status`, exactly
     * like `listChangedFiles` above (F7: no new data retained on the readiness-only path).
     *
     * `perPage` defaults to 100 (matching `listChangedFiles`) but the caller should pass a SMALLER value when
     * `includePatchFields` is true: a page of 100 entries each carrying a real diff `patch` can exceed the 1 MiB
     * response cap on realistic pull requests, which would otherwise show up as truncation on page 1 of a
     * perfectly ordinary-sized PR. See `router.ts`'s own constant and comment for the exact number chosen and why.
     */
    async listChangedFilesTolerant(repository: string, pullRequestNumber: number, optionsForList: { maxPages: number; maxFiles: number; perPage?: number; includePatchFields: boolean }, signal: AbortSignal): Promise<{ files: GitHubChangedFile[]; truncated: boolean }> {
      return paginateChangedFiles(repository, pullRequestNumber, { ...optionsForList, perPage: optionsForList.perPage ?? 100 }, signal, 'tolerant');
    },

    async getFile(repository: string, path: string, ref: string, maxFileBytes: number, signal: AbortSignal): Promise<GitHubFile> {
      const raw = await getJson<unknown>(`/repos/${encodeRepository(repository)}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`, signal);
      const value = raw as { type?: unknown; path?: unknown; encoding?: unknown; content?: unknown; size?: unknown };
      const size = typeof value.size === 'number' ? value.size : -1;
      if (value.type !== 'file' || value.encoding !== 'base64' || typeof value.content !== 'string' || value.path !== path || !Number.isSafeInteger(size) || size < 0) {
        throw new GitHubClientError(true, 'GitHub returned an invalid document response. Redeliver the event manually.');
      }
      if (size > maxFileBytes) throw new GitHubLimitError(`Document ${path} exceeded the configured file size limit.`);
      let decoded: Buffer;
      const encoded = value.content.replace(/\s/g, '');
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1) throw new GitHubClientError(true, 'GitHub returned invalid document content. Redeliver the event manually.');
      try { decoded = Buffer.from(encoded, 'base64'); }
      catch { throw new GitHubClientError(true, 'GitHub returned invalid document content. Redeliver the event manually.'); }
      if (decoded.byteLength > maxFileBytes) throw new GitHubLimitError(`Document ${path} exceeded the configured file size limit.`);
      let content: string;
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(decoded); }
      catch { throw new GitHubClientError(false, `Document ${path} is not valid UTF-8 Markdown.`); }
      return { path: value.path, content, size: decoded.byteLength };
    },

    /** The identity behind the configured token, used to find this integration's own prior comment rather than trust an unauthenticated payload field. */
    async getAuthenticatedLogin(signal: AbortSignal): Promise<string> {
      if (!cachedLogin) {
        cachedLogin = (async () => {
          const raw = await getJson<unknown>('/user', signal);
          const login = typeof (raw as { login?: unknown }).login === 'string' ? (raw as { login: string }).login : '';
          if (!login) throw new GitHubClientError(true, 'GitHub returned no authenticated user for the configured token.');
          return login;
        })().catch(error => { cachedLogin = undefined; throw error; });
      }
      return cachedLogin;
    },

    /** Requires `repo:status` (classic) or Commit statuses: write (fine-grained). Never persists; the caller decides the final state. */
    async createCommitStatus(repository: string, sha: string, status: { state: GitHubCommitStatusState; description: string; context: string; targetUrl?: string }, signal: AbortSignal): Promise<void> {
      await writeJson(`/repos/${encodeRepository(repository)}/statuses/${encodeURIComponent(sha)}`, 'POST', {
        state: status.state, description: status.description, context: status.context,
        ...(status.targetUrl ? { target_url: status.targetUrl } : {}),
      }, signal);
    },

    /** Paginates only up to `maxPages`, newest comments first. The issue-comments endpoint (unlike the repo-level
     * events endpoint) has no `sort`/`direction` query parameters of its own — it is always oldest-first — so
     * "newest first" is done by reading pages from the END backwards: page 1 is fetched once to learn the total
     * page count from its `Link: rel="last"` response header (absent means there is only one page), then up to
     * `maxPages` pages are read starting from that last page and working backwards, each page's own comments
     * reversed so the very newest comment overall is checked first. A marker on a comment older than the
     * `maxPages`-page window from the end is treated as absent rather than read without bound; the caller then
     * creates a new comment instead of updating the old one. */
    async listIssueComments(repository: string, pullRequestNumber: number, optionsForList: { maxPages: number }, signal: AbortSignal): Promise<GitHubIssueComment[]> {
      const perPage = 100;
      const basePath = `/repos/${encodeRepository(repository)}/issues/${pullRequestNumber}/comments`;

      async function fetchPage(page: number): Promise<GitHubIssueComment[]> {
        const raw = await getJson<unknown>(`${basePath}?per_page=${perPage}&page=${page}`, signal);
        const comments = Array.isArray(raw) ? (raw as unknown[]) : undefined;
        if (!comments) throw new GitHubClientError(true, 'GitHub returned no issue comment list. The report comment was not written.');
        const parsed: GitHubIssueComment[] = [];
        for (const comment of comments) {
          const value = comment as { id?: unknown; body?: unknown; user?: { login?: unknown } | null };
          if (typeof value.id === 'number' && typeof value.body === 'string') {
            parsed.push({ id: value.id, body: value.body, login: typeof value.user?.login === 'string' ? value.user.login : '' });
          }
        }
        return parsed;
      }

      const firstResponse = await request(`${basePath}?per_page=${perPage}&page=1`, { method: 'GET' }, signal);
      const lastPage = parseLastPageFromLinkHeader(firstResponse.headers.get('link')) ?? 1;
      const firstPage = await readJsonBody<unknown>(firstResponse, signal);
      const firstPageComments = (() => {
        const comments = Array.isArray(firstPage) ? (firstPage as unknown[]) : undefined;
        if (!comments) throw new GitHubClientError(true, 'GitHub returned no issue comment list. The report comment was not written.');
        const parsed: GitHubIssueComment[] = [];
        for (const comment of comments) {
          const value = comment as { id?: unknown; body?: unknown; user?: { login?: unknown } | null };
          if (typeof value.id === 'number' && typeof value.body === 'string') {
            parsed.push({ id: value.id, body: value.body, login: typeof value.user?.login === 'string' ? value.user.login : '' });
          }
        }
        return parsed;
      })();

      if (lastPage <= 1) return firstPageComments.slice().reverse();

      const pagesToRead = Math.min(optionsForList.maxPages, lastPage);
      const all: GitHubIssueComment[] = [];
      for (let i = 0; i < pagesToRead; i++) {
        const page = lastPage - i;
        // Page 1 was already fetched above (its content is only reused here in the rare case that the window of
        // `maxPages` pages counted back from the end reaches all the way to it).
        const comments = page === 1 ? firstPageComments : await fetchPage(page);
        all.push(...comments.slice().reverse());
      }
      return all;
    },

    /** Requires `public_repo`/`repo` (classic) or Pull requests / Issues: write (fine-grained). */
    async createIssueComment(repository: string, pullRequestNumber: number, body: string, signal: AbortSignal): Promise<void> {
      await writeJson(`/repos/${encodeRepository(repository)}/issues/${pullRequestNumber}/comments`, 'POST', { body }, signal);
    },

    async updateIssueComment(repository: string, commentId: number, body: string, signal: AbortSignal): Promise<void> {
      await writeJson(`/repos/${encodeRepository(repository)}/issues/comments/${commentId}`, 'PATCH', { body }, signal);
    },
  };
}

function encodeRepository(repository: string): string {
  return repository.split('/').map(encodeURIComponent).join('/');
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

/** GitHub's pagination `Link` header looks like `<...&page=2>; rel="next", <...&page=9>; rel="last"`. Returns
 * `undefined` when there is no `rel="last"` entry at all, which GitHub omits when everything fits on one page. */
function parseLastPageFromLinkHeader(header: string | null): number | undefined {
  if (!header) return undefined;
  const match = header.match(/<[^>]*[?&]page=(\d+)[^>]*>;\s*rel="last"/);
  return match ? Number(match[1]) : undefined;
}

function isSha(value: string): boolean { return /^[0-9a-f]{7,64}$/i.test(value); }
function isRepository(value: string): boolean { return /^[^/\s]+\/[^/\s]+$/.test(value); }
