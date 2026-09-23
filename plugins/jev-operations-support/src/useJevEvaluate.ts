import { useApi, discoveryApiRef, fetchApiRef } from '@backstage/core-plugin-api';
import { useCallback } from 'react';
import type { EvaluationRequest, EvaluationResult } from '@namayasai/backstage-plugin-jev-operations-support-common';
import type { EvaluateOptions } from './useLiveEvaluation';

function errorMessage(payload: unknown): string | undefined {
  if (typeof payload === 'string' && payload.trim()) return payload.trim();
  if (!payload || typeof payload !== 'object') return undefined;
  const value = payload as Record<string, unknown>;
  if (typeof value.message === 'string' && value.message.trim()) return value.message.trim();
  if (typeof value.error === 'string' && value.error.trim()) return value.error.trim();
  if (value.error && typeof value.error === 'object') return errorMessage(value.error);
  return undefined;
}

function retryAfterMessage(value: string | null): string {
  if (!value) return '';
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return ` Retry after ${Math.ceil(seconds)} seconds.`;
  const date = Date.parse(value);
  if (Number.isFinite(date)) return ` Retry after ${Math.max(0, Math.ceil((date - Date.now()) / 1000))} seconds.`;
  return ` Retry according to the server's Retry-After value (${value}).`;
}

/** Milliseconds until the server says to retry, when that header parses as either form. */
function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

/** Convert an HTTP error into a readable message without reflecting HTML or object coercion. */
export async function responseError(response: Response, action: string): Promise<Error> {
  let payload: unknown;
  try { payload = await response.json(); } catch { payload = undefined; }
  const message = errorMessage(payload) ?? `${action} (HTTP ${response.status}).`;
  const error: Error & { retryAfterMs?: number } = new Error(`${message}${retryAfterMessage(response.headers.get('Retry-After'))}`);
  // Carried separately from the message so useLiveEvaluation's backoff can honour the server's own timing.
  const ms = retryAfterMs(response.headers.get('Retry-After'));
  if (ms !== undefined) error.retryAfterMs = ms;
  return error;
}

/**
 * The evaluate call shared by every place this plugin sends a request to the backend's
 * `/evaluate` route: discover the base URL, post the request, and turn a failed response
 * into a readable, backoff-aware error. Returns a stable function identity so callers that
 * feed it into `useLiveEvaluation` do not restart the quiet period on every render.
 */
export function useJevEvaluate(): (request: EvaluationRequest, options?: EvaluateOptions) => Promise<EvaluationResult> {
  const discovery = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);
  return useCallback(async (input: EvaluationRequest, options?: EvaluateOptions): Promise<EvaluationResult> => {
    const url = await discovery.getBaseUrl('jev-operations-support');
    const response = await fetchApi.fetch(`${url}/evaluate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: options?.signal });
    if (!response.ok) throw await responseError(response, 'Evaluation failed');
    try { return await response.json() as EvaluationResult; }
    catch { throw new Error('Evaluation returned a non-JSON response.'); }
  }, [discovery, fetchApi]);
}

/**
 * Asks the backend for response suggestions for one earlier assessment, identified only by the
 * short-lived reference the backend issued with it. The response is validated where it is shown.
 */
export function useJevResponsePlan(): (ref: string, options?: EvaluateOptions) => Promise<unknown> {
  const discovery = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);
  return useCallback(async (ref: string, options?: EvaluateOptions): Promise<unknown> => {
    const url = await discovery.getBaseUrl('jev-operations-support');
    const response = await fetchApi.fetch(`${url}/response-plan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ref }), signal: options?.signal });
    if (!response.ok) throw await responseError(response, 'Response suggestions could not be generated');
    try { return await response.json(); }
    catch { throw new Error('Response suggestions returned a non-JSON response.'); }
  }, [discovery, fetchApi]);
}
