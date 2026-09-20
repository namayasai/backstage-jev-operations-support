import { resolvePackagePath, type DatabaseService, type LoggerService } from '@backstage/backend-plugin-api';
import type { Knex } from 'knex';
import type { JevAwsAlertDetails } from './index';

/** One plugin-owned table inside the existing Backstage plugin database. */
export const awsAlertDetailsTable = 'jev_aws_alert_details';
/** A dedicated ledger keeps this module's migration independent of the parent plugin. */
export const awsAlertDetailsMigrationsTable = 'jev_aws_alert_details_migrations';
/** Details expire this many days after their last write; the alert itself is never deleted. */
export const awsAlertDetailsRetentionDays = 30;
const cleanupBatchSize = 500;
/** A page of alerts is bounded, so a lookup never builds an unbounded `IN (...)` list. */
const maxScopesPerRead = 200;

export type StoredAwsAlertDetails = {
  details: JevAwsAlertDetails;
  /** ISO-8601 UTC time of the last detail write for this scope. */
  updatedAt: string;
};

export interface AwsAlertDetailsStore {
  save(scope: string, details: JevAwsAlertDetails): Promise<void>;
  /** Only scopes read from the caller's own authorized notifications are looked up. */
  read(scopes: readonly string[]): Promise<Map<string, StoredAwsAlertDetails>>;
}

export type AwsAlertDetailsStoreOptions = {
  logger?: Pick<LoggerService, 'warn'>;
  now?: () => Date;
};

/** Ordinary Backstage package path resolution; the migration ships in the npm package. */
export function awsAlertDetailsMigrationsDirectory(): string {
  return resolvePackagePath('@namayasai/backstage-plugin-jev-operations-support-aws-notifications', 'migrations');
}

/**
 * Uses the host's existing database service: no second database, engine, or queue.
 * The module runs its single packaged migration unless the host disabled migrations.
 */
export async function createAwsAlertDetailsStore(
  database: DatabaseService,
  options: AwsAlertDetailsStoreOptions = {},
): Promise<AwsAlertDetailsStore & { pruneExpired(): Promise<number> }> {
  const client = await database.getClient();
  if (!database.migrations?.skip) {
    await client.migrate.latest({
      directory: awsAlertDetailsMigrationsDirectory(),
      tableName: awsAlertDetailsMigrationsTable,
    });
  }
  return createKnexAwsAlertDetailsStore(client, options);
}

export function createKnexAwsAlertDetailsStore(client: Knex, options: AwsAlertDetailsStoreOptions = {}): AwsAlertDetailsStore & { pruneExpired(): Promise<number> } {
  const now = options.now ?? (() => new Date());
  const retentionCutoff = () => new Date(now().getTime() - awsAlertDetailsRetentionDays * 24 * 60 * 60 * 1000).toISOString();
  return {
    async save(scope, details) {
      const updatedAt = now().toISOString();
      await client(awsAlertDetailsTable)
        .insert({ scope, details: JSON.stringify(details), updated_at: updatedAt })
        .onConflict('scope')
        .merge(['details', 'updated_at']);
    },
    async pruneExpired() {
      const cutoff = retentionCutoff();
      const scopes = await client(awsAlertDetailsTable).where('updated_at', '<', cutoff)
        .orderBy('updated_at').orderBy('scope').limit(cleanupBatchSize).pluck('scope');
      if (!scopes.length) return 0;
      // Recheck expiry: a selected row may have been refreshed since the query.
      return client(awsAlertDetailsTable).whereIn('scope', scopes).where('updated_at', '<', cutoff).delete();
    },
    async read(scopes) {
      const unique = [...new Set(scopes.filter(scope => typeof scope === 'string' && scope))].slice(0, maxScopesPerRead);
      if (!unique.length) return new Map();
      const rows = await client(awsAlertDetailsTable).select('scope', 'details', 'updated_at')
        .whereIn('scope', unique).where('updated_at', '>=', retentionCutoff());
      const stored = new Map<string, StoredAwsAlertDetails>();
      for (const row of rows as Array<{ scope: string; details: string; updated_at: string }>) {
        try {
          // An unreadable row leaves the alert without details rather than hiding it.
          stored.set(row.scope, { details: JSON.parse(row.details) as JevAwsAlertDetails, updatedAt: String(row.updated_at) });
        } catch {
          options.logger?.warn('Skipped an unreadable AWS alert detail row');
        }
      }
      return stored;
    },
  };
}
