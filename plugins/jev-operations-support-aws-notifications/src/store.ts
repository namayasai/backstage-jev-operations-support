import { resolvePackagePath, type DatabaseService, type LoggerService } from '@backstage/backend-plugin-api';
import type { Knex } from 'knex';
import type { JevAwsAlertDetails } from './index';

/** One plugin-owned table inside the existing Backstage plugin database. */
export const awsAlertDetailsTable = 'jev_aws_alert_details';
/** A dedicated ledger keeps this module's migration independent of the parent plugin. */
export const awsAlertDetailsMigrationsTable = 'jev_aws_alert_details_migrations';
/** Detail rows older than this are removed during ordinary writes; the alert itself is never deleted. */
export const awsAlertDetailsRetentionDays = 30;
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
): Promise<AwsAlertDetailsStore> {
  const client = await database.getClient();
  if (!database.migrations?.skip) {
    await client.migrate.latest({
      directory: awsAlertDetailsMigrationsDirectory(),
      tableName: awsAlertDetailsMigrationsTable,
    });
  }
  return createKnexAwsAlertDetailsStore(client, options);
}

export function createKnexAwsAlertDetailsStore(client: Knex, options: AwsAlertDetailsStoreOptions = {}): AwsAlertDetailsStore {
  const now = options.now ?? (() => new Date());
  return {
    async save(scope, details) {
      const updatedAt = now().toISOString();
      await client(awsAlertDetailsTable)
        .insert({ scope, details: JSON.stringify(details), updated_at: updatedAt })
        .onConflict('scope')
        .merge(['details', 'updated_at']);
      // Retention runs on the write path so the module needs no background worker.
      // A failed cleanup must not turn a stored detail into a reported failure.
      try {
        const cutoff = new Date(now().getTime() - awsAlertDetailsRetentionDays * 24 * 60 * 60 * 1000).toISOString();
        await client(awsAlertDetailsTable).where('updated_at', '<', cutoff).delete();
      } catch {
        options.logger?.warn('Failed to apply the AWS alert detail retention policy');
      }
    },
    async read(scopes) {
      const unique = [...new Set(scopes.filter(scope => typeof scope === 'string' && scope))].slice(0, maxScopesPerRead);
      if (!unique.length) return new Map();
      const rows = await client(awsAlertDetailsTable).select('scope', 'details', 'updated_at').whereIn('scope', unique);
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
