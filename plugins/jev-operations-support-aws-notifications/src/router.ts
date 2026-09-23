import express from 'express';
import type { AuthService, DiscoveryService, HttpAuthService, LoggerService } from '@backstage/backend-plugin-api';
import type { JsonValue } from '@backstage/types';
import { awsAlertNotificationOrigin, awsAlertNotificationTopic, awsMetadataKey } from './constants';
import type { AwsAlertDetailsStore, StoredAwsAlertDetails } from './store';
import { resolveAlertServices, type AlertServiceContext, type ServiceBinding } from './serviceBindings';
import type { CatalogApi } from '@backstage/catalog-client';

export const awsAlertsRoutePath = '/aws-alerts';
export const defaultAwsAlertPageLimit = 20;
export const maxAwsAlertPageLimit = 50;
export const maxAwsAlertPageOffset = 10_000;

export type AwsAlertsRouterOptions = {
  httpAuth: Pick<HttpAuthService, 'credentials'>;
  auth: Pick<AuthService, 'getPluginRequestToken'>;
  discovery: Pick<DiscoveryService, 'getBaseUrl'>;
  store: AwsAlertDetailsStore;
  logger: Pick<LoggerService, 'warn' | 'error'>;
  fetch?: typeof globalThis.fetch;
  /** Administrator-declared alarm-to-service bindings. Empty or absent: no service context is attached. */
  serviceBindings?: readonly ServiceBinding[];
  /** Read with the signed-in reader's own token, so catalog permissions decide what they see. */
  catalog?: Pick<CatalogApi, 'getEntitiesByRefs'>;
  catalogTimeoutMs?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Reject an out-of-range or non-numeric page parameter instead of silently clamping it. */
function boundedInteger(raw: unknown, fallback: number, min: number, max: number): number | undefined {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'string' || !/^\d{1,6}$/.test(raw)) return undefined;
  const value = Number(raw);
  return value >= min && value <= max ? value : undefined;
}

/**
 * An alert this module wrote for this user. The origin check means another plugin
 * cannot publish into the fixed topic and have its rows enriched from this table.
 */
function isOwnAwsAlert(row: unknown): row is { payload: Record<string, unknown> } {
  if (!isRecord(row) || row.origin !== awsAlertNotificationOrigin) return false;
  return isRecord(row.payload) && row.payload.topic === awsAlertNotificationTopic;
}

function scopeOf(row: { payload: Record<string, unknown> }): string | undefined {
  const scope = row.payload.scope;
  return typeof scope === 'string' && scope ? scope : undefined;
}

/**
 * `GET /aws-alerts` returns the signed-in user's own AWS alert notifications, read
 * from the standard Notifications backend on behalf of that user, with the
 * structured detail this module stores restored into `payload.metadata`.
 *
 * Recipient isolation, read/saved state, and inbox identity stay with Notifications:
 * this route never reads all users' notifications and never accepts a caller-supplied
 * scope or notification id.
 */
