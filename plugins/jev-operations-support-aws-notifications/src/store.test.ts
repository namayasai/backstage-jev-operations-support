import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseService } from '@backstage/backend-plugin-api';
import knex, { type Knex } from 'knex';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  awsAlertDetailsMigrationsDirectory,
  awsAlertDetailsRetentionDays,
  awsAlertDetailsTable,
  createAwsAlertDetailsStore,
} from './store';
import type { JevAwsAlertDetails } from './index';

const clients: Knex[] = [];

afterEach(async () => {
  while (clients.length) await clients.pop()?.destroy();
});

/** A real SQLite database, the same engine a default Backstage development host uses. */
function database(): DatabaseService & { client: Knex } {
  const client = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  clients.push(client);
  return { client, getClient: async () => client };
}

function details(overrides: Partial<JevAwsAlertDetails> = {}): JevAwsAlertDetails {
  return {
    source: 'aws-cloudwatch',
    context: 'CloudWatch alarm: Checkout5xx\nState: ALARM',
    awsState: 'ALARM',
    alarmArn: 'arn:aws:cloudwatch:ap-northeast-1:123456789012:alarm:Checkout5xx',
    region: 'ap-northeast-1',
    evaluationStatus: 'not-evaluated',
    errorCode: 'evaluation-pending',
    snsMessageId: 'message-001',
    topicArn: 'arn:aws:sns:ap-northeast-1:123456789012:alerts',
    ...overrides,
  };
}

describe('AWS alert detail store', () => {
  it('creates its single table from the packaged migration in the existing plugin database', async () => {
    const db = database();
    await createAwsAlertDetailsStore(db);

    expect(await db.client.schema.hasTable(awsAlertDetailsTable)).toBe(true);
    const columns = await db.client(awsAlertDetailsTable).columnInfo();
    expect(Object.keys(columns).sort()).toEqual(['details', 'scope', 'updated_at']);
    const indexes = await db.client.raw(`PRAGMA index_list('${awsAlertDetailsTable}')`) as Array<{ name: string }>;
    expect(indexes.some(index => index.name === 'jev_aws_alert_details_updated_at_idx')).toBe(true);
    // The module keeps its own migration ledger so the parent plugin can add its own later.
    expect(await db.client.schema.hasTable('jev_aws_alert_details_migrations')).toBe(true);
    // Running the migration again is a no-op rather than an error.
    await expect(createAwsAlertDetailsStore(db)).resolves.toBeDefined();
  });

  it('does not migrate when the host disabled migrations', async () => {
    const db = database();
    await createAwsAlertDetailsStore({ getClient: db.getClient, migrations: { skip: true } });
    expect(await db.client.schema.hasTable(awsAlertDetailsTable)).toBe(false);
  });

  it('round-trips details by notification scope and replaces them on the second write', async () => {
    const db = database();
    const store = await createAwsAlertDetailsStore(db);

    await store.save('aws-cloudwatch:message-001', details());
    await store.save('aws-cloudwatch:message-002', details({ snsMessageId: 'message-002', awsState: 'OK' }));
    await store.save('aws-cloudwatch:message-001', details({ evaluationStatus: 'evaluated', errorCode: undefined, result: { workflow: 'incident' } }));

    const stored = await store.read(['aws-cloudwatch:message-001', 'aws-cloudwatch:message-002', 'aws-cloudwatch:unknown']);
    expect([...stored.keys()].sort()).toEqual(['aws-cloudwatch:message-001', 'aws-cloudwatch:message-002']);
    expect(stored.get('aws-cloudwatch:message-001')?.details).toMatchObject({ evaluationStatus: 'evaluated', result: { workflow: 'incident' } });
    expect(stored.get('aws-cloudwatch:message-001')?.details.errorCode).toBeUndefined();
    expect(Date.parse(stored.get('aws-cloudwatch:message-001')!.updatedAt)).not.toBeNaN();
    // One row per scope: the update replaced the pending detail instead of adding a row.
    expect(await db.client(awsAlertDetailsTable).count({ rows: '*' })).toEqual([{ rows: 2 }]);
  });

  it('keeps other alerts readable when one stored row is corrupt', async () => {
    const db = database();
    const logger = { warn: vi.fn() };
    const store = await createAwsAlertDetailsStore(db, { logger });
    await store.save('aws-cloudwatch:good', details());
    await db.client(awsAlertDetailsTable).insert({ scope: 'aws-cloudwatch:corrupt', details: '{not json', updated_at: new Date().toISOString() });

    const stored = await store.read(['aws-cloudwatch:good', 'aws-cloudwatch:corrupt']);

    expect([...stored.keys()]).toEqual(['aws-cloudwatch:good']);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('removes only expired detail rows during an ordinary write', async () => {
    const db = database();
    const day = 24 * 60 * 60 * 1000;
    let now = new Date('2026-08-01T00:00:00.000Z');
    const store = await createAwsAlertDetailsStore(db, { now: () => now });

    await store.save('aws-cloudwatch:old', details());
    now = new Date(now.getTime() + (awsAlertDetailsRetentionDays - 1) * day);
    await store.save('aws-cloudwatch:recent', details());
    now = new Date(now.getTime() + 2 * day);
    await store.save('aws-cloudwatch:new', details());

    const remaining = await db.client(awsAlertDetailsTable).pluck('scope');
    expect(remaining.sort()).toEqual(['aws-cloudwatch:new', 'aws-cloudwatch:recent']);
  });
});

describe('AWS alert detail migration packaging', () => {
  it('resolves the migration directory through ordinary package resolution', () => {
    const directory = awsAlertDetailsMigrationsDirectory();
    const files = readdirSync(directory);
    expect(files.filter(file => file.endsWith('.js'))).toHaveLength(1);
    // The resolution above needs the package.json subpath export to stay in place.
    const manifest = JSON.parse(readFileSync(join(dirname(directory), 'package.json'), 'utf8'));
    expect(manifest.files).toContain('migrations');
    expect(manifest.exports['./package.json']).toBe('./package.json');
    expect(manifest.version).toBe('0.4.0');
  });

  it('is reversible', async () => {
    const db = database();
    await createAwsAlertDetailsStore(db);
    await db.client.migrate.rollback({ directory: awsAlertDetailsMigrationsDirectory(), tableName: 'jev_aws_alert_details_migrations' });
    expect(await db.client.schema.hasTable(awsAlertDetailsTable)).toBe(false);
  });
});
