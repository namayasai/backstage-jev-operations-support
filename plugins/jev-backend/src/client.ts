import { type JevRequest, type JevResponse, validateResponse } from '@namayasai/backstage-plugin-jev-common';

export class ProviderError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

export function createJevClient(options: { apiKey: string; model: string; timeoutMs?: number; fetch?: typeof fetch }) {
  const fetcher = options.fetch ?? fetch;
  return {
    async evaluate(request: JevRequest): Promise<JevResponse> {
      let response: Response;
      try {
        response = await fetcher('https://api.typesafe.ai/v1/systemone', {
          method: 'POST', redirect: 'error',
          headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...request, model: options.model }),
          signal: AbortSignal.timeout(options.timeoutMs ?? 15000),
        });
      } catch {
        throw new ProviderError(502, 'Jev could not be reached or timed out. Try again later.');
      }
      if (!response.ok) {
        // Never reflect provider bodies: they may contain submitted documents or credentials.
        if (response.status === 429 || response.status === 529) throw new ProviderError(503, 'Jev is busy. Wait before retrying.');
        throw new ProviderError(502, `Jev rejected the evaluation (HTTP ${response.status}). Check the backend configuration.`);
      }
      try { return validateResponse(await response.json(), request); }
      catch { throw new ProviderError(502, 'Jev returned an invalid or incomplete response. No decision was accepted.'); }
    },
  };
}
