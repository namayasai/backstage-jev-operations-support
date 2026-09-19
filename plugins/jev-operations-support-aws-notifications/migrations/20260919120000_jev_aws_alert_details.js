/*
 * Structured AWS alert context and Jev evaluation state for one notification scope.
 *
 * The alert itself stays a standard Backstage notification: recipients, read/saved
 * state, and inbox identity are owned by the Notifications backend. That backend
 * does not persist `payload.metadata`, so the machine-readable part of an alert is
 * kept here, in the plugin's own database, keyed by the notification scope.
 *
 * `updated_at` is an ISO-8601 UTC string rather than a dialect-specific timestamp so
 * that the same lexicographic comparison drives retention on SQLite and PostgreSQL.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('jev_aws_alert_details', table => {
    // 255 keeps the primary key inside the MySQL index key length; a scope is
    // `<eventTopic>:<SNS MessageId>`.
    table.string('scope', 255).primary().notNullable();
    table.text('details').notNullable();
    table.string('updated_at', 40).notNullable();
    table.index(['updated_at'], 'jev_aws_alert_details_updated_at_idx');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('jev_aws_alert_details');
};
