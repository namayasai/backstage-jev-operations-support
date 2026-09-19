import { type JevRequest, type JevResponse, validateResponse } from '@namayasai/backstage-plugin-jev-operations-support-common';
import { Buffer } from 'node:buffer';

export class ProviderError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

export function createJevClient(options: { apiKey: string; model: string; timeoutMs?: number; fetch?: typeof fetch }) {
  const fetcher = options.fetch ?? fetch;
  return {
    async evaluate(request: JevRequest, parentSignal?: AbortSignal): Promise<JevResponse> {
      const timeout = createTimeoutSignal(parentSignal, options.timeoutMs ?? 15000);
      try {
        const response = await fetcher('https://api.typesafe.ai/v1/systemone', {
          method: 'POST', redirect: 'error',
          headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...request, model: options.model }),
          signal: timeout.signal,
        });
        if (parentSignal?.aborted) throw new ProviderError(503, 'Jev evaluation exceeded the webhook deadline. Redeliver the event manually.');
        if (!response.ok) {
          // Never reflect provider bodies: they may contain submitted documents or credentials.
          if (response.status === 429 || response.status === 529) throw new ProviderError(503, 'Jev is busy. Wait before retrying.');
          throw new ProviderError(502, `Jev rejected the evaluation (HTTP ${response.status}). Check the backend configuration.`);
        }
        try { return validateResponse(await readJsonWithSignal(response, timeout.signal), request); }
        catch (error) {
          if (error instanceof ProviderError) throw error;
          if (parentSignal?.aborted) throw new ProviderError(503, 'Jev evaluation exceeded the webhook deadline. Redeliver the event manually.');
          throw new ProviderError(502, 'Jev returned an invalid or incomplete response. No decision was accepted.');
        }
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        if (parentSignal?.aborted) throw new ProviderError(503, 'Jev evaluation exceeded the webhook deadline. Redeliver the event manually.');
        throw new ProviderError(502, 'Jev could not be reached or timed out. Try again later.');
      } finally {
        timeout.cleanup();
      }
    },
  };
}

async function readJsonWithSignal(response: Response, signal: AbortSignal): Promise<unknown> {
  let abort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error('response read aborted'));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([response.json(), aborted]); }
  finally { if (abort) signal.removeEventListener('abort', abort); }
}

async function readArrayBufferWithSignal(response: Response, signal: AbortSignal): Promise<ArrayBuffer> {
  let abort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error('response read aborted'));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([response.arrayBuffer(), aborted]); }
  finally { if (abort) signal.removeEventListener('abort', abort); }
}

function createTimeoutSignal(parentSignal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort(parentSignal?.reason);
  if (parentSignal) {
    if (parentSignal.aborted) abort();
    else parentSignal.addEventListener('abort', abort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', abort);
    },
  };
}

export type GitHubPullRequest = {
  number: number;
  headSha: string;
  baseSha: string;
  headRepoFullName: string;
};

export type GitHubChangedFile = {
  filename: string;
  status?: string;
};

export type GitHubFile = {
  path: string;
  content: string;
  size: number;
};

export class GitHubClientError extends Error {
  constructor(public readonly retryable: boolean, message: string) {
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

export type GitHubClient = ReturnType<typeof createGitHubClient>;

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

  async function getJson<T>(path: string, signal: AbortSignal): Promise<T> {
    let response: Response;
    try {
      response = await fetcher(new URL(path, apiBase).toString(), {
        method: 'GET',
        redirect: 'error',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${options.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'backstage-jev-operations-support',
        },
        signal,
      });
    } catch {
      throw new GitHubClientError(true, 'GitHub could not be reached or the request timed out. Redeliver the event manually.');
    }
    let bytes: ArrayBuffer;
    try { bytes = await readArrayBufferWithSignal(response, signal); }
    catch { throw new GitHubClientError(true, 'GitHub returned an unreadable response. Redeliver the event manually.'); }
    if (bytes.byteLength > maxResponseBytes) throw new GitHubLimitError('GitHub response exceeded the configured response size limit.');
    if (!response.ok) {
      if (response.status === 404) throw new GitHubClientError(false, 'The GitHub pull request or repository is no longer available.');
      throw new GitHubClientError(true, 'GitHub rejected the API request. Check the configured token and redeliver the event manually.');
    }
    try { return JSON.parse(new TextDecoder().decode(bytes)) as T; }
    catch { throw new GitHubClientError(true, 'GitHub returned invalid JSON. Redeliver the event manually.'); }
  }

  return {
    async getPullRequest(repository: string, number: number, signal: AbortSignal): Promise<GitHubPullRequest> {
      const raw = await getJson<unknown>(`/repos/${encodeRepository(repository)}/pulls/${number}`, signal);
      const value = raw as { number?: unknown; head?: { sha?: unknown; repo?: { full_name?: unknown } | null }; base?: { sha?: unknown } };
      const headSha = typeof value.head?.sha === 'string' ? value.head.sha : '';
      const baseSha = typeof value.base?.sha === 'string' ? value.base.sha : '';
      const headRepoFullName = typeof value.head?.repo?.full_name === 'string' ? value.head.repo.full_name : '';
      if (!isSha(headSha) || !isSha(baseSha) || !isRepository(headRepoFullName)) {
        throw new GitHubClientError(true, 'GitHub returned an incomplete pull request. Redeliver the event manually.');
      }
      return { number, headSha, baseSha, headRepoFullName };
    },

    async listChangedFiles(repository: string, pullRequestNumber: number, optionsForList: { maxPages: number; maxFiles: number }, signal: AbortSignal): Promise<GitHubChangedFile[]> {
      const all: GitHubChangedFile[] = [];
      const perPage = 100;
      for (let page = 1; page <= optionsForList.maxPages; page++) {
        const raw = await getJson<unknown>(`/repos/${encodeRepository(repository)}/pulls/${pullRequestNumber}/files?per_page=${perPage}&page=${page}`, signal);
        const files = Array.isArray((raw as { files?: unknown }).files) ? (raw as { files: unknown[] }).files : undefined;
        if (!files) throw new GitHubClientError(true, 'GitHub returned no changed-file list. Redeliver the event manually.');
        if (files.length > perPage || all.length + files.length > optionsForList.maxFiles) throw new GitHubLimitError('The pull request changed more files than the configured limit.');
        for (const file of files) {
          const filename = typeof (file as { filename?: unknown }).filename === 'string' ? (file as { filename: string }).filename : '';
          const status = typeof (file as { status?: unknown }).status === 'string' ? (file as { status: string }).status : undefined;
          if (!filename) throw new GitHubClientError(true, 'GitHub returned an invalid changed-file entry. Redeliver the event manually.');
          all.push({ filename, status });
        }
        if (files.length < perPage) return all;
      }
      throw new GitHubLimitError('The pull request changed-file list exceeded the configured page limit.');
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
  };
}

function encodeRepository(repository: string): string {
  return repository.split('/').map(encodeURIComponent).join('/');
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

function isSha(value: string): boolean { return /^[0-9a-f]{7,64}$/i.test(value); }
function isRepository(value: string): boolean { return /^[^/\s]+\/[^/\s]+$/.test(value); }