export function createAwsAlertsRouter(options: AwsAlertsRouterOptions): express.Router {
  const { httpAuth, auth, discovery, store, logger } = options;
  const fetchApi = options.fetch ?? globalThis.fetch;
  const router = express.Router();

  router.get(awsAlertsRoutePath, async (req, res, next) => {
    try {
      const credentials = await httpAuth.credentials(req, { allow: ['user'] });
      const limit = boundedInteger(req.query.limit, defaultAwsAlertPageLimit, 1, maxAwsAlertPageLimit);
      const offset = boundedInteger(req.query.offset, 0, 0, maxAwsAlertPageOffset);
      if (limit === undefined || offset === undefined) {
        res.status(400).json({ error: `limit must be between 1 and ${maxAwsAlertPageLimit} and offset between 0 and ${maxAwsAlertPageOffset}.` });
        return;
      }

      const { token } = await auth.getPluginRequestToken({ onBehalfOf: credentials, targetPluginId: 'notifications' });
      const url = new URL(await discovery.getBaseUrl('notifications'));
      url.searchParams.set('topic', awsAlertNotificationTopic);
      url.searchParams.set('limit', String(limit));
      url.searchParams.set('offset', String(offset));
      const upstream = await fetchApi(url.toString(), { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
      if (!upstream.ok) {
        logger.warn(`The Notifications backend rejected an AWS alert query with HTTP ${upstream.status}`);
        res.status(502).json({ error: `AWS alerts could not be read from the Backstage Notifications backend (HTTP ${upstream.status}).` });
        return;
      }
      let body: unknown;
      try { body = await upstream.json(); } catch { body = undefined; }
      if (!isRecord(body) || !Array.isArray(body.notifications)) {
        res.status(502).json({ error: 'The Backstage Notifications backend returned an unexpected response.' });
        return;
      }

      const alerts = body.notifications.filter(isOwnAwsAlert);
      // Only scopes that came back from the user's own authorized page are looked up.
      const stored = await readDetails(store, alerts.map(scopeOf).filter((scope): scope is string => Boolean(scope)), logger);
      const services = await readServices(options, credentials, [...stored.values()].map(row => row.details.alarmArn), logger);
      const notifications = alerts.map(row => {
        const scope = scopeOf(row);
        const details = scope ? stored.get(scope) : undefined;
        if (!details) return row;
        const service = services?.get(details.details.alarmArn);
        return {
          ...row,
          payload: {
            ...row.payload,
            metadata: {
              ...(isRecord(row.payload.metadata) ? row.payload.metadata : {}),
              [awsMetadataKey]: { ...details.details, updatedAt: details.updatedAt, ...(service ? { service } : {}) } as unknown as JsonValue,
            },
          },
        };
      });
      const totalCount = typeof body.totalCount === 'number' && Number.isFinite(body.totalCount) && body.totalCount >= 0
        ? Math.floor(body.totalCount)
        : notifications.length;
      res.json({ totalCount, notifications });
    } catch (error) {
      next(error);
    }
  });

  router.use((error: { name?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = error?.name === 'AuthenticationError' ? 401 : error?.name === 'NotAllowedError' ? 403 : 500;
    if (status === 500) logger.error('Failed to read AWS alerts for the signed-in user');
    res.status(status).json({
      error: status === 401 ? 'Sign in to read AWS alerts.' : status === 403 ? 'You do not have access to AWS alerts.' : 'AWS alerts could not be read.',
    });
  });
  return router;
}

/**
 * Service context for the alarm ARNs on this page, or `undefined` when no bindings are
 * configured (the response is then unchanged from installs without this feature). Any
 * catalog or token failure becomes an explicit `catalog-unavailable` state, never an error.
 */
async function readServices(
  options: AwsAlertsRouterOptions,
  credentials: Parameters<AwsAlertsRouterOptions['auth']['getPluginRequestToken']>[0]['onBehalfOf'],
  alarmArns: string[],
  logger: Pick<LoggerService, 'warn'>,
): Promise<Map<string, AlertServiceContext> | undefined> {
  const { serviceBindings, catalog } = options;
  if (!serviceBindings?.length || !catalog) return undefined;
  let token: string;
  try {
    ({ token } = await options.auth.getPluginRequestToken({ onBehalfOf: credentials, targetPluginId: 'catalog' }));
  } catch {
    logger.warn('Could not obtain a catalog token for AWS alert service context');
    token = '';
  }
  // Without a token the catalog cannot be asked; every bound alert then reports that plainly.
  const failing = { getEntitiesByRefs: async () => { throw new Error('no catalog token'); } };
  const contexts = await resolveAlertServices({ alarmArns, bindings: serviceBindings, catalog: token ? catalog : failing, token, timeoutMs: options.catalogTimeoutMs ?? 5_000 });
  if ([...contexts.values()].some(context => context.status === 'catalog-unavailable')) logger.warn('AWS alert service context could not be read from the catalog');
  return contexts;
}

/** A detail lookup failure must not hide alerts: the native notifications still load. */
async function readDetails(
  store: AwsAlertDetailsStore,
  scopes: string[],
  logger: Pick<LoggerService, 'warn'>,
): Promise<Map<string, StoredAwsAlertDetails>> {
  try {
    return await store.read(scopes);
  } catch {
    logger.warn('AWS alert details could not be read; alerts are returned without their stored context');
    return new Map();
  }
}
