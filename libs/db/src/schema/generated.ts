import { customType, pgTable, pgSchema, pgPolicy, text, jsonb, bigint, index, bigserial, timestamp, boolean, integer, uniqueIndex, check, uuid, smallint, unique, doublePrecision, numeric, foreignKey, vector, real, date, primaryKey } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

// Custom column types for PG types drizzle-kit can't introspect
// (pull-schema.mjs Fix 4, audit P-075):
const byteaCustom = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });
const tsvectorCustom = customType<{ data: string; driverData: string }>({ dataType: () => 'tsvector' });

export const harnessShared = pgSchema("harness_shared");
export const papercuspShared = pgSchema("papercusp_shared");

export const workItemSeqInHarnessShared = harnessShared.sequence("work_item_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const planRunsIdSeqInHarnessShared = harnessShared.sequence("plan_runs_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })

export const operatorPausedInHarnessShared = harnessShared.table("operator_paused", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_paused_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_paused_pkey"}),

]);

export const operatorFlagOverridesInHarnessShared = harnessShared.table("operator_flag_overrides", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspaceId], name: "operator_flag_overrides_pkey"}),
]);

export const uiIntentsInHarnessShared = harnessShared.table("ui_intents", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	clientId: text("client_id").notNull(),
	intent: text().notNull(),
	args: jsonb().default({}).notNull(),
	status: text().default('pending').notNull(),
	result: jsonb(),
	errorMessage: text("error_message"),
	requestedBy: text("requested_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: 'string' }),
	workspaceId: text("workspace_id").notNull(),
}, (table) => [
	index("ui_intents_completed_idx").using("btree", table.completedAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(completed_at IS NOT NULL)`),
	index("ui_intents_pending_idx").using("btree", table.clientId.asc().nullsLast().op("int8_ops"), table.id.asc().nullsLast().op("int8_ops")).where(sql`(status = 'pending'::text)`),
	index("ui_intents_workspace_id_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
]);

export const workspaceBackupSettingsInHarnessShared = harnessShared.table("workspace_backup_settings", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	enabled: boolean().default(true).notNull(),
	cadenceMode: text("cadence_mode").default('both').notNull(),
	cadenceMinutes: integer("cadence_minutes").default(5).notNull(),
	retentionPreset: text("retention_preset").default('default').notNull(),
	retentionCustomJson: jsonb("retention_custom_json"),
	eventTriggersJson: jsonb("event_triggers_json").default(["pre_destructive","post_run","plugin_install","secret_change"]).notNull(),
	excludedPathsJson: jsonb("excluded_paths_json").default([]).notNull(),
	destinationType: text("destination_type").default('local').notNull(),
	destinationConfigEncrypted: text("destination_config_encrypted"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	pgPolicy("workspace_backup_settings_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "workspace_backup_settings_pkey"}),

]);

export const coordLinksInHarnessShared = harnessShared.table("coord_links", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity({ name: "harness_shared.coord_links_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id").default('default').notNull(),
	srcKind: text("src_kind").notNull(),
	srcRef: text("src_ref").notNull(),
	dstKind: text("dst_kind").notNull(),
	dstRef: text("dst_ref").notNull(),
	rel: text().notNull(),
	createdBy: text("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("coord_links_dst_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.dstKind.asc().nullsLast().op("text_ops"), table.dstRef.asc().nullsLast().op("text_ops")),
	uniqueIndex("coord_links_edge_uq").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.srcKind.asc().nullsLast().op("text_ops"), table.srcRef.asc().nullsLast().op("text_ops"), table.dstKind.asc().nullsLast().op("text_ops"), table.dstRef.asc().nullsLast().op("text_ops"), table.rel.asc().nullsLast().op("text_ops")),
	index("coord_links_src_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.srcKind.asc().nullsLast().op("text_ops"), table.srcRef.asc().nullsLast().op("text_ops")),
	check("coord_links_endpoints_nonempty", sql`(src_kind <> ''::text) AND (src_ref <> ''::text) AND (dst_kind <> ''::text) AND (dst_ref <> ''::text)`),
	check("coord_links_rel_nonempty", sql`rel <> ''::text`),
	check("coord_links_workspace_nonempty", sql`workspace_id <> ''::text`),
]);

export const coordEntitySubscriptionsInHarnessShared = harnessShared.table("coord_entity_subscriptions", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity({ name: "harness_shared.coord_entity_subscriptions_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id").default('default').notNull(),
	subscriberId: text("subscriber_id").notNull(),
	targetKind: text("target_kind").notNull(),
	targetRef: text("target_ref").notNull(),
	deliveryMode: text("delivery_mode").default('full').notNull(),
	expiresTs: timestamp("expires_ts", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	cancelledAt: timestamp("cancelled_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	uniqueIndex("coord_entity_subscriptions_active_uq").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.subscriberId.asc().nullsLast().op("text_ops"), table.targetKind.asc().nullsLast().op("text_ops"), table.targetRef.asc().nullsLast().op("text_ops")).where(sql`(cancelled_at IS NULL)`),
	index("coord_entity_subscriptions_target_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.targetKind.asc().nullsLast().op("text_ops"), table.targetRef.asc().nullsLast().op("text_ops")).where(sql`(cancelled_at IS NULL)`),
	check("coord_entity_subscriptions_mode_check", sql`delivery_mode = ANY (ARRAY['full'::text, 'digest'::text, 'mention'::text])`),
	check("coord_entity_subscriptions_ref_nonempty", sql`target_ref <> ''::text`),
	check("coord_entity_subscriptions_workspace_nonempty", sql`workspace_id <> ''::text`),
	check("coord_entity_subscriptions_kind_check", sql`target_kind = ANY (ARRAY['topic'::text, 'object'::text, 'fleet'::text])`),
]);

export const agentActivityInHarnessShared = harnessShared.table("agent_activity", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	workspaceId: text("workspace_id").default('*').notNull(),
	ownerId: text("owner_id").notNull(),
	agent: text(),
	sessionId: text("session_id"),
	harnessSlug: text("harness_slug"),
	kind: text().notNull(),
	toolName: text("tool_name"),
	phase: text(),
	toolUseId: text("tool_use_id"),
	summary: text(),
	status: text(),
	detail: jsonb(),
	cwd: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("agent_activity_created_at_idx").using("btree", table.createdAt.asc().nullsLast().op("timestamptz_ops")),
	index("agent_activity_harness_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.id.asc().nullsLast().op("text_ops")).where(sql`(harness_slug IS NOT NULL)`),
	index("agent_activity_owner_id_idx").using("btree", table.ownerId.asc().nullsLast().op("text_ops"), table.id.asc().nullsLast().op("int8_ops")),
]);

export const identityFilesInHarnessShared = harnessShared.table("identity_files", {
	role: text().primaryKey().notNull(),
	content: text().default('').notNull(),
	bytes: integer().default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	mtimeMs: bigint("mtime_ms", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
}, (table) => [
	index("identity_files_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	pgPolicy("identity_files_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const mobilePairTokensInHarnessShared = harnessShared.table("mobile_pair_tokens", {
	pairToken: text("pair_token").primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	userEmail: text("user_email"),
	desktopHost: text("desktop_host").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	expiresAtMs: bigint("expires_at_ms", { mode: "number" }).notNull(),
	consumed: boolean().default(false).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdAtMs: bigint("created_at_ms", { mode: "number" }).default(0).notNull(),
}, (table) => [
	index("mobile_pair_tokens_exp_idx").using("btree", table.expiresAtMs.asc().nullsLast().op("int8_ops")),
	pgPolicy("mobile_pair_tokens_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.pairToken], name: "mobile_pair_tokens_pkey"}),

]);

export const operatorRateLimitInHarnessShared = harnessShared.table("operator_rate_limit", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_rate_limit_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_rate_limit_pkey"}),

]);

export const authRateLimitInHarnessShared = harnessShared.table("auth_rate_limit", {
	key: text().primaryKey().notNull(),
	payload: jsonb().default({}).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	index("auth_rate_limit_updated_at_idx").using("btree", table.updatedAt.asc().nullsLast().op("int8_ops")),
]);

export const authAuditLogInHarnessShared = harnessShared.table("auth_audit_log", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	ts: timestamp({ withTimezone: true }).defaultNow().notNull(),
	kind: text().notNull(),
	username: text(),
	ip: text(),
	userAgent: text("user_agent"),
	ok: boolean().notNull(),
	errorCode: text("error_code"),
	sessionHmac: text("session_hmac"),
	metadata: jsonb(),
}, (table) => [
	index("auth_audit_log_ts_idx").using("btree", table.ts.desc().nullsFirst().op("timestamptz_ops")),
	index("auth_audit_log_username_idx").using("btree", table.username.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("text_ops")),
	primaryKey({ columns: [table.id], name: "auth_audit_log_pkey"}),

]);

export const telemetryReportsArchiveInHarnessShared = harnessShared.table("telemetry_reports_archive", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	receivedAt: timestamp("received_at", { withTimezone: true, mode: 'string' }).notNull(),
	kind: text().notNull(),
	appVersion: text("app_version"),
	os: text(),
	payload: jsonb(),
	forwardedAt: timestamp("forwarded_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("telemetry_reports_archive_forwarded_at_idx").using("btree", table.forwardedAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(forwarded_at IS NULL)`),
	index("telemetry_reports_archive_received_at_idx").using("btree", table.receivedAt.desc().nullsFirst().op("timestamptz_ops")),
	index("telemetry_reports_archive_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.receivedAt.desc().nullsFirst().op("text_ops")),
	pgPolicy("telemetry_reports_archive_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const scoutRoutedIdeasInHarnessShared = harnessShared.table("scout_routed_ideas", {
	ideaId: text("idea_id").primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	cycleId: text("cycle_id"),
	lens: text().notNull(),
	rail: text().notNull(),
	routedRef: text("routed_ref").notNull(),
	title: text(),
	addressesPatternRefs: jsonb("addresses_pattern_refs"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	routedAt: bigint("routed_at", { mode: "number" }).notNull(),
	outcome: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	outcomeCheckedAt: bigint("outcome_checked_at", { mode: "number" }),
	humanGrade: smallint("human_grade"),
	humanFeedback: text("human_feedback"),
	gradedBy: text("graded_by"),
	gradedAt: timestamp("graded_at", { withTimezone: true, mode: 'string' }),
	sourceHive: text("source_hive"),
	targetHive: text("target_hive"),
	origin: text().default('scout').notNull(),
}, (table) => [
	index("scout_routed_ideas_routed_ref_idx").using("btree", table.routedRef.asc().nullsLast().op("text_ops")),
	index("scout_routed_ideas_ws_harness_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops")),
	index("scout_routed_ideas_ws_harness_lens_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.lens.asc().nullsLast().op("text_ops")),
	index("scout_routed_ideas_ws_origin_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.origin.asc().nullsLast().op("text_ops")),
	index("scout_routed_ideas_ws_source_hive_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.sourceHive.asc().nullsLast().op("text_ops")),
	pgPolicy("scout_routed_ideas_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("scout_routed_ideas_human_grade_check", sql`(human_grade >= 1) AND (human_grade <= 5)`),
	primaryKey({ columns: [table.ideaId], name: "scout_routed_ideas_pkey"}),

]);

export const schemaMigrationsInHarnessShared = harnessShared.table("schema_migrations", {
	filename: text().primaryKey().notNull(),
	appliedAt: timestamp("applied_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	sha256: text().notNull(),
});

export const routinesInHarnessShared = harnessShared.table("routines", {
	id: text().primaryKey().notNull(),
	installSlug: text("install_slug").notNull(),
	name: text().notNull(),
	triggerKind: text("trigger_kind").notNull(),
	triggerConfig: jsonb("trigger_config").notNull(),
	targetRole: text("target_role").notNull(),
	payloadTemplate: jsonb("payload_template"),
	concurrency: text().default('queue').notNull(),
	catchup: text().default('skip-old').notNull(),
	active: boolean().default(true).notNull(),
	lastFiredAt: timestamp("last_fired_at", { withTimezone: true, mode: 'string' }),
	nextFireAt: timestamp("next_fire_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	metadata: jsonb(),
	workspaceId: text("workspace_id").notNull(),
	rescheduleIntervalSec: integer("reschedule_interval_sec"),
	targetOwnerId: text("target_owner_id"),
	tier: text().default('durable').notNull(),
}, (table) => [
	index("routines_active_due_idx").using("btree", table.active.asc().nullsLast().op("bool_ops"), table.nextFireAt.asc().nullsLast().op("bool_ops")).where(sql`(active = true)`),
	index("routines_install_idx").using("btree", table.installSlug.asc().nullsLast().op("text_ops")),
	index("routines_loop_interval_idx").using("btree", table.rescheduleIntervalSec.asc().nullsLast().op("int4_ops")).where(sql`(reschedule_interval_sec IS NOT NULL)`),
	index("routines_tier_active_idx").using("btree", table.tier.asc().nullsLast().op("text_ops"), table.active.asc().nullsLast().op("bool_ops")).where(sql`(active = true)`),
	index("routines_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	uniqueIndex("routines_workspace_install_slug_name_key").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.installSlug.asc().nullsLast().op("text_ops"), table.name.asc().nullsLast().op("text_ops")),
	unique("routines_install_slug_name_key").on(table.installSlug, table.name),
	pgPolicy("routines_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("routines_tier_check", sql`tier = ANY (ARRAY['durable'::text, 'ephemeral'::text])`),
	check("routines_reschedule_interval_positive", sql`(reschedule_interval_sec IS NULL) OR (reschedule_interval_sec > 0)`),
	check("routines_workspace_nonempty", sql`workspace_id <> ''::text`),
]);

export const hiveDirectoryCacheInHarnessShared = harnessShared.table("hive_directory_cache", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("hive_directory_cache_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "hive_directory_cache_pkey"}),

]);

export const operatorTxnTimeoutsConfigInHarnessShared = harnessShared.table("operator_txn_timeouts_config", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().default({}).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_txn_timeouts_config_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_txn_timeouts_config_pkey"}),

]);

export const pendingWakesInHarnessShared = harnessShared.table("pending_wakes", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "harness_shared.pending_wakes_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	ownerId: text("owner_id").notNull(),
	summary: text(),
	payload: jsonb(),
	source: text(),
	workspaceId: text("workspace_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	count: integer().default(1).notNull(),
	lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("pending_wakes_dedupe_idx").using("btree", sql`owner_id`, sql`COALESCE(source, ''::text)`, sql`COALESCE(summary, ''::text)`, sql`COALESCE(workspace_id, ''::text)`),
	index("pending_wakes_owner_idx").using("btree", table.ownerId.asc().nullsLast().op("text_ops"), table.id.asc().nullsLast().op("text_ops")),
	index("pending_wakes_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("int8_ops"), table.ownerId.asc().nullsLast().op("int8_ops"), table.id.asc().nullsLast().op("int8_ops")),
]);

export const migrationReservationsInHarnessShared = harnessShared.table("migration_reservations", {
	num: integer().primaryKey().notNull(),
	filename: text(),
	reservedBy: text("reserved_by"),
	intent: text(),
	reservedAt: timestamp("reserved_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const operatorAccountPoolInHarnessShared = harnessShared.table("operator_account_pool", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().default({}).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_account_pool_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_account_pool_pkey"}),

]);

export const behaviorChangeLedgerInHarnessShared = harnessShared.table("behavior_change_ledger", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	recordedAt: timestamp("recorded_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	source: text().notNull(),
	mutationClass: text("mutation_class").notNull(),
	action: text().notNull(),
	targetKind: text("target_kind").notNull(),
	target: text().notNull(),
	harnessSlug: text("harness_slug"),
	role: text(),
	diffRef: text("diff_ref"),
	actor: text(),
	summary: text(),
	payload: jsonb(),
}, (table) => [
	uniqueIndex("behavior_change_ledger_dedupe_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.source.asc().nullsLast().op("text_ops"), table.diffRef.asc().nullsLast().op("text_ops"), table.target.asc().nullsLast().op("text_ops")),
	index("behavior_change_ledger_ws_class_idx").using("btree", table.workspaceId.asc().nullsLast().op("timestamptz_ops"), table.mutationClass.asc().nullsLast().op("text_ops"), table.recordedAt.desc().nullsFirst().op("timestamptz_ops")),
	index("behavior_change_ledger_ws_recorded_idx").using("btree", table.workspaceId.asc().nullsLast().op("timestamptz_ops"), table.recordedAt.desc().nullsFirst().op("timestamptz_ops")),
	pgPolicy("behavior_change_ledger_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.id], name: "behavior_change_ledger_pkey"}),

]);

export const coordThreadPostsInHarnessShared = harnessShared.table("coord_thread_posts", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity({ name: "harness_shared.coord_thread_posts_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id").default('default').notNull(),
	threadId: text("thread_id").notNull(),
	authorId: text("author_id"),
	body: text().default('').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	harnessSlug: text("harness_slug"),
	origin: text().default('local').notNull(),
	authorPubkey: text("author_pubkey"),
	postMsgId: text("post_msg_id"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	fedHlc: text("fed_hlc"),
}, (table) => [
	uniqueIndex("coord_thread_posts_fed_uq").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.postMsgId.asc().nullsLast().op("text_ops")).where(sql`((harness_slug IS NOT NULL) AND (post_msg_id IS NOT NULL))`),
	index("coord_thread_posts_thread_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.threadId.asc().nullsLast().op("int8_ops"), table.id.asc().nullsLast().op("int8_ops")),
	check("coord_thread_posts_workspace_nonempty", sql`workspace_id <> ''::text`),
]);

export const operatorCurationStateInHarnessShared = harnessShared.table("operator_curation_state", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	lastRunAt: timestamp("last_run_at", { withTimezone: true, mode: 'string' }),
	lastDigestAt: timestamp("last_digest_at", { withTimezone: true, mode: 'string' }),
	currentIntervalSeconds: integer("current_interval_seconds").default(120).notNull(),
	consecutiveQuiet: integer("consecutive_quiet").default(0).notNull(),
	lastSurfacedCount: integer("last_surfaced_count").default(0).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspaceId], name: "operator_curation_state_pkey"}),
]);

export const gymChampionOutcomesInHarnessShared = harnessShared.table("gym_champion_outcomes", {
	proposalId: text("proposal_id").primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	role: text().notNull(),
	variantId: text("variant_id"),
	cycle: integer().default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	acceptedAt: bigint("accepted_at", { mode: "number" }).notNull(),
	baselineDevAnchorDelta: doublePrecision("baseline_dev_anchor_delta"),
	baselineCostDelta: doublePrecision("baseline_cost_delta"),
	baselineProbeStatus: text("baseline_probe_status"),
	baselineRuns: integer("baseline_runs").default(0).notNull(),
	baselineSucceeded: integer("baseline_succeeded").default(0).notNull(),
	baselineFailed: integer("baseline_failed").default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	postWindowEndsAt: bigint("post_window_ends_at", { mode: "number" }).notNull(),
	postRuns: integer("post_runs"),
	postSucceeded: integer("post_succeeded"),
	postFailed: integer("post_failed"),
	successRateDelta: doublePrecision("success_rate_delta"),
	verdict: text().default('pending').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	evaluatedAt: bigint("evaluated_at", { mode: "number" }),
}, (table) => [
	index("gym_champion_outcomes_pending_due_idx").using("btree", table.postWindowEndsAt.asc().nullsLast().op("int8_ops")).where(sql`(verdict = 'pending'::text)`),
	index("gym_champion_outcomes_ws_harness_accepted_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("int8_ops"), table.acceptedAt.desc().nullsFirst().op("int8_ops")),
	pgPolicy("gym_champion_outcomes_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.proposalId], name: "gym_champion_outcomes_pkey"}),

]);

export const eventReactionsInHarnessShared = harnessShared.table("event_reactions", {
	dedupId: text("dedup_id").primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	ruleId: text("rule_id").notNull(),
	fire: text().notNull(),
	triggerTool: text("trigger_tool"),
	causeRootRunId: text("cause_root_run_id"),
	depth: integer().default(0).notNull(),
	status: text().default('fired').notNull(),
	errorMessage: text("error_message"),
	firedAt: timestamp("fired_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("event_reactions_rule_idx").using("btree", table.ruleId.asc().nullsLast().op("text_ops"), table.firedAt.desc().nullsFirst().op("timestamptz_ops")),
	index("event_reactions_ws_fired_idx").using("btree", table.workspaceId.asc().nullsLast().op("timestamptz_ops"), table.firedAt.desc().nullsFirst().op("text_ops")),
	primaryKey({ columns: [table.dedupId], name: "event_reactions_pkey"}),

]);

export const hiveEvalScenariosInHarnessShared = harnessShared.table("hive_eval_scenarios", {
	scenarioId: text("scenario_id").primaryKey().notNull(),
	title: text().notNull(),
	shape: text().notNull(),
	idealWallClockUnits: numeric("ideal_wall_clock_units").notNull(),
	idealBeeCount: integer("ideal_bee_count").notNull(),
	totalUnits: numeric("total_units").notNull(),
	criticalPath: jsonb("critical_path").notNull(),
	workItemCount: integer("work_item_count").notNull(),
	plantedBugLocation: text("planted_bug_location"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.scenarioId], name: "hive_eval_scenarios_pkey"}),
]);

export const steeringChurnEventsInHarnessShared = harnessShared.table("steering_churn_events", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "harness_shared.steering_churn_events_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	featureId: text("feature_id").notNull(),
	writer: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	featureOrder: bigint("feature_order", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).notNull(),
}, (table) => [
	index("steering_churn_events_item_idx").using("btree", table.workspaceId.asc().nullsLast().op("int8_ops"), table.harnessSlug.asc().nullsLast().op("int8_ops"), table.featureId.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("int8_ops")),
	index("steering_churn_events_ws_ts_idx").using("btree", table.workspaceId.asc().nullsLast().op("int8_ops"), table.ts.desc().nullsFirst().op("int8_ops")),
	pgPolicy("steering_churn_events_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const toolAuthzLogInHarnessShared = harnessShared.table("tool_authz_log", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	ts: timestamp({ withTimezone: true }).defaultNow().notNull(),
	workspaceId: text("workspace_id"),
	principalSlug: text("principal_slug"),
	tool: text().notNull(),
	action: text().notNull(),
	resourceType: text("resource_type"),
	resourceId: text("resource_id"),
	decision: text().notNull(),
	gate: text().notNull(),
	reason: text(),
}, (table) => [
	index("tool_authz_log_decision_idx").using("btree", table.decision.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("text_ops")),
	index("tool_authz_log_principal_idx").using("btree", table.principalSlug.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("text_ops")),
	index("tool_authz_log_ts_idx").using("btree", table.ts.desc().nullsFirst().op("timestamptz_ops")),
	pgPolicy("tool_authz_log_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.id], name: "tool_authz_log_pkey"}),

]);

export const learningSpendEventsInHarnessShared = harnessShared.table("learning_spend_events", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	loopId: text("loop_id").notNull(),
	costUsd: numeric("cost_usd").notNull(),
	signalOrigin: text("signal_origin").default('organic').notNull(),
	runRef: text("run_ref"),
	note: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("learning_spend_events_ws_created_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("text_ops")),
	index("learning_spend_events_ws_loop_created_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.loopId.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("text_ops")),
	pgPolicy("learning_spend_events_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("learning_spend_events_signal_origin_check", sql`signal_origin = ANY (ARRAY['organic'::text, 'drill'::text, 'replay'::text, 'shadow'::text])`),
	primaryKey({ columns: [table.id], name: "learning_spend_events_pkey"}),

]);

export const hiveEvalInstancesInHarnessShared = harnessShared.table("hive_eval_instances", {
	instanceId: text("instance_id").primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	codeSha: text("code_sha").notNull(),
	genomeId: text("genome_id"),
	batterySliceId: text("battery_slice_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	unique("hive_eval_instances_workspace_id_code_sha_genome_id_key").on(table.workspaceId, table.codeSha, table.genomeId),
	primaryKey({ columns: [table.instanceId], name: "hive_eval_instances_pkey"}),

]);

export const hiveEvalRunsInHarnessShared = harnessShared.table("hive_eval_runs", {
	runId: text("run_id").primaryKey().notNull(),
	instanceId: text("instance_id").notNull(),
	scenarioId: text("scenario_id").notNull(),
	shape: text().notNull(),
	repeat: integer().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	seed: bigint({ mode: "number" }).notNull(),
	budgetUsdCap: numeric("budget_usd_cap"),
	beeCap: integer("bee_cap"),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	finishedAt: timestamp("finished_at", { withTimezone: true, mode: 'string' }),
	terminalState: text("terminal_state"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	wallClockMs: bigint("wall_clock_ms", { mode: "number" }),
	frontierDrained: boolean("frontier_drained"),
	workItemsTotal: integer("work_items_total"),
	workItemsCompleted: integer("work_items_completed"),
	costUsd: numeric("cost_usd"),
	observations: jsonb(),
	traceRef: text("trace_ref"),
}, (table) => [
	index("hive_eval_runs_instance_idx").using("btree", table.instanceId.asc().nullsLast().op("text_ops")),
	index("hive_eval_runs_scenario_idx").using("btree", table.scenarioId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.instanceId],
			foreignColumns: [hiveEvalInstancesInHarnessShared.instanceId],
			name: "hive_eval_runs_instance_id_fkey"
		}).onDelete("cascade"),
	unique("hive_eval_runs_instance_id_scenario_id_repeat_key").on(table.instanceId, table.scenarioId, table.repeat),
	primaryKey({ columns: [table.runId], name: "hive_eval_runs_pkey"}),

]);

export const uiClientsInHarnessShared = harnessShared.table("ui_clients", {
	clientId: text("client_id").primaryKey().notNull(),
	workspaceId: text("workspace_id"),
	url: text().notNull(),
	title: text(),
	viewport: jsonb(),
	openedAt: timestamp("opened_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ui_clients_last_seen_idx").using("btree", table.lastSeenAt.desc().nullsFirst().op("timestamptz_ops")),
	pgPolicy("ui_clients_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.clientId], name: "ui_clients_pkey"}),

]);

export const gymProposalsInHarnessShared = harnessShared.table("gym_proposals", {
	id: text().primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	cycle: integer().default(0).notNull(),
	variantId: text("variant_id"),
	role: text().notNull(),
	originalMd: text("original_md"),
	proposedMd: text("proposed_md").notNull(),
	rationale: text(),
	devAnchorDelta: doublePrecision("dev_anchor_delta"),
	costDelta: doublePrecision("cost_delta"),
	probeStatus: text("probe_status"),
	status: text().default('pending').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdAt: bigint("created_at", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	decidedAt: bigint("decided_at", { mode: "number" }),
}, (table) => [
	index("gym_proposals_ws_harness_cycle_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("int4_ops"), table.cycle.asc().nullsLast().op("int4_ops")),
	index("gym_proposals_ws_harness_status_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")),
	pgPolicy("gym_proposals_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const oauthNoncesInHarnessShared = harnessShared.table("oauth_nonces", {
	nonce: text().primaryKey().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	expMs: bigint("exp_ms", { mode: "number" }).notNull(),
	consumed: boolean().default(false).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdAt: bigint("created_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	index("oauth_nonces_exp_idx").using("btree", table.expMs.asc().nullsLast().op("int8_ops")),
]);

export const cooldownMarksInHarnessShared = harnessShared.table("cooldown_marks", {
	key: text().primaryKey().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	markedAtMs: bigint("marked_at_ms", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	index("cooldown_marks_marked_at_idx").using("btree", table.markedAtMs.asc().nullsLast().op("int8_ops")),
]);

export const userSessionsInHarnessShared = harnessShared.table("user_sessions", {
	token: text().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	userAgent: text("user_agent"),
	remoteAddr: text("remote_addr"),
}, (table) => [
	index("user_sessions_expires_idx").using("btree", table.expiresAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(expires_at > '2026-01-01 00:00:00-05'::timestamp with time zone)`),
	index("user_sessions_user_idx").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [usersInHarnessShared.id],
			name: "user_sessions_user_id_fkey"
		}).onDelete("cascade"),
]);

export const usersInHarnessShared = harnessShared.table("users", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	username: text().notNull(),
	displayName: text("display_name").notNull(),
	passwordHash: text("password_hash"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lastLoginAt: timestamp("last_login_at", { withTimezone: true, mode: 'string' }),
	isActive: boolean("is_active").default(true).notNull(),
}, (table) => [
	index("users_username_idx").using("btree", table.username.asc().nullsLast().op("text_ops")).where(sql`(is_active = true)`),
	unique("users_username_key").on(table.username),
	primaryKey({ columns: [table.id], name: "users_pkey"}),

]);

export const operatorSettingsInHarnessShared = harnessShared.table("operator_settings", {
	key: text().primaryKey().notNull(),
	value: text().notNull(),
	description: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
	workspaceId: text("workspace_id").notNull(),
}, (table) => [
	index("operator_settings_workspace_id_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
]);

export const operatorBudgetTiersInHarnessShared = harnessShared.table("operator_budget_tiers", {
	ord: integer().primaryKey().notNull(),
	label: text().notNull(),
	capUsd: numeric("cap_usd", { precision: 10, scale:  2 }).notNull(),
	blurb: text().notNull(),
});

export const setupWizardStateInHarnessShared = harnessShared.table("setup_wizard_state", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("setup_wizard_state_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "setup_wizard_state_pkey"}),

]);

export const telemetryReportsInHarnessShared = harnessShared.table("telemetry_reports", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("telemetry_reports_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "telemetry_reports_pkey"}),

]);

export const voiceLeaseInHarnessShared = harnessShared.table("voice_lease", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	ownerId: text("owner_id").notNull(),
	ownerKind: text("owner_kind").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	expiresAtMs: bigint("expires_at_ms", { mode: "number" }).notNull(),
}, (table) => [
	index("voice_lease_expires_idx").using("btree", table.expiresAtMs.asc().nullsLast().op("int8_ops")),
	pgPolicy("voice_lease_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("voice_lease_owner_kind_check", sql`owner_kind = ANY (ARRAY['desktop'::text, 'mobile'::text, 'tui'::text])`),
	primaryKey({ columns: [table.workspaceId], name: "voice_lease_pkey"}),

]);

export const operatorAuthConfigInHarnessShared = harnessShared.table("operator_auth_config", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().default({}).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_auth_config_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_auth_config_pkey"}),

]);

export const operatorContinueChainsInHarnessShared = harnessShared.table("operator_continue_chains", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	conversationId: uuid("conversation_id").notNull(),
	uiClientId: text("ui_client_id").notNull(),
	chainId: uuid("chain_id").notNull(),
	turnIdx: integer("turn_idx").notNull(),
	trigger: text().notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	elapsedSecsInChain: numeric("elapsed_secs_in_chain", { precision: 10, scale:  3 }).notNull(),
	wasCapped: boolean("was_capped").default(false).notNull(),
	capReason: text("cap_reason"),
	workspaceId: text("workspace_id").notNull(),
}, (table) => [
	index("operator_continue_chains_chain_turn_idx").using("btree", table.chainId.asc().nullsLast().op("int4_ops"), table.turnIdx.asc().nullsLast().op("int4_ops")),
	index("operator_continue_chains_conversation_idx").using("btree", table.conversationId.asc().nullsLast().op("timestamptz_ops"), table.startedAt.desc().nullsFirst().op("timestamptz_ops")),
	index("operator_continue_chains_uic_started_idx").using("btree", table.uiClientId.asc().nullsLast().op("timestamptz_ops"), table.startedAt.desc().nullsFirst().op("text_ops")),
	index("operator_continue_chains_workspace_id_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
]);

export const llmTestRunsInHarnessShared = harnessShared.table("llm_test_runs", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	scenarioId: text("scenario_id").notNull(),
	scenarioVersion: integer("scenario_version").notNull(),
	scenarioTarget: text("scenario_target").notNull(),
	scenarioHash: text("scenario_hash").notNull(),
	identityHash: text("identity_hash").notNull(),
	matrixGroupId: uuid("matrix_group_id"),
	matrixIndex: integer("matrix_index"),
	rubricVersion: text("rubric_version").notNull(),
	sutModel: text("sut_model").notNull(),
	judgeModel: text("judge_model").notNull(),
	personaId: text("persona_id").notNull(),
	personaTraitsJson: jsonb("persona_traits_json").notNull(),
	workspaceMode: text("workspace_mode").notNull(),
	transportMode: text("transport_mode").notNull(),
	status: text().notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	finishedAt: timestamp("finished_at", { withTimezone: true, mode: 'string' }),
	costUsd: numeric("cost_usd", { precision: 10, scale:  6 }).default('0').notNull(),
	capBreaches: text("cap_breaches").array().default([""]).notNull(),
	scoresJson: jsonb("scores_json"),
	findingsCount: jsonb("findings_count").default({}).notNull(),
	transcriptRawZstd: byteaCustom("transcript_raw_zstd"),
	transcriptNormJson: jsonb("transcript_norm_json").default({}).notNull(),
	telemetryJson: jsonb("telemetry_json").default({}).notNull(),
	assertsJson: jsonb("asserts_json").default({}).notNull(),
	judgeJson: jsonb("judge_json"),
	metadataJson: jsonb("metadata_json").default({}).notNull(),
}, (table) => [
	index("llm_test_runs_identity_started_idx").using("btree", table.identityHash.asc().nullsLast().op("text_ops"), table.startedAt.desc().nullsFirst().op("timestamptz_ops")),
	index("llm_test_runs_matrix_group_idx").using("btree", table.matrixGroupId.asc().nullsLast().op("uuid_ops")).where(sql`(matrix_group_id IS NOT NULL)`),
	index("llm_test_runs_status_idx").using("btree", table.status.asc().nullsLast().op("text_ops"), table.startedAt.desc().nullsFirst().op("timestamptz_ops")),
	index("llm_test_runs_target_scenario_started_idx").using("btree", table.scenarioTarget.asc().nullsLast().op("text_ops"), table.scenarioId.asc().nullsLast().op("text_ops"), table.startedAt.desc().nullsFirst().op("timestamptz_ops")),
	primaryKey({ columns: [table.id], name: "llm_test_runs_pkey"}),

]);

export const llmTestFindingsInHarnessShared = harnessShared.table("llm_test_findings", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	runId: uuid("run_id").notNull(),
	source: text().notNull(),
	severity: text().notNull(),
	axis: text(),
	assertKind: text("assert_kind"),
	shape: text(),
	evidenceTurnIdx: integer("evidence_turn_idx"),
	claim: text().notNull(),
	suggestion: text(),
	copyPrompt: text("copy_prompt"),
	promotedToAssertId: text("promoted_to_assert_id"),
	promotedFrom: text("promoted_from").array().default([""]).notNull(),
	acknowledged: boolean().default(false).notNull(),
	acknowledgedBy: text("acknowledged_by"),
	acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("llm_test_findings_ack_severity_idx").using("btree", table.acknowledged.asc().nullsLast().op("text_ops"), table.severity.asc().nullsLast().op("bool_ops")),
	index("llm_test_findings_run_severity_idx").using("btree", table.runId.asc().nullsLast().op("uuid_ops"), table.severity.asc().nullsLast().op("uuid_ops")),
	index("llm_test_findings_shape_severity_idx").using("btree", table.shape.asc().nullsLast().op("text_ops"), table.severity.asc().nullsLast().op("text_ops")).where(sql`(shape IS NOT NULL)`),
	foreignKey({
			columns: [table.runId],
			foreignColumns: [llmTestRunsInHarnessShared.id],
			name: "llm_test_findings_run_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.id], name: "llm_test_findings_pkey"}),

]);

export const llmTestFixturesInHarnessShared = harnessShared.table("llm_test_fixtures", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	scenarioId: text("scenario_id").notNull(),
	label: text().notNull(),
	sseTapeJson: jsonb("sse_tape_json").notNull(),
	userInputsJson: jsonb("user_inputs_json").notNull(),
	recordedAt: timestamp("recorded_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	recordedFromRunId: uuid("recorded_from_run_id"),
}, (table) => [
	index("llm_test_fixtures_scenario_idx").using("btree", table.scenarioId.asc().nullsLast().op("text_ops"), table.recordedAt.desc().nullsFirst().op("text_ops")),
	foreignKey({
			columns: [table.recordedFromRunId],
			foreignColumns: [llmTestRunsInHarnessShared.id],
			name: "llm_test_fixtures_recorded_from_run_id_fkey"
		}).onDelete("set null"),
	unique("llm_test_fixtures_scenario_id_label_key").on(table.scenarioId, table.label),
	primaryKey({ columns: [table.id], name: "llm_test_fixtures_pkey"}),

]);

export const operatorUserProfileInHarnessShared = harnessShared.table("operator_user_profile", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_user_profile_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_user_profile_pkey"}),

]);

export const orchestratorSettingsInHarnessShared = harnessShared.table("orchestrator_settings", {
	id: integer().default(1).primaryKey().notNull(),
	tiers: jsonb().default([1,2,4]).notNull(),
	labels: jsonb().default(["trivial","normal","hard"]).notNull(),
	rubric: text().default('').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedTs: bigint("updated_ts", { mode: "number" }).default(0).notNull(),
	workspaceId: text("workspace_id").notNull(),
}, (table) => [
	index("orchestrator_settings_workspace_id_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	check("orchestrator_settings_id_check", sql`id = 1`),
	primaryKey({ columns: [table.id], name: "orchestrator_settings_pkey"}),

]);

export const llmTestClaimsInHarnessShared = harnessShared.table("llm_test_claims", {
	claimKey: text("claim_key").primaryKey().notNull(),
	ownerId: text("owner_id").notNull(),
	scenarioId: text("scenario_id").notNull(),
	identityHash: text("identity_hash").notNull(),
	matrixIndex: integer("matrix_index"),
	acquiredAt: timestamp("acquired_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	metadataJson: jsonb("metadata_json").default({}).notNull(),
}, (table) => [
	index("llm_test_claims_expires_idx").using("btree", table.expiresAt.asc().nullsLast().op("timestamptz_ops")),
	index("llm_test_claims_owner_idx").using("btree", table.ownerId.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.claimKey], name: "llm_test_claims_pkey"}),

]);

export const powerUserSessionsInHarnessShared = harnessShared.table("power_user_sessions", {
	authSessionId: text("auth_session_id").primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	userId: text("user_id").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	revokedAt: timestamp("revoked_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("power_user_sessions_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("text_ops")),
	pgPolicy("power_user_sessions_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.authSessionId], name: "power_user_sessions_pkey"}),

]);

export const operatorOracleMemoryInHarnessShared = harnessShared.table("operator_oracle_memory", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_oracle_memory_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_oracle_memory_pkey"}),

]);

export const operatorOraclePromptInHarnessShared = harnessShared.table("operator_oracle_prompt", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_oracle_prompt_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_oracle_prompt_pkey"}),

]);

export const operatorPreferencesInHarnessShared = harnessShared.table("operator_preferences", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_preferences_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_preferences_pkey"}),

]);

export const operatorPromptUserInHarnessShared = harnessShared.table("operator_prompt_user", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_prompt_user_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_prompt_user_pkey"}),

]);

export const operatorFirstRunInHarnessShared = harnessShared.table("operator_first_run", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_first_run_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_first_run_pkey"}),

]);

export const operatorCapabilityTiersInHarnessShared = harnessShared.table("operator_capability_tiers", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().default({}).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_capability_tiers_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_capability_tiers_pkey"}),

]);

export const pluginAuditLogInHarnessShared = harnessShared.table("plugin_audit_log", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	ts: timestamp({ withTimezone: true }).notNull(),
	pluginName: text("plugin_name").notNull(),
	installSlug: text("install_slug").notNull(),
	actionName: text("action_name").notNull(),
	triggerSource: text("trigger_source").notNull(),
	triggerId: text("trigger_id"),
	paramsJson: jsonb("params_json"),
	outcome: text().notNull(),
	durationMs: integer("duration_ms").notNull(),
	errorMessage: text("error_message"),
	capabilitiesUsed: text("capabilities_used").array(),
	killedByTimeout: boolean("killed_by_timeout"),
	stdoutBytes: integer("stdout_bytes"),
	stderrBytes: integer("stderr_bytes"),
	truncated: boolean(),
}, (table) => [
	index("plugin_audit_by_harness").using("btree", table.installSlug.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("timestamptz_ops")),
	index("plugin_audit_by_plugin").using("btree", table.pluginName.asc().nullsLast().op("timestamptz_ops"), table.ts.desc().nullsFirst().op("timestamptz_ops")),
	index("plugin_audit_outcome").using("btree", table.outcome.asc().nullsLast().op("text_ops")).where(sql`(outcome <> 'ok'::text)`),
]);

export const beekeeperInstancesInHarnessShared = harnessShared.table("beekeeper_instances", {
	instanceId: text("instance_id").primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	codeSha: text("code_sha").notNull(),
	genomeId: text("genome_id"),
	memorySnapshotId: text("memory_snapshot_id"),
	batterySliceId: text("battery_slice_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("beekeeper_instances_gen0_unique").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.codeSha.asc().nullsLast().op("text_ops")).where(sql`(genome_id IS NULL)`),
	unique("beekeeper_instances_workspace_id_code_sha_genome_id_key").on(table.workspaceId, table.codeSha, table.genomeId),
	primaryKey({ columns: [table.instanceId], name: "beekeeper_instances_pkey"}),

]);

export const beekeeperRunsInHarnessShared = harnessShared.table("beekeeper_runs", {
	runId: text("run_id").primaryKey().notNull(),
	instanceId: text("instance_id").notNull(),
	caseId: text("case_id").notNull(),
	caseVariant: text("case_variant").notNull(),
	caseTitle: text("case_title"),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	finishedAt: timestamp("finished_at", { withTimezone: true, mode: 'string' }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	elapsedMs: bigint("elapsed_ms", { mode: "number" }),
	terminalState: text("terminal_state"),
	deterministicSignals: jsonb("deterministic_signals"),
	traceRef: text("trace_ref"),
}, (table) => [
	index("beekeeper_runs_case_idx").using("btree", table.caseId.asc().nullsLast().op("text_ops")),
	index("beekeeper_runs_instance_case_idx").using("btree", table.instanceId.asc().nullsLast().op("text_ops"), table.caseId.asc().nullsLast().op("text_ops")),
	index("beekeeper_runs_instance_idx").using("btree", table.instanceId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.instanceId],
			foreignColumns: [beekeeperInstancesInHarnessShared.instanceId],
			name: "beekeeper_runs_instance_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.runId], name: "beekeeper_runs_pkey"}),

]);

export const mobileDevicesInHarnessShared = harnessShared.table("mobile_devices", {
	deviceId: text("device_id").primaryKey().notNull(),
	userEmail: text("user_email").notNull(),
	workspaceId: text("workspace_id").notNull(),
	deviceKind: text("device_kind").default('mobile').notNull(),
	deviceLabel: text("device_label"),
	pairedAt: timestamp("paired_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lastSeen: timestamp("last_seen", { withTimezone: true, mode: 'string' }),
	revokedAt: timestamp("revoked_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("mobile_devices_user_idx").using("btree", table.userEmail.asc().nullsLast().op("text_ops")),
	index("mobile_devices_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")).where(sql`(revoked_at IS NULL)`),
	pgPolicy("mobile_devices_workspace_policy", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("mobile_devices_device_kind_check", sql`device_kind = 'mobile'::text`),
	primaryKey({ columns: [table.deviceId], name: "mobile_devices_pkey"}),

]);

export const operatorSearchProviderCredentialsInHarnessShared = harnessShared.table("operator_search_provider_credentials", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().default({}).notNull(),
	payloadCt: byteaCustom("payload_ct"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(sql`(EXTRACT(epoch FROM now()) * 1000)::bigint`).notNull(),
}, (table) => [
	pgPolicy("osc_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_search_provider_credentials_pkey"}),

]);

export const coordEventLogInHarnessShared = harnessShared.table("coord_event_log", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	surface: text().notNull(),
	writerKey: text("writer_key"),
	msgId: text("msg_id").notNull(),
	body: jsonb().notNull(),
	ts: timestamp({ withTimezone: true }).defaultNow().notNull(),
	workspaceId: text("workspace_id").default('default').notNull(),
	harnessSlug: text("harness_slug"),
	origin: text().default('local').notNull(),
	authorPubkey: text("author_pubkey"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	fedHlc: text("fed_hlc"),
}, (table) => [
	uniqueIndex("coord_event_log_event_uq").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.surface.asc().nullsLast().op("text_ops"), table.msgId.asc().nullsLast().op("text_ops")).where(sql`(surface = ANY (ARRAY['handoffs'::text, 'escalations'::text]))`),
	uniqueIndex("coord_event_log_fanout_uq").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.msgId.asc().nullsLast().op("text_ops")).where(sql`((surface = 'messages'::text) AND ((body ->> 'notify_kind'::text) IS NOT NULL))`),
	uniqueIndex("coord_event_log_fed_uq").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.msgId.asc().nullsLast().op("text_ops")).where(sql`((harness_slug IS NOT NULL) AND ((body ->> 'notify_kind'::text) IS NULL))`),
	index("coord_event_log_msg_tsv_idx").using("gin", sql`to_tsvector('english'::regconfig, "left"(((COALESCE((body ->> '`).where(sql`(surface = 'messages'::text)`),
	index("coord_event_log_surface_id").using("btree", table.workspaceId.asc().nullsLast().op("int8_ops"), table.surface.asc().nullsLast().op("int8_ops"), table.id.asc().nullsLast().op("text_ops")),
	pgPolicy("coord_event_log_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const coordPresenceInHarnessShared = harnessShared.table("coord_presence", {
	ownerId: text("owner_id").primaryKey().notNull(),
	ownerLabel: text("owner_label").default('').notNull(),
	workspaceId: text("workspace_id").default('default').notNull(),
	source: text().default('').notNull(),
	intent: text().default('').notNull(),
	currentPlanSlug: text("current_plan_slug"),
	currentFiles: jsonb("current_files").default([]).notNull(),
	host: text().default('').notNull(),
	pid: integer(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	heartbeatAt: timestamp("heartbeat_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lastActiveAt: timestamp("last_active_at", { withTimezone: true, mode: 'string' }),
	agentRole: text("agent_role"),
	fleetSlug: text("fleet_slug"),
	fleetRole: text("fleet_role"),
	compactionLimit: integer("compaction_limit"),
	contextTokens: integer("context_tokens"),
	contextEstimatedAt: timestamp("context_estimated_at", { withTimezone: true, mode: 'string' }),
	potSlug: text("pot_slug"),
}, (table) => [
	index("coord_presence_fleet_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.fleetSlug.asc().nullsLast().op("text_ops")).where(sql`(fleet_slug IS NOT NULL)`),
	index("coord_presence_pot_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.potSlug.asc().nullsLast().op("text_ops")).where(sql`(pot_slug IS NOT NULL)`),
	index("coord_presence_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("timestamptz_ops"), table.heartbeatAt.desc().nullsFirst().op("text_ops")),
	pgPolicy("coord_presence_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.ownerId], name: "coord_presence_pkey"}),

]);

export const pendingEventsInHarnessShared = harnessShared.table("pending_events", {
	id: text().primaryKey().notNull(),
	installSlug: text("install_slug").notNull(),
	kind: text().notNull(),
	targetRole: text("target_role").notNull(),
	payload: jsonb(),
	dueAt: timestamp("due_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	consumedAt: timestamp("consumed_at", { withTimezone: true, mode: 'string' }),
	consumedBy: text("consumed_by"),
	sourceId: text("source_id"),
	workspaceId: text("workspace_id").notNull(),
}, (table) => [
	index("pending_events_source_idx").using("btree", table.sourceId.asc().nullsLast().op("text_ops")),
	index("pending_events_unconsumed_idx").using("btree", table.installSlug.asc().nullsLast().op("text_ops"), table.dueAt.asc().nullsLast().op("text_ops")).where(sql`(consumed_at IS NULL)`),
	index("pending_events_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	pgPolicy("pending_events_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("pending_events_workspace_nonempty", sql`workspace_id <> ''::text`),
]);

export const projectSpecRevisionsInHarnessShared = harnessShared.table("project_spec_revisions", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	projectId: text("project_id").notNull(),
	spec: text().notNull(),
	summary: text(),
	authorRole: text("author_role").notNull(),
	author: text(),
	ts: timestamp({ withTimezone: true }).defaultNow().notNull(),
	includeDecisions: jsonb("include_decisions"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	tokensIn: bigint("tokens_in", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	tokensOut: bigint("tokens_out", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	costUsdCents: bigint("cost_usd_cents", { mode: "number" }).default(0).notNull(),
	workspaceId: text("workspace_id").notNull(),
}, (table) => [
	index("project_spec_revisions_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	index("psr_author_role_idx").using("btree", table.authorRole.asc().nullsLast().op("text_ops")),
	index("psr_project_idx").using("btree", table.projectId.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("text_ops")),
	index("psr_ts_idx").using("btree", table.ts.desc().nullsFirst().op("timestamptz_ops")),
	foreignKey({
			columns: [table.projectId],
			foreignColumns: [projectsInHarnessShared.id],
			name: "project_spec_revisions_project_id_fkey"
		}).onDelete("cascade"),
	pgPolicy("project_spec_revisions_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("psr_workspace_nonempty", sql`workspace_id <> ''::text`),
]);

export const tokenIndexInHarnessShared = harnessShared.table("token_index", {
	token: text().primaryKey().notNull(),
	harnessSlug: text("harness_slug").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	workspaceId: text("workspace_id").notNull(),
	kind: text().default('harness').notNull(),
}, (table) => [
	index("token_index_kind_idx").using("btree", table.kind.asc().nullsLast().op("text_ops")),
	index("token_index_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	uniqueIndex("token_index_ws_harness_slug_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops")),
	pgPolicy("token_index_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("token_index_workspace_nonempty", sql`workspace_id <> ''::text`),
]);

export const auditLogInHarnessShared = harnessShared.table("audit_log", {
	id: text().primaryKey().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).notNull(),
	actor: text().default('user').notNull(),
	action: text().notNull(),
	subject: text().notNull(),
	details: jsonb(),
	workspaceId: text("workspace_id").notNull(),
	search: tsvectorCustom("_search").generatedAlwaysAs(sql`((setweight(to_tsvector('simple'::regconfig, COALESCE(subject, ''::text)), 'A'::"char") || setweight(to_tsvector('simple'::regconfig, COALESCE(action, ''::text)), 'B'::"char")) || setweight(to_tsvector('simple'::regconfig, COALESCE(actor, ''::text)), 'C'::"char"))`),
}, (table) => [
	index("audit_action_idx").using("btree", table.action.asc().nullsLast().op("text_ops")),
	index("audit_actor_action_ts_idx").using("btree", table.actor.asc().nullsLast().op("int8_ops"), table.action.asc().nullsLast().op("int8_ops"), table.ts.desc().nullsFirst().op("int8_ops")),
	index("audit_search_idx").using("gin", table.search.asc().nullsLast().op("tsvector_ops")),
	index("audit_subject_ts_idx").using("btree", table.subject.asc().nullsLast().op("int8_ops"), table.ts.desc().nullsFirst().op("text_ops")),
	index("audit_ts_idx").using("btree", table.ts.asc().nullsLast().op("int8_ops")),
	index("audit_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	pgPolicy("audit_log_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("audit_workspace_nonempty", sql`workspace_id <> ''::text`),
]);

export const toastLogInHarnessShared = harnessShared.table("toast_log", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	level: text().notNull(),
	message: text().notNull(),
	description: text(),
	harnessSlug: text("harness_slug"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdAt: bigint("created_at", { mode: "number" }).notNull(),
	actionLabel: text("action_label"),
	actionHref: text("action_href"),
}, (table) => [
	index("toast_log_created_idx").using("btree", table.createdAt.desc().nullsFirst().op("int8_ops")),
	index("toast_log_slug_created_idx").using("btree", table.harnessSlug.asc().nullsLast().op("int8_ops"), table.createdAt.desc().nullsFirst().op("int8_ops")).where(sql`(harness_slug IS NOT NULL)`),
]);

export const deferralPricingModelInHarnessShared = harnessShared.table("deferral_pricing_model", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity({ name: "harness_shared.deferral_pricing_model_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id").notNull(),
	trainedAt: timestamp("trained_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	model: jsonb().notNull(),
	sampleItems: integer("sample_items").notNull(),
	sampleWeeks: numeric("sample_weeks").notNull(),
	createdBy: text("created_by"),
}, (table) => [
	index("deferral_pricing_model_latest_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.trainedAt.desc().nullsFirst().op("text_ops")),
	check("deferral_pricing_model_workspace_nonempty", sql`workspace_id <> ''::text`),
	check("deferral_pricing_model_items_nonneg", sql`sample_items >= 0`),
	check("deferral_pricing_model_weeks_nonneg", sql`sample_weeks >= (0)::numeric`),
]);

export const localBackendsInHarnessShared = harnessShared.table("local_backends", {
	id: text().primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	kind: text().notNull(),
	baseUrl: text("base_url").notNull(),
	models: jsonb().default([]).notNull(),
	maxConcurrent: integer("max_concurrent").default(4).notNull(),
	enabled: boolean().default(true).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("local_backends_workspace").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")).where(sql`enabled`),
	check("local_backends_kind_check", sql`kind = ANY (ARRAY['llama-server'::text, 'vllm'::text, 'ollama'::text])`),
	check("local_backends_max_concurrent_check", sql`max_concurrent > 0`),
]);

export const voiceUtterancesInHarnessShared = harnessShared.table("voice_utterances", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	ts: timestamp({ withTimezone: true }).defaultNow().notNull(),
	source: text().notNull(),
	mode: text(),
	lengthChars: integer("length_chars"),
	nameUsed: boolean("name_used").default(false).notNull(),
	hadBackstory: boolean("had_backstory").default(false).notNull(),
	modifications: jsonb(),
	workspaceId: text("workspace_id"),
}, (table) => [
	index("voice_utterances_mode_idx").using("btree", table.mode.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("text_ops")),
	index("voice_utterances_ts_idx").using("btree", table.ts.desc().nullsFirst().op("timestamptz_ops")),
]);

export const provisionAuditLogInHarnessShared = harnessShared.table("provision_audit_log", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	pluginSlug: text("plugin_slug").notNull(),
	ts: timestamp({ withTimezone: true }).defaultNow().notNull(),
	kind: text().notNull(),
	runId: text("run_id"),
	data: jsonb(),
}, (table) => [
	index("provision_audit_log_target_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.pluginSlug.asc().nullsLast().op("text_ops"), table.ts.asc().nullsLast().op("text_ops")),
	pgPolicy("provision_audit_log_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const messagesInPapercuspShared = papercuspShared.table("messages", {
	id: text().primaryKey().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).notNull(),
	fromDept: text("from_dept").notNull(),
	kind: text().notNull(),
	subject: text().notNull(),
	body: text().notNull(),
	refId: text("ref_id"),
	projectId: text("project_id"),
	directiveId: text("directive_id"),
	status: text().default('pending').notNull(),
	metadata: jsonb(),
}, (table) => [
	index("messages_directive_idx").using("btree", table.directiveId.asc().nullsLast().op("text_ops")),
	index("messages_from_idx").using("btree", table.fromDept.asc().nullsLast().op("text_ops")),
	index("messages_kind_idx").using("btree", table.kind.asc().nullsLast().op("text_ops")),
	index("messages_project_idx").using("btree", table.projectId.asc().nullsLast().op("text_ops")),
	index("messages_status_idx").using("btree", table.status.asc().nullsLast().op("text_ops")),
	index("messages_ts_idx").using("btree", table.ts.asc().nullsLast().op("int8_ops")),
]);

export const messageCommentsInPapercuspShared = papercuspShared.table("message_comments", {
	id: text().primaryKey().notNull(),
	messageId: text("message_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).notNull(),
	author: text().notNull(),
	body: text().notNull(),
}, (table) => [
	index("comments_msg_idx").using("btree", table.messageId.asc().nullsLast().op("text_ops")),
	index("comments_ts_idx").using("btree", table.ts.asc().nullsLast().op("int8_ops")),
	foreignKey({
			columns: [table.messageId],
			foreignColumns: [messagesInPapercuspShared.id],
			name: "message_comments_message_id_fkey"
		}).onDelete("cascade"),
]);

export const backupSnapshotsInHarnessShared = harnessShared.table("backup_snapshots", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	kopiaSnapshotId: text("kopia_snapshot_id"),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	finishedAt: timestamp("finished_at", { withTimezone: true, mode: 'string' }),
	status: text().default('running').notNull(),
	triggerReason: text("trigger_reason").notNull(),
	triggerContext: jsonb("trigger_context"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	bytesAdded: bigint("bytes_added", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	bytesTotal: bigint("bytes_total", { mode: "number" }),
	sourcesJson: jsonb("sources_json").default([]).notNull(),
	errorText: text("error_text"),
}, (table) => [
	index("backup_snapshots_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.startedAt.desc().nullsFirst().op("text_ops")),
	pgPolicy("backup_snapshots_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const harnessRegistryInHarnessShared = harnessShared.table("harness_registry", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("harness_registry_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "harness_registry_pkey"}),

]);

export const backupEventsInHarnessShared = harnessShared.table("backup_events", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	snapshotId: bigint("snapshot_id", { mode: "number" }),
	kind: text().notNull(),
	payloadJson: jsonb("payload_json"),
	at: timestamp({ withTimezone: true }).defaultNow().notNull(),
}, (table) => [
	index("backup_events_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.at.desc().nullsFirst().op("text_ops")),
	foreignKey({
			columns: [table.snapshotId],
			foreignColumns: [backupSnapshotsInHarnessShared.id],
			name: "backup_events_snapshot_id_fkey"
		}).onDelete("cascade"),
	pgPolicy("backup_events_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const adaptiveTelemetryInHarnessShared = harnessShared.table("adaptive_telemetry", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	harnessSlug: text("harness_slug").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).notNull(),
	featureId: text("feature_id").notNull(),
	requestedN: integer("requested_n").notNull(),
	actualN: integer("actual_n").notNull(),
	tierLabel: text("tier_label"),
	availableAtDecision: integer("available_at_decision"),
	maxSlots: integer("max_slots"),
	outcome: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	outcomeTs: bigint("outcome_ts", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	durationMs: bigint("duration_ms", { mode: "number" }),
	workspaceId: text("workspace_id").default('').notNull(),
	synthesized: boolean(),
	synthesisError: text("synthesis_error"),
}, (table) => [
	index("adaptive_telemetry_harness_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("int8_ops")),
	index("adaptive_telemetry_pending_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.featureId.asc().nullsLast().op("text_ops")).where(sql`(outcome IS NULL)`),
	pgPolicy("adaptive_telemetry_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const operatorTrustStoreInHarnessShared = harnessShared.table("operator_trust_store", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
	payloadCt: byteaCustom("payload_ct"),
}, (table) => [
	pgPolicy("operator_trust_store_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_trust_store_pkey"}),

]);

export const redQueenDrillsInHarnessShared = harnessShared.table("red_queen_drills", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	drillClass: text("drill_class").notNull(),
	collectorFamily: text("collector_family").notNull(),
	status: text().default('planted').notNull(),
	plantedAt: timestamp("planted_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	detectedAt: timestamp("detected_at", { withTimezone: true, mode: 'string' }),
	triagedAt: timestamp("triaged_at", { withTimezone: true, mode: 'string' }),
	resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: 'string' }),
	expectedWatchdogKey: text("expected_watchdog_key").notNull(),
	expectedKind: text("expected_kind").notNull(),
	expectedSeverity: text("expected_severity").notNull(),
	expectedDecision: text("expected_decision"),
	detectedWatchdogKey: text("detected_watchdog_key"),
	detectedKind: text("detected_kind"),
	triagedDecision: text("triaged_decision"),
	triagedIdeaType: text("triaged_idea_type"),
	resolvedWithEvidence: boolean("resolved_with_evidence").default(false).notNull(),
	issueId: text("issue_id"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	mttshDetectMs: bigint("mttsh_detect_ms", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	mttshTriageMs: bigint("mttsh_triage_ms", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	mttshFixMs: bigint("mttsh_fix_ms", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	mttshTotalMs: bigint("mttsh_total_ms", { mode: "number" }),
	leakCheckPassed: boolean("leak_check_passed"),
	leakCheck: jsonb("leak_check"),
	plantedArtifacts: jsonb("planted_artifacts"),
	payload: jsonb(),
	error: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("red_queen_drills_class_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.drillClass.asc().nullsLast().op("timestamptz_ops"), table.plantedAt.desc().nullsFirst().op("text_ops")),
	uniqueIndex("red_queen_drills_open_class_uq").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.drillClass.asc().nullsLast().op("text_ops")).where(sql`(status = ANY (ARRAY['planted'::text, 'detected'::text, 'triaged'::text]))`),
	index("red_queen_drills_recent_idx").using("btree", table.workspaceId.asc().nullsLast().op("timestamptz_ops"), table.plantedAt.desc().nullsFirst().op("timestamptz_ops")),
	check("red_queen_drills_status_check", sql`status = ANY (ARRAY['planted'::text, 'detected'::text, 'triaged'::text, 'resolved'::text, 'failed'::text, 'expired'::text])`),
	check("red_queen_drills_expected_kind_check", sql`expected_kind = ANY (ARRAY['bug'::text, 'change'::text])`),
	primaryKey({ columns: [table.id], name: "red_queen_drills_pkey"}),

]);

export const operatorRateLimitConfigInHarnessShared = harnessShared.table("operator_rate_limit_config", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().default({}).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_rate_limit_config_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_rate_limit_config_pkey"}),

]);

export const agentUsageSamplesInHarnessShared = harnessShared.table("agent_usage_samples", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "harness_shared.agent_usage_samples_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).notNull(),
	bucketKey: text("bucket_key").notNull(),
	provider: text().notNull(),
	modelClass: text("model_class").notNull(),
	source: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	inputTokens: bigint("input_tokens", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	outputTokens: bigint("output_tokens", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }),
	costUsd: doublePrecision("cost_usd"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	rlRequestsLimit: bigint("rl_requests_limit", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	rlRequestsRemaining: bigint("rl_requests_remaining", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	rlTokensLimit: bigint("rl_tokens_limit", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	rlTokensRemaining: bigint("rl_tokens_remaining", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	rlResetAt: bigint("rl_reset_at", { mode: "number" }),
	model: text(),
	costSource: text("cost_source"),
	harnessSlug: text("harness_slug"),
	runId: text("run_id"),
	role: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	cacheCreationTokens: bigint("cache_creation_tokens", { mode: "number" }),
	turnCount: integer("turn_count"),
	sessionId: text("session_id"),
	planId: text("plan_id"),
	toolName: text("tool_name"),
	turnTrigger: text("turn_trigger"),
	accountId: text("account_id"),
}, (table) => [
	index("agent_usage_samples_harness_idx").using("btree", table.workspaceId.asc().nullsLast().op("int8_ops"), table.harnessSlug.asc().nullsLast().op("int8_ops"), table.ts.desc().nullsFirst().op("int8_ops")).where(sql`(harness_slug IS NOT NULL)`),
	index("agent_usage_samples_ws_account_ts_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.accountId.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("text_ops")).where(sql`(account_id IS NOT NULL)`),
	index("agent_usage_samples_ws_bucket_ts_idx").using("btree", table.workspaceId.asc().nullsLast().op("int8_ops"), table.bucketKey.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("text_ops")),
	index("agent_usage_samples_ws_plan_ts_idx").using("btree", table.workspaceId.asc().nullsLast().op("int8_ops"), table.planId.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("text_ops")).where(sql`(plan_id IS NOT NULL)`),
	index("agent_usage_samples_ws_role_ts_idx").using("btree", table.workspaceId.asc().nullsLast().op("int8_ops"), table.role.asc().nullsLast().op("int8_ops"), table.ts.desc().nullsFirst().op("int8_ops")).where(sql`(role IS NOT NULL)`),
	index("agent_usage_samples_ws_session_ts_idx").using("btree", table.workspaceId.asc().nullsLast().op("int8_ops"), table.sessionId.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("text_ops")).where(sql`(session_id IS NOT NULL)`),
	index("agent_usage_samples_ws_trigger_ts_idx").using("btree", table.workspaceId.asc().nullsLast().op("int8_ops"), table.turnTrigger.asc().nullsLast().op("int8_ops"), table.ts.desc().nullsFirst().op("text_ops")).where(sql`(turn_trigger IS NOT NULL)`),
	index("agent_usage_samples_ws_ts_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("int8_ops")),
	pgPolicy("agent_usage_samples_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const promptCompositionsInHarnessShared = harnessShared.table("prompt_compositions", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	featureId: text("feature_id"),
	role: text().notNull(),
	runId: text("run_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	tsMs: bigint("ts_ms", { mode: "number" }).notNull(),
	totalChars: integer("total_chars").default(0).notNull(),
	substrateChars: integer("substrate_chars").default(0).notNull(),
	historyChars: integer("history_chars").default(0).notNull(),
	rolePromptChars: integer("role_prompt_chars"),
	memoryChars: integer("memory_chars"),
	identityChars: integer("identity_chars"),
	runtimeChars: integer("runtime_chars"),
}, (table) => [
	index("prompt_compositions_by_feature").using("btree", table.workspaceId.asc().nullsLast().op("int8_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.featureId.asc().nullsLast().op("text_ops"), table.tsMs.desc().nullsFirst().op("text_ops")).where(sql`(feature_id IS NOT NULL)`),
	index("prompt_compositions_by_harness").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("int8_ops"), table.tsMs.desc().nullsFirst().op("int8_ops")),
	pgPolicy("prompt_compositions_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const substrateOutboxInHarnessShared = harnessShared.table("substrate_outbox", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	tableName: text("table_name").notNull(),
	op: text().notNull(),
	key: text().notNull(),
	row: jsonb(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	drainedAt: bigint("drained_at", { mode: "number" }),
	opHlc: text("op_hlc"),
	drainedLogKey: text("drained_log_key"),
}, (table) => [
	index("substrate_outbox_drain_idx").using("btree", table.workspaceId.asc().nullsLast().op("int8_ops"), table.harnessSlug.asc().nullsLast().op("int8_ops"), table.drainedAt.asc().nullsLast().op("text_ops"), table.id.asc().nullsLast().op("text_ops")),
	check("substrate_outbox_op_check", sql`op = ANY (ARRAY['put'::text, 'del'::text])`),
]);

export const savedPromptsInHarnessShared = harnessShared.table("saved_prompts", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug"),
	name: text().notNull(),
	body: text().notNull(),
	description: text(),
	argHint: text("arg_hint"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("saved_prompts_scope_name").using("btree", sql`workspace_id`, sql`COALESCE(harness_slug, ''::text)`, sql`name`),
	pgPolicy("saved_prompts_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.id], name: "saved_prompts_pkey"}),

]);

export const gitExportOutboxInHarnessShared = harnessShared.table("git_export_outbox", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	tableName: text("table_name").notNull(),
	op: text().notNull(),
	key: text().notNull(),
	row: jsonb(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	exportedAt: bigint("exported_at", { mode: "number" }),
}, (table) => [
	index("git_export_outbox_drain_idx").using("btree", table.workspaceId.asc().nullsLast().op("int8_ops"), table.harnessSlug.asc().nullsLast().op("int8_ops"), table.exportedAt.asc().nullsLast().op("text_ops"), table.id.asc().nullsLast().op("text_ops")),
	check("git_export_outbox_op_check", sql`op = ANY (ARRAY['put'::text, 'del'::text])`),
]);

export const ptyViewerHeartbeatsInHarnessShared = harnessShared.table("pty_viewer_heartbeats", {
	ptyId: text("pty_id").primaryKey().notNull(),
	ownerSid: text("owner_sid").notNull(),
	viewerAttachedAt: timestamp("viewer_attached_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("pty_viewer_heartbeats_fresh_idx").using("btree", table.viewerAttachedAt.asc().nullsLast().op("text_ops"), table.ownerSid.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.ptyId], name: "pty_viewer_heartbeats_pkey"}),

]);

export const memoryVecOpenaiInHarnessShared = harnessShared.table("memory_vec_openai", {
	memoryId: uuid("memory_id").primaryKey().notNull(),
	vector: vector({ dimensions: 384 }).notNull(),
	embeddedAt: timestamp("embedded_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("memory_vec_openai_hnsw_idx").using("hnsw", table.vector.asc().nullsLast().op("vector_cosine_ops")),
	foreignKey({
			columns: [table.memoryId],
			foreignColumns: [memoryCanonicalInHarnessShared.id],
			name: "memory_vec_openai_memory_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.memoryId], name: "memory_vec_openai_pkey"}),

]);

export const memoryVecLocalInHarnessShared = harnessShared.table("memory_vec_local", {
	memoryId: uuid("memory_id").primaryKey().notNull(),
	vector: vector({ dimensions: 384 }).notNull(),
	embeddedAt: timestamp("embedded_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("memory_vec_local_hnsw_idx").using("hnsw", table.vector.asc().nullsLast().op("vector_cosine_ops")),
	foreignKey({
			columns: [table.memoryId],
			foreignColumns: [memoryCanonicalInHarnessShared.id],
			name: "memory_vec_local_memory_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.memoryId], name: "memory_vec_local_pkey"}),

]);

export const testRunsInHarnessShared = harnessShared.table("test_runs", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	filePath: text("file_path").notNull(),
	framework: text().notNull(),
	status: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	durationMs: bigint("duration_ms", { mode: "number" }),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	finishedAt: timestamp("finished_at", { withTimezone: true, mode: 'string' }),
	outputTail: text("output_tail"),
	suiteId: text("suite_id"),
	runGroupId: text("run_group_id"),
	source: text().default('local').notNull(),
	branch: text(),
	commitSha: text("commit_sha"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	harnessSlug: text("harness_slug"),
	workspaceId: text("workspace_id"),
	loopLagP95Ms: real("loop_lag_p95_ms"),
	rssMb: real("rss_mb"),
}, (table) => [
	index("test_runs_branch_idx").using("btree", table.branch.asc().nullsLast().op("timestamptz_ops"), table.finishedAt.desc().nullsFirst().op("timestamptz_ops")).where(sql`(branch IS NOT NULL)`),
	index("test_runs_file_path_idx").using("btree", table.filePath.asc().nullsLast().op("timestamptz_ops"), table.finishedAt.desc().nullsFirst().op("timestamptz_ops")),
	index("test_runs_harness_scope_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.workspaceId.asc().nullsLast().op("text_ops"), table.filePath.asc().nullsLast().op("timestamptz_ops"), table.finishedAt.desc().nullsFirst().op("timestamptz_ops")).where(sql`(harness_slug IS NOT NULL)`),
	index("test_runs_run_group_idx").using("btree", table.runGroupId.asc().nullsLast().op("text_ops")).where(sql`(run_group_id IS NOT NULL)`),
	index("test_runs_source_idx").using("btree", table.source.asc().nullsLast().op("text_ops"), table.finishedAt.desc().nullsFirst().op("text_ops")),
	check("test_runs_source_valid", sql`source = ANY (ARRAY['ci'::text, 'local'::text, 'admin-ui'::text])`),
	check("test_runs_status_valid", sql`status = ANY (ARRAY['pass'::text, 'fail'::text, 'skip'::text, 'cancelled'::text, 'error'::text, 'running'::text])`),
]);

export const featureAuditConsolidatedInHarnessShared = harnessShared.table("feature_audit_consolidated", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
	harnessSlug: text("harness_slug").notNull(),
	featureId: text("feature_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).notNull(),
	field: text().notNull(),
	oldValue: text("old_value"),
	newValue: text("new_value"),
	actor: text(),
}, (table) => [
	index("feature_audit_consolidated_lookup_idx").using("btree", table.workspaceId.asc().nullsLast().op("int8_ops"), table.harnessSlug.asc().nullsLast().op("int8_ops"), table.featureId.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("text_ops")),
	pgPolicy("feature_audit_consolidated_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const ownerInteractionsInHarnessShared = harnessShared.table("owner_interactions", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	workspaceId: text("workspace_id").default('default').notNull(),
	ts: timestamp({ withTimezone: true }).defaultNow().notNull(),
	kind: text().notNull(),
	subjectKind: text("subject_kind").notNull(),
	subjectId: text("subject_id").default('').notNull(),
	payload: jsonb().default({}).notNull(),
}, (table) => [
	index("owner_interactions_ws_kind_ts_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.kind.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("text_ops")),
	index("owner_interactions_ws_ts_idx").using("btree", table.workspaceId.asc().nullsLast().op("timestamptz_ops"), table.ts.desc().nullsFirst().op("timestamptz_ops")),
	primaryKey({ columns: [table.id], name: "owner_interactions_pkey"}),

]);

export const eventWakeDeliveriesInHarnessShared = harnessShared.table("event_wake_deliveries", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "harness_shared.event_wake_deliveries_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id").default('default').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	awaitId: bigint("await_id", { mode: "number" }).notNull(),
	subscriberId: text("subscriber_id").notNull(),
	eventKey: text("event_key").notNull(),
	payload: jsonb(),
	summary: text(),
	status: text().default('pending').notNull(),
	channel: text(),
	attempts: integer().default(0).notNull(),
	lastError: text("last_error"),
	nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	deliveredAt: timestamp("delivered_at", { withTimezone: true, mode: 'string' }),
	urgent: boolean().default(false).notNull(),
	minSleepSec: integer("min_sleep_sec"),
	coalescedCount: integer("coalesced_count").default(1).notNull(),
	source: text(),
}, (table) => [
	index("idx_event_wake_deliveries_due").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.nextAttemptAt.asc().nullsLast().op("text_ops")).where(sql`(status = ANY (ARRAY['pending'::text, 'parked'::text, 'delivering'::text]))`),
	index("idx_event_wake_deliveries_subscriber").using("btree", table.subscriberId.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("text_ops")),
	pgPolicy("event_wake_deliveries_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("event_wake_deliveries_status_check", sql`status = ANY (ARRAY['pending'::text, 'parked'::text, 'delivering'::text, 'delivered'::text, 'dropped'::text, 'dead'::text])`),
]);

export const eventAwaitsInHarnessShared = harnessShared.table("event_awaits", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "harness_shared.event_awaits_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id").default('default').notNull(),
	subscriberId: text("subscriber_id").notNull(),
	eventKey: text("event_key").notNull(),
	policy: text().default('wake').notNull(),
	note: text(),
	wakeHandle: jsonb("wake_handle"),
	timeoutBehavior: text("timeout_behavior").default('expire').notNull(),
	expiresTs: timestamp("expires_ts", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	firedAt: timestamp("fired_at", { withTimezone: true, mode: 'string' }),
	firedReason: text("fired_reason"),
	cancelledAt: timestamp("cancelled_at", { withTimezone: true, mode: 'string' }),
	once: boolean().default(true).notNull(),
	minSleepSec: integer("min_sleep_sec"),
	urgency: boolean().default(false).notNull(),
}, (table) => [
	uniqueIndex("event_awaits_inbox_wake_one_per_agent").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.subscriberId.asc().nullsLast().op("text_ops"), table.eventKey.asc().nullsLast().op("text_ops")).where(sql`((policy = 'wake'::text) AND (once = false) AND (cancelled_at IS NULL) AND (event_key ~~ 'coord:inbox-wake:%'::text))`),
	index("event_awaits_pattern_active").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")).where(sql`((event_key ~~ '%*%'::text) AND (fired_at IS NULL) AND (cancelled_at IS NULL))`),
	index("idx_event_awaits_active_key").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.eventKey.asc().nullsLast().op("text_ops")).where(sql`((fired_at IS NULL) AND (cancelled_at IS NULL))`),
	index("idx_event_awaits_expiry").using("btree", table.expiresTs.asc().nullsLast().op("timestamptz_ops")).where(sql`((fired_at IS NULL) AND (cancelled_at IS NULL) AND (expires_ts IS NOT NULL))`),
	index("idx_event_awaits_subscriber").using("btree", table.subscriberId.asc().nullsLast().op("text_ops")).where(sql`((fired_at IS NULL) AND (cancelled_at IS NULL))`),
	pgPolicy("event_awaits_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("event_awaits_policy_check", sql`policy = ANY (ARRAY['wake'::text, 'notify'::text])`),
	check("event_awaits_timeout_behavior_check", sql`timeout_behavior = ANY (ARRAY['expire'::text, 'wake'::text])`),
]);

export const operatorVoiceChannelsInHarnessShared = harnessShared.table("operator_voice_channels", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_voice_channels_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_voice_channels_pkey"}),

]);

export const pipelineEventsInHarnessShared = harnessShared.table("pipeline_events", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	installSlug: text("install_slug").notNull(),
	kind: text().notNull(),
	status: text().notNull(),
	detail: jsonb().default({}).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("pipeline_events_slug_created_idx").using("btree", table.installSlug.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	index("pipeline_events_slug_kind_created_idx").using("btree", table.installSlug.asc().nullsLast().op("timestamptz_ops"), table.kind.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("text_ops")),
	pgPolicy("pipeline_events_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("pipeline_events_kind_check", sql`kind = ANY (ARRAY['git_sync'::text, 'merge_resolver'::text, 'content_fixer'::text, 'green_checkpoint'::text, 'deploy'::text, 'release_fixer'::text])`),
	check("pipeline_events_workspace_nonempty", sql`workspace_id <> ''::text`),
	check("pipeline_events_slug_nonempty", sql`install_slug <> ''::text`),
]);

export const tuiIntentsInHarnessShared = harnessShared.table("tui_intents", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	clientId: text("client_id").notNull(),
	intent: text().notNull(),
	args: jsonb().default({}).notNull(),
	status: text().default('pending').notNull(),
	result: jsonb(),
	errorMessage: text("error_message"),
	requestedBy: text("requested_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: 'string' }),
	workspaceId: text("workspace_id").notNull(),
}, (table) => [
	index("tui_intents_client_pending_idx").using("btree", table.clientId.asc().nullsLast().op("int8_ops"), table.status.asc().nullsLast().op("int8_ops"), table.id.asc().nullsLast().op("text_ops")),
	index("tui_intents_workspace_id_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
]);

export const advSessionsInHarnessShared = harnessShared.table("adv_sessions", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	planSlug: text("plan_slug"),
	mode: text().notNull(),
	terminalBin: text("terminal_bin"),
	pid: integer(),
	windowId: text("window_id"),
	ompThreadId: text("omp_thread_id"),
	label: text(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	endedAt: timestamp("ended_at", { withTimezone: true, mode: 'string' }),
	exitCode: integer("exit_code"),
	cwd: text(),
	agent: text(),
	role: text(),
	feature: text(),
	coordOwnerId: text("coord_owner_id"),
	sessionId: text("session_id"),
	display: text(),
	launchArgv: jsonb("launch_argv"),
	launchedAt: timestamp("launched_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("adv_sessions_coord_owner_idx").using("btree", table.coordOwnerId.asc().nullsLast().op("text_ops")).where(sql`(coord_owner_id IS NOT NULL)`),
	index("adv_sessions_pending_workbench_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.startedAt.desc().nullsFirst().op("text_ops")).where(sql`((display = 'workbench'::text) AND (launched_at IS NULL) AND (ended_at IS NULL))`),
	index("adv_sessions_plan_idx").using("btree", table.planSlug.asc().nullsLast().op("timestamptz_ops"), table.startedAt.desc().nullsFirst().op("text_ops")).where(sql`(plan_slug IS NOT NULL)`),
	index("adv_sessions_session_id_idx").using("btree", table.sessionId.asc().nullsLast().op("text_ops")),
	index("adv_sessions_workspace_active_idx").using("btree", table.workspaceId.asc().nullsLast().op("timestamptz_ops"), table.startedAt.desc().nullsFirst().op("timestamptz_ops")).where(sql`(ended_at IS NULL)`),
	index("adv_sessions_workspace_recent_idx").using("btree", table.workspaceId.asc().nullsLast().op("timestamptz_ops"), table.startedAt.desc().nullsFirst().op("text_ops")),
	pgPolicy("adv_sessions_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("adv_sessions_mode_check", sql`mode = ANY (ARRAY['omp'::text, 'console'::text])`),
]);

export const toolInvocationsInHarnessShared = harnessShared.table("tool_invocations", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	pluginName: text("plugin_name").notNull(),
	toolName: text("tool_name").notNull(),
	role: text().notNull(),
	featureId: text("feature_id"),
	chunkId: text("chunk_id"),
	runId: text("run_id"),
	spawnId: text("spawn_id").notNull(),
	parentSpawnId: text("parent_spawn_id"),
	windowKey: text("window_key").notNull(),
	invokedAt: timestamp("invoked_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	durationMs: integer("duration_ms"),
	status: text().notNull(),
	outputRef: text("output_ref"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	outputSize: bigint("output_size", { mode: "number" }),
	errorMessage: text("error_message"),
	argsJson: jsonb("args_json"),
	eventCount: integer("event_count"),
	metadataJson: jsonb("metadata_json"),
	transport: text(),
	principalKind: text("principal_kind"),
	principalAuthMethod: text("principal_auth_method"),
	principalTrust: text("principal_trust"),
	errorCode: text("error_code"),
	coordOwnerId: text("coord_owner_id"),
}, (table) => [
	index("tool_invocations_coord_owner_idx").using("btree", table.coordOwnerId.asc().nullsLast().op("text_ops"), table.invokedAt.desc().nullsFirst().op("timestamptz_ops")).where(sql`(coord_owner_id IS NOT NULL)`),
	index("tool_invocations_error_code_idx").using("btree", table.errorCode.asc().nullsLast().op("timestamptz_ops"), table.invokedAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(error_code IS NOT NULL)`),
	index("tool_invocations_invoked_at_cov_idx").using("btree", table.invokedAt.desc().nullsFirst().op("timestamptz_ops"), table.toolName.asc().nullsLast().op("timestamptz_ops"), table.durationMs.asc().nullsLast().op("timestamptz_ops"), table.status.asc().nullsLast().op("timestamptz_ops")),
	index("tool_invocations_parent_spawn_partial_idx").using("btree", table.parentSpawnId.asc().nullsLast().op("text_ops")).where(sql`((parent_spawn_id IS NOT NULL) AND (parent_spawn_id <> ''::text))`),
	index("tool_invocations_quota_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.toolName.asc().nullsLast().op("text_ops"), table.role.asc().nullsLast().op("text_ops"), table.windowKey.asc().nullsLast().op("text_ops")).where(sql`(status = 'ok'::text)`),
	index("tool_invocations_spawn_id_ws_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.spawnId.asc().nullsLast().op("text_ops")),
	index("tool_invocations_telemetry_idx").using("btree", table.workspaceId.asc().nullsLast().op("timestamptz_ops"), table.harnessSlug.asc().nullsLast().op("timestamptz_ops"), table.invokedAt.desc().nullsFirst().op("timestamptz_ops")),
	pgPolicy("tool_invocations_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const hiveWatchdogFiresInHarnessShared = harnessShared.table("hive_watchdog_fires", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "harness_shared.hive_watchdog_fires_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id").notNull(),
	installSlug: text("install_slug").notNull(),
	firedAt: timestamp("fired_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	source: text().notNull(),
	reason: text().default('').notNull(),
	wakeAt: timestamp("wake_at", { withTimezone: true, mode: 'string' }),
	demand: jsonb().default({}).notNull(),
}, (table) => [
	index("hive_watchdog_fires_ws_install_fired_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.installSlug.asc().nullsLast().op("text_ops"), table.firedAt.desc().nullsFirst().op("text_ops")),
	pgPolicy("hive_watchdog_fires_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const workItemDepsInHarnessShared = harnessShared.table("work_item_deps", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity({ name: "harness_shared.work_item_deps_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id").default('default').notNull(),
	blockedKind: text("blocked_kind").notNull(),
	blockedRef: text("blocked_ref").notNull(),
	blockerKind: text("blocker_kind").notNull(),
	blockerRef: text("blocker_ref").notNull(),
	depType: text("dep_type").default('blocks').notNull(),
	createdBy: text("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("work_item_deps_blocked_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.blockedKind.asc().nullsLast().op("text_ops"), table.blockedRef.asc().nullsLast().op("text_ops")),
	index("work_item_deps_blocker_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.blockerKind.asc().nullsLast().op("text_ops"), table.blockerRef.asc().nullsLast().op("text_ops")),
	uniqueIndex("work_item_deps_edge_uniq").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.blockedKind.asc().nullsLast().op("text_ops"), table.blockedRef.asc().nullsLast().op("text_ops"), table.blockerKind.asc().nullsLast().op("text_ops"), table.blockerRef.asc().nullsLast().op("text_ops"), table.depType.asc().nullsLast().op("text_ops")),
	check("work_item_deps_endpoints_nonempty", sql`(blocked_kind <> ''::text) AND (blocked_ref <> ''::text) AND (blocker_kind <> ''::text) AND (blocker_ref <> ''::text)`),
	check("work_item_deps_workspace_nonempty", sql`workspace_id <> ''::text`),
	check("work_item_deps_no_self", sql`NOT ((blocked_kind = blocker_kind) AND (blocked_ref = blocker_ref))`),
]);

export const planRunTurnsInHarnessShared = harnessShared.table("plan_run_turns", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	planRunId: bigint("plan_run_id", { mode: "number" }).notNull(),
	seq: integer().notNull(),
	role: text().notNull(),
	content: text().notNull(),
	tokensIn: integer("tokens_in"),
	tokensOut: integer("tokens_out"),
	costUsd: numeric("cost_usd"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdAt: bigint("created_at", { mode: "number" }).notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
	harnessSlug: text("harness_slug"),
}, (table) => [
	index("plan_run_turns_harness_slug_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops")),
	index("plan_run_turns_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.planRunId],
			foreignColumns: [planRunsInHarnessShared.id],
			name: "plan_run_turns_plan_run_id_fkey"
		}),
	unique("plan_run_turns_plan_run_id_seq_key").on(table.planRunId, table.seq),
	pgPolicy("plan_run_turns_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const planRunsInHarnessShared = harnessShared.table("plan_runs", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).default(sql`nextval('harness_shared.plan_runs_id_seq'::regclass)`).primaryKey().notNull(),
	planSlug: text("plan_slug").notNull(),
	planContentHash: text("plan_content_hash").notNull(),
	sessionId: text("session_id").notNull(),
	note: text(),
	launchedBy: text("launched_by").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	launchedAt: bigint("launched_at", { mode: "number" }).notNull(),
	status: text().notNull(),
	title: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
	harnessSlug: text("harness_slug").default('papercup').notNull(),
	instancePlanSlug: text("instance_plan_slug"),
	runSeq: integer("run_seq"),
	trigger: text(),
	runType: text("run_type").default('interactive').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	finishedAt: bigint("finished_at", { mode: "number" }),
	outcome: text(),
	resultSummary: jsonb("result_summary"),
	workspaceId: text("workspace_id").default('').notNull(),
}, (table) => [
	index("plan_runs_harness_plan_slug_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.planSlug.asc().nullsLast().op("text_ops")),
	index("plan_runs_plan_slug_idx").using("btree", table.planSlug.asc().nullsLast().op("text_ops")),
	index("plan_runs_template_seq_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.planSlug.asc().nullsLast().op("int4_ops"), table.runSeq.desc().nullsFirst().op("int4_ops")),
	index("plan_runs_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	pgPolicy("plan_runs_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.id], name: "plan_runs_pkey"}),

]);

export const hiveEvalBakeoffDeltasInHarnessShared = harnessShared.table("hive_eval_bakeoff_deltas", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	flagKey: text("flag_key").notNull(),
	deltaMeanComposite: doublePrecision("delta_mean_composite").notNull(),
	deltaGatePassRate: doublePrecision("delta_gate_pass_rate").notNull(),
	verdict: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	runAtMs: bigint("run_at_ms", { mode: "number" }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("hive_eval_bakeoff_deltas_ws_run_idx").using("btree", table.workspaceId.asc().nullsLast().op("int8_ops"), table.runAtMs.desc().nullsFirst().op("int8_ops")),
]);

export const planRevisionsInHarnessShared = harnessShared.table("plan_revisions", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	planSlug: text("plan_slug").notNull(),
	seq: integer().notNull(),
	contentHash: text("content_hash").notNull(),
	contentSnapshot: text("content_snapshot").notNull(),
	rationale: text(),
	authorKind: text("author_kind").notNull(),
	authorId: text("author_id").notNull(),
	sessionId: text("session_id"),
	sessionKind: text("session_kind"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdAt: bigint("created_at", { mode: "number" }).notNull(),
	harnessSlug: text("harness_slug").default('papercup').notNull(),
	workspaceId: text("workspace_id").default('default').notNull(),
}, (table) => [
	unique("plan_revisions_ws_harness_plan_seq_key").on(table.planSlug, table.seq, table.harnessSlug, table.workspaceId),
	pgPolicy("plan_revisions_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const operatorTurnsInHarnessShared = harnessShared.table("operator_turns", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	conversationId: uuid("conversation_id").notNull(),
	seq: integer().notNull(),
	role: text().notNull(),
	text: text().notNull(),
	source: text().default('text_typed').notNull(),
	elConvId: text("el_conv_id"),
	audioUrl: text("audio_url"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdAt: bigint("created_at", { mode: "number" }).notNull(),
	tools: jsonb(),
	textTsv: tsvectorCustom("text_tsv"),
	textEmbedding: vector("text_embedding", { dimensions: 384 }),
	report: jsonb(),
	workspaceId: text("workspace_id").notNull(),
}, (table) => [
	index("operator_turns_conv_seq_idx").using("btree", table.conversationId.asc().nullsLast().op("int4_ops"), table.seq.asc().nullsLast().op("uuid_ops")),
	index("operator_turns_report_recent_idx").using("btree", table.createdAt.asc().nullsLast().op("int8_ops")).where(sql`(report IS NOT NULL)`),
	index("operator_turns_text_embedding_hnsw").using("hnsw", table.textEmbedding.asc().nullsLast().op("vector_cosine_ops")),
	index("operator_turns_tsv_idx").using("gin", table.textTsv.asc().nullsLast().op("tsvector_ops")),
	index("operator_turns_workspace_id_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.conversationId],
			foreignColumns: [operatorConversationsInHarnessShared.id],
			name: "operator_turns_conversation_id_fkey"
		}).onDelete("cascade"),
	unique("operator_turns_conversation_id_seq_key").on(table.conversationId, table.seq),
	check("operator_turns_role_check", sql`role = ANY (ARRAY['user'::text, 'assistant'::text, 'system'::text])`),
	primaryKey({ columns: [table.id], name: "operator_turns_pkey"}),

]);

export const operatorConversationsInHarnessShared = harnessShared.table("operator_conversations", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
	harnessSlug: text("harness_slug"),
	title: text(),
	status: text().default('active').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	startedAt: bigint("started_at", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	endedAt: bigint("ended_at", { mode: "number" }),
	elConversationIds: text("el_conversation_ids").array().default([""]).notNull(),
	hasAudio: boolean("has_audio").default(false).notNull(),
	summaryText: text("summary_text"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	summaryThroughSeq: bigint("summary_through_seq", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	summaryUpdatedAt: bigint("summary_updated_at", { mode: "number" }),
	summaryModel: text("summary_model"),
	summaryTurnsCovered: integer("summary_turns_covered"),
}, (table) => [
	index("operator_conversations_active_idx").using("btree", sql`workspace_id`, sql`COALESCE(harness_slug, ''::text)`).where(sql`(status = 'active'::text)`),
	index("operator_conversations_started_idx").using("btree", table.workspaceId.asc().nullsLast().op("int8_ops"), table.startedAt.desc().nullsFirst().op("int8_ops")),
	pgPolicy("operator_conversations_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.id], name: "operator_conversations_pkey"}),

]);

export const voiceRelayInHarnessShared = harnessShared.table("voice_relay", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("voice_relay_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "voice_relay_pkey"}),

]);

export const spawnedAgentsInHarnessShared = harnessShared.table("spawned_agents", {
	spawnId: text("spawn_id").primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	parentSpawnId: text("parent_spawn_id"),
	parentRole: text("parent_role").notNull(),
	childRole: text("child_role").notNull(),
	featureId: text("feature_id"),
	chunkId: text("chunk_id"),
	runId: text("run_id").notNull(),
	status: text().notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	finishedAt: timestamp("finished_at", { withTimezone: true, mode: 'string' }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	durationMs: bigint("duration_ms", { mode: "number" }),
	exitCode: integer("exit_code"),
	outputTail: text("output_tail"),
	errorMessage: text("error_message"),
	cancelRequested: boolean("cancel_requested").default(false).notNull(),
	sessionOwner: text("session_owner"),
	coordinationDomain: text("coordination_domain").default('default').notNull(),
	planSlug: text("plan_slug"),
	itemId: text("item_id"),
	restartStrategy: text("restart_strategy").default('one_for_one').notNull(),
	restartCount: integer("restart_count").default(0).notNull(),
	restartWindowStart: timestamp("restart_window_start", { withTimezone: true, mode: 'string' }),
	cancelReason: text("cancel_reason"),
	cancelledAt: timestamp("cancelled_at", { withTimezone: true, mode: 'string' }),
	heartbeatAt: timestamp("heartbeat_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	sessionId: text("session_id"),
	idempotencyKey: text("idempotency_key"),
	pid: integer(),
	launcherHost: text("launcher_host"),
	modelSpec: text("model_spec"),
	modelTier: text("model_tier"),
	brief: text(),
	lastOutputAt: timestamp("last_output_at", { withTimezone: true, mode: 'string' }),
	launcherBootId: text("launcher_boot_id"),
	fleetSlug: text("fleet_slug"),
}, (table) => [
	index("spawned_agents_active_heartbeat_idx").using("btree", table.heartbeatAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(status = ANY (ARRAY['running'::text, 'restarting'::text]))`),
	index("spawned_agents_fleet_slug_running_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.fleetSlug.asc().nullsLast().op("text_ops")).where(sql`((fleet_slug IS NOT NULL) AND (status = ANY (ARRAY['running'::text, 'restarting'::text])))`),
	uniqueIndex("spawned_agents_idempotency_key_uq").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.idempotencyKey.asc().nullsLast().op("text_ops")).where(sql`(idempotency_key IS NOT NULL)`),
	index("spawned_agents_parent_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.parentSpawnId.asc().nullsLast().op("text_ops")),
	index("spawned_agents_recent_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("timestamptz_ops"), table.startedAt.desc().nullsFirst().op("timestamptz_ops")),
	index("spawned_agents_running_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")).where(sql`(status = 'running'::text)`),
	index("spawned_agents_session_id_idx").using("btree", table.sessionId.asc().nullsLast().op("text_ops")).where(sql`(session_id IS NOT NULL)`),
	index("spawned_agents_session_owner_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.sessionOwner.asc().nullsLast().op("text_ops")).where(sql`(session_owner IS NOT NULL)`),
	pgPolicy("spawned_agents_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("spawned_agents_restart_strategy_chk", sql`restart_strategy = ANY (ARRAY['one_for_one'::text, 'one_for_all'::text, 'rest_for_one'::text])`),
	primaryKey({ columns: [table.spawnId], name: "spawned_agents_pkey"}),

]);

export const harnessProjectFilesInHarnessShared = harnessShared.table("harness_project_files", {
	harnessSlug: text("harness_slug").primaryKey().notNull(),
	spec: text(),
	agents: text(),
	contract: text(),
	config: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	version: bigint({ mode: "number" }).default(0).notNull(),
}, (table) => [
	index("harness_project_files_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	pgPolicy("harness_project_files_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.harnessSlug], name: "harness_project_files_pkey"}),

]);

export const decisionLedgerInHarnessShared = harnessShared.table("decision_ledger", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "harness_shared.decision_ledger_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug"),
	layer: text().default('action').notNull(),
	ts: timestamp({ withTimezone: true }).defaultNow().notNull(),
	action: text().notNull(),
	capability: text(),
	tier: text(),
	category: text(),
	riskTier: text("risk_tier"),
	reversibility: text(),
	authority: text(),
	posture: text().notNull(),
	outcome: text().notNull(),
	outcomeCode: text("outcome_code"),
	revertHandle: text("revert_handle"),
	why: text(),
	links: jsonb(),
	actorRole: text("actor_role"),
	actorSpawnId: text("actor_spawn_id"),
	actorPrincipal: text("actor_principal"),
	transport: text(),
	durationMs: integer("duration_ms"),
	argsDigest: text("args_digest"),
	metadata: jsonb(),
	disposition: text(),
	revisitAt: timestamp("revisit_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("decision_ledger_ws_category_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.category.asc().nullsLast().op("timestamptz_ops"), table.ts.desc().nullsFirst().op("timestamptz_ops")),
	index("decision_ledger_ws_layer_ts_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.layer.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("timestamptz_ops")),
	index("decision_ledger_ws_posture_idx").using("btree", table.workspaceId.asc().nullsLast().op("timestamptz_ops"), table.posture.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("timestamptz_ops")),
	index("decision_ledger_ws_ts_idx").using("btree", table.workspaceId.asc().nullsLast().op("timestamptz_ops"), table.ts.desc().nullsFirst().op("timestamptz_ops")),
	check("decision_ledger_layer_check", sql`layer = ANY (ARRAY['action'::text, 'disposition'::text])`),
	check("decision_ledger_posture_check", sql`posture = ANY (ARRAY['auto'::text, 'proposed'::text, 'gated'::text, 'rejected'::text])`),
	check("decision_ledger_outcome_check", sql`outcome = ANY (ARRAY['ok'::text, 'error'::text])`),
	check("decision_ledger_disposition_check", sql`(disposition IS NULL) OR (disposition = ANY (ARRAY['act'::text, 'defer'::text, 'reject'::text, 'route-to-research'::text, 'no-op'::text]))`),
]);

export const hiveThroughputTicksInHarnessShared = harnessShared.table("hive_throughput_ticks", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "harness_shared.hive_throughput_ticks_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id").notNull(),
	tickAt: timestamp("tick_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	frontierDepth: integer("frontier_depth").default(0).notNull(),
	placements: integer().default(0).notNull(),
	beesBusy: integer("bees_busy").default(0).notNull(),
	beesCap: integer("bees_cap").default(0).notNull(),
	stuckCount: integer("stuck_count").default(0).notNull(),
	completed: integer().default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	mttcMs: bigint("mttc_ms", { mode: "number" }),
	questionRungs: jsonb("question_rungs").default({}).notNull(),
	detail: jsonb(),
	potSlug: text("pot_slug").notNull(),
}, (table) => [
	index("hive_throughput_ticks_ws_pot_tick_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.potSlug.asc().nullsLast().op("text_ops"), table.tickAt.desc().nullsFirst().op("text_ops")),
	pgPolicy("hive_throughput_ticks_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const hiveWakeInHarnessShared = harnessShared.table("hive_wake", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().default({}).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("hive_wake_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "hive_wake_pkey"}),

]);

export const watchdogTicksInHarnessShared = harnessShared.table("watchdog_ticks", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "harness_shared.watchdog_ticks_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id").notNull(),
	installSlug: text("install_slug"),
	tickAt: timestamp("tick_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	status: text().default('ran').notNull(),
	signals: integer().default(0).notNull(),
	captured: text().array().default([""]).notNull(),
	declinedDuplicates: integer("declined_duplicates").default(0).notNull(),
	deferred: integer().default(0).notNull(),
	collectors: jsonb().default([]).notNull(),
	selfEscalations: text("self_escalations").array().default([""]).notNull(),
	deferredKeys: text("deferred_keys").array().default([""]).notNull(),
	knownOpenKeys: text("known_open_keys").array().default([""]).notNull(),
	staleResolvedKeys: text("stale_resolved_keys").array().default([""]).notNull(),
}, (table) => [
	index("watchdog_ticks_ws_tick_at_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.tickAt.desc().nullsFirst().op("text_ops")),
	pgPolicy("watchdog_ticks_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const crossHiveBeaconHistoryInHarnessShared = harnessShared.table("cross_hive_beacon_history", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	hiveId: text("hive_id").notNull(),
	hivePubkey: text("hive_pubkey"),
	beacon: jsonb().notNull(),
	capturedAt: timestamp("captured_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("cross_hive_beacon_history_hive_captured_idx").using("btree", table.hiveId.asc().nullsLast().op("text_ops"), table.capturedAt.desc().nullsFirst().op("text_ops")),
	check("cross_hive_beacon_history_hive_id_nonempty", sql`hive_id <> ''::text`),
	primaryKey({ columns: [table.id], name: "cross_hive_beacon_history_pkey"}),

]);

export const cacheL2InHarnessShared = harnessShared.table("cache_l2", {
	workspaceId: text("workspace_id").notNull(),
	cacheKey: text("cache_key").notNull(),
	value: jsonb(),
	tags: text().array().default([""]).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	generation: bigint({ mode: "number" }).default(0).notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("cache_l2_expires_idx").using("btree", table.expiresAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(expires_at IS NOT NULL)`),
	uniqueIndex("cache_l2_key_uniq").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.cacheKey.asc().nullsLast().op("text_ops")),
	index("cache_l2_tags_gin").using("gin", table.tags.asc().nullsLast().op("array_ops")),
	check("cache_l2_workspace_nonempty", sql`workspace_id <> ''::text`),
	check("cache_l2_key_nonempty", sql`cache_key <> ''::text`),
]);

export const operatorSecretsInHarnessShared = harnessShared.table("operator_secrets", {
	name: text().primaryKey().notNull(),
	valueB64: text("value_b64").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	rotatedAt: timestamp("rotated_at", { withTimezone: true, mode: 'string' }),
});

export const spawnSigVerificationFailuresInHarnessShared = harnessShared.table("spawn_sig_verification_failures", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	ts: timestamp({ withTimezone: true }).defaultNow().notNull(),
	reason: text().notNull(),
	claimedRole: text("claimed_role"),
	claimedHarness: text("claimed_harness"),
	claimedWorkspace: text("claimed_workspace"),
	claimedSpawn: text("claimed_spawn"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	expClaim: bigint("exp_claim", { mode: "number" }),
	remoteAddr: text("remote_addr"),
	userAgent: text("user_agent"),
	classification: text(),
}, (table) => [
	index("spawn_sig_failures_classification_idx").using("btree", table.classification.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("timestamptz_ops")).where(sql`(classification IS NOT NULL)`),
	index("spawn_sig_failures_reason_idx").using("btree", table.reason.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("timestamptz_ops")),
	index("spawn_sig_failures_ts_idx").using("btree", table.ts.desc().nullsFirst().op("timestamptz_ops")),
]);

export const autonomyTripwiresInHarnessShared = harnessShared.table("autonomy_tripwires", {
	id: text().primaryKey().notNull(),
	workspaceId: text("workspace_id").default('default').notNull(),
	category: text().notNull(),
	findingClass: text("finding_class").default('unclassified').notNull(),
	action: text(),
	riskTier: text("risk_tier").default('critical').notNull(),
	reversibility: text().default('reversible').notNull(),
	revertHandle: jsonb("revert_handle").notNull(),
	decision: jsonb(),
	status: text().default('armed').notNull(),
	tripReason: text("trip_reason"),
	armedAt: timestamp("armed_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	windowUntil: timestamp("window_until", { withTimezone: true, mode: 'string' }).notNull(),
	resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: 'string' }),
	revertedAt: timestamp("reverted_at", { withTimezone: true, mode: 'string' }),
	resolvedBy: text("resolved_by"),
	decisionId: text("decision_id"),
}, (table) => [
	index("autonomy_tripwires_class_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.category.asc().nullsLast().op("text_ops"), table.findingClass.asc().nullsLast().op("timestamptz_ops"), table.armedAt.asc().nullsLast().op("timestamptz_ops")),
	index("autonomy_tripwires_decision_id_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.decisionId.asc().nullsLast().op("text_ops")).where(sql`(decision_id IS NOT NULL)`),
	index("autonomy_tripwires_sweep_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops"), table.windowUntil.asc().nullsLast().op("timestamptz_ops")),
	check("autonomy_tripwires_risk_tier_check", sql`risk_tier = ANY (ARRAY['trivial'::text, 'low'::text, 'moderate'::text, 'high'::text, 'critical'::text])`),
	check("autonomy_tripwires_reversibility_check", sql`reversibility = 'reversible'::text`),
	check("autonomy_tripwires_status_check", sql`status = ANY (ARRAY['armed'::text, 'cleared'::text, 'tripped'::text, 'reverted'::text])`),
	check("autonomy_tripwires_trip_reason_check", sql`(trip_reason IS NULL) OR (trip_reason = ANY (ARRAY['ekg-drift'::text, 'validator-bounce'::text, 'gym-regression'::text, 'owner-thumbs-down'::text]))`),
]);

export const operatorOpusBudgetPolicyInHarnessShared = harnessShared.table("operator_opus_budget_policy", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().default({}).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_opus_budget_policy_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_opus_budget_policy_pkey"}),

]);

export const hiveDirectoryTombstonesInHarnessShared = harnessShared.table("hive_directory_tombstones", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("hive_directory_tombstones_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "hive_directory_tombstones_pkey"}),

]);

export const operatorOwnerPinsInHarnessShared = harnessShared.table("operator_owner_pins", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().default({}).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_owner_pins_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_owner_pins_pkey"}),

]);

export const operatorAccountOverrideInHarnessShared = harnessShared.table("operator_account_override", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().default({}).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_account_override_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_account_override_pkey"}),

]);

export const routeInvocationsInHarnessShared = harnessShared.table("route_invocations", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	method: text().notNull(),
	path: text().notNull(),
	status: text().notNull(),
	durationMs: integer("duration_ms"),
	principalKind: text("principal_kind"),
	principalAuthMethod: text("principal_auth_method"),
	principalTrust: text("principal_trust"),
	errorMessage: text("error_message"),
	invokedAt: timestamp("invoked_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	resolvedPath: text("resolved_path"),
	responseBytes: integer("response_bytes"),
}, (table) => [
	index("route_invocations_ws_time_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.invokedAt.desc().nullsFirst().op("text_ops")),
	pgPolicy("route_invocations_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const agentModeChangesInHarnessShared = harnessShared.table("agent_mode_changes", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "harness_shared.agent_mode_changes_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id").default('default').notNull(),
	ownerId: text("owner_id").notNull(),
	axisKey: text("axis_key").notNull(),
	oldMode: text("old_mode"),
	newMode: text("new_mode"),
	reason: text().default('').notNull(),
	setBy: text("set_by").notNull(),
	ownerDirected: boolean("owner_directed").default(false).notNull(),
	changedAt: timestamp("changed_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("agent_mode_changes_owner_idx").using("btree", table.workspaceId.asc().nullsLast().op("timestamptz_ops"), table.ownerId.asc().nullsLast().op("text_ops"), table.changedAt.desc().nullsFirst().op("timestamptz_ops")),
]);

export const briefingsInPapercuspShared = papercuspShared.table("briefings", {
	id: text().primaryKey().notNull(),
	title: text().notNull(),
	quarter: text().default('').notNull(),
	status: text().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	scriptPath: text("script_path"),
	durationSeconds: integer("duration_seconds"),
	youtubeUrl: text("youtube_url"),
	youtubeVideoId: text("youtube_video_id"),
	thumbnailUrl: text("thumbnail_url"),
	renderLog: text("render_log"),
	error: text(),
	summary: text(),
}, (table) => [
	index("briefings_quarter_idx").using("btree", table.quarter.asc().nullsLast().op("text_ops")),
	index("briefings_status_idx").using("btree", table.status.asc().nullsLast().op("text_ops")),
]);

export const promptAblationRunsInHarnessShared = harnessShared.table("prompt_ablation_runs", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).notNull(),
	finishedAt: timestamp("finished_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	playbookPath: text("playbook_path").notNull(),
	playbookHash: text("playbook_hash").notNull(),
	ruleKey: text("rule_key").notNull(),
	ruleHash: text("rule_hash").notNull(),
	ruleExcerpt: text("rule_excerpt").notNull(),
	origin: text().default('shadow').notNull(),
	scenarioCount: integer("scenario_count").default(0).notNull(),
	baselinePassRate: doublePrecision("baseline_pass_rate"),
	ablatedPassRate: doublePrecision("ablated_pass_rate"),
	passRateDelta: doublePrecision("pass_rate_delta"),
	verdict: text().notNull(),
	capped: boolean().default(false).notNull(),
	costUsd: doublePrecision("cost_usd").default(0).notNull(),
	ledgerContext: jsonb("ledger_context"),
	detail: jsonb().notNull(),
	replayLeg: jsonb("replay_leg"),
}, (table) => [
	index("prompt_ablation_runs_rule_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.ruleKey.asc().nullsLast().op("text_ops"), table.finishedAt.desc().nullsFirst().op("text_ops")),
	check("prompt_ablation_runs_origin_check", sql`origin = 'shadow'::text`),
	check("prompt_ablation_runs_verdict_check", sql`verdict = ANY (ARRAY['load-bearing'::text, 'no-delta'::text, 'improved'::text, 'inconclusive'::text])`),
	primaryKey({ columns: [table.id], name: "prompt_ablation_runs_pkey"}),

]);

export const directiveSummariesInPapercuspShared = papercuspShared.table("directive_summaries", {
	id: text().primaryKey().notNull(),
	directiveId: text("directive_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).notNull(),
	author: text().default('ceo').notNull(),
	body: text().notNull(),
}, (table) => [
	index("summaries_directive_idx").using("btree", table.directiveId.asc().nullsLast().op("text_ops")),
	index("summaries_ts_idx").using("btree", table.ts.asc().nullsLast().op("int8_ops")),
]);

export const fleetEkgShiftsInHarnessShared = harnessShared.table("fleet_ekg_shifts", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "harness_shared.fleet_ekg_shifts_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id").notNull(),
	windowDate: date("window_date").notNull(),
	feature: text().notNull(),
	kind: text().notNull(),
	score: doublePrecision().notNull(),
	severity: text().notNull(),
	direction: text(),
	windowStart: timestamp("window_start", { withTimezone: true, mode: 'string' }).notNull(),
	windowEnd: timestamp("window_end", { withTimezone: true, mode: 'string' }).notNull(),
	baselineSessions: integer("baseline_sessions").notNull(),
	windowSessions: integer("window_sessions").notNull(),
	baselineSummary: doublePrecision("baseline_summary"),
	windowSummary: doublePrecision("window_summary"),
	attributed: boolean().default(false).notNull(),
	ledgerCandidates: jsonb("ledger_candidates"),
	notifiedAt: timestamp("notified_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("fleet_ekg_shifts_recent_idx").using("btree", table.workspaceId.asc().nullsLast().op("date_ops"), table.windowDate.desc().nullsFirst().op("date_ops")),
	unique("fleet_ekg_shifts_dedup").on(table.workspaceId, table.windowDate, table.feature),
	check("fleet_ekg_shifts_kind_check", sql`kind = ANY (ARRAY['numeric'::text, 'mix'::text, 'bigram'::text])`),
	check("fleet_ekg_shifts_severity_check", sql`severity = ANY (ARRAY['moderate'::text, 'major'::text])`),
]);

export const operatorScalePolicyInHarnessShared = harnessShared.table("operator_scale_policy", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().default({}).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_scale_policy_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_scale_policy_pkey"}),

]);

export const codeRunNudgeFiresInHarnessShared = harnessShared.table("code_run_nudge_fires", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "harness_shared.code_run_nudge_fires_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id").notNull(),
	sessionKey: text("session_key").notNull(),
	role: text().notNull(),
	kind: text().notNull(),
	toolName: text("tool_name").notNull(),
	firedAt: timestamp("fired_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("code_run_nudge_fires_at").using("btree", table.firedAt.asc().nullsLast().op("timestamptz_ops")),
	index("code_run_nudge_fires_session").using("btree", table.sessionKey.asc().nullsLast().op("text_ops"), table.firedAt.asc().nullsLast().op("text_ops")),
	pgPolicy("code_run_nudge_fires_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))` }),
]);

export const learningPackCandidatesInHarnessShared = harnessShared.table("learning_pack_candidates", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	signature: text().notNull(),
	title: text().notNull(),
	draftText: text("draft_text").notNull(),
	kind: text().default('feedback').notNull(),
	appliesTo: jsonb("applies_to").default(["any"]).notNull(),
	scopes: jsonb().default([]).notNull(),
	recurrenceCount: integer("recurrence_count").default(0).notNull(),
	sourceItemIds: jsonb("source_item_ids").default([]).notNull(),
	status: text().default('pending').notNull(),
	createdBy: text("created_by").default('recurrence-escalation').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	decidedAt: timestamp("decided_at", { withTimezone: true, mode: 'string' }),
	decidedBy: text("decided_by"),
	decisionNote: text("decision_note"),
	packId: text("pack_id"),
	packItemId: text("pack_item_id"),
}, (table) => [
	index("learning_pack_candidates_listing_idx").using("btree", table.status.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("text_ops")),
	unique("learning_pack_candidates_signature_uniq").on(table.signature),
	check("learning_pack_candidates_kind_check", sql`kind = ANY (ARRAY['user'::text, 'feedback'::text, 'project'::text, 'reference'::text])`),
	check("learning_pack_candidates_status_check", sql`status = ANY (ARRAY['pending'::text, 'adopted'::text, 'dismissed'::text])`),
	primaryKey({ columns: [table.id], name: "learning_pack_candidates_pkey"}),

]);

export const operatorAutoImplementPolicyInHarnessShared = harnessShared.table("operator_auto_implement_policy", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().default({}).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_auto_implement_policy_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_auto_implement_policy_pkey"}),

]);

export const improvementDispatchesInHarnessShared = harnessShared.table("improvement_dispatches", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	itemId: text("item_id").notNull(),
	attempt: integer().default(1).notNull(),
	runnerHarness: text("runner_harness"),
	firedAt: timestamp("fired_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	fireResult: text("fire_result").default('pending').notNull(),
	fireError: text("fire_error"),
	spawnedRunId: text("spawned_run_id"),
	outcome: text(),
	resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: 'string' }),
	resolvedBy: text("resolved_by"),
	potSlug: text("pot_slug"),
}, (table) => [
	index("improvement_dispatches_open_item_idx").using("btree", table.itemId.asc().nullsLast().op("text_ops")).where(sql`(outcome IS NULL)`),
	index("improvement_dispatches_ws_fired_at_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.firedAt.desc().nullsFirst().op("text_ops")),
	index("improvement_dispatches_ws_pot_fired_at_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.potSlug.asc().nullsLast().op("text_ops"), table.firedAt.desc().nullsFirst().op("text_ops")),
	pgPolicy("improvement_dispatches_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.id], name: "improvement_dispatches_pkey"}),

]);

export const benchmarkPreregInHarnessShared = harnessShared.table("benchmark_prereg", {
	preregHash: text("prereg_hash").primaryKey().notNull(),
	runId: text("run_id").notNull(),
	workspaceId: text("workspace_id").notNull(),
	label: text(),
	suites: jsonb().default([]).notNull(),
	config: jsonb().notNull(),
	filePath: text("file_path").notNull(),
	gitCommitted: boolean("git_committed").default(false).notNull(),
	gitCommitSha: text("git_commit_sha"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("benchmark_prereg_ws_run_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.runId.asc().nullsLast().op("text_ops")),
	unique("benchmark_prereg_workspace_id_run_id_key").on(table.runId, table.workspaceId),
	pgPolicy("benchmark_prereg_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.preregHash], name: "benchmark_prereg_pkey"}),

]);

export const benchmarkRolloutInHarnessShared = harnessShared.table("benchmark_rollout", {
	rolloutId: text("rollout_id").primaryKey().notNull(),
	runId: text("run_id").notNull(),
	workspaceId: text("workspace_id").notNull(),
	preregHash: text("prereg_hash").notNull(),
	suite: text().notNull(),
	taskId: text("task_id").notNull(),
	arm: text().notNull(),
	seed: integer().notNull(),
	configSnapshot: jsonb("config_snapshot"),
	modelId: text("model_id").notNull(),
	modelVersion: text("model_version"),
	harnessVersion: text("harness_version").notNull(),
	harnessGitSha: text("harness_git_sha"),
	envFingerprint: jsonb("env_fingerprint"),
	graderFamily: text("grader_family").notNull(),
	graderVersion: text("grader_version").notNull(),
	graderOutput: jsonb("grader_output"),
	rawGraderOutput: text("raw_grader_output"),
	submission: text(),
	trajectoryRef: text("trajectory_ref"),
	trajectoryKind: text("trajectory_kind"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("benchmark_rollout_ws_run_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.runId.asc().nullsLast().op("text_ops")),
	pgPolicy("benchmark_rollout_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.rolloutId], name: "benchmark_rollout_pkey"}),

]);

export const benchmarkFleetRunInHarnessShared = harnessShared.table("benchmark_fleet_run", {
	fleetRunId: text("fleet_run_id").primaryKey().notNull(),
	runId: text("run_id").notNull(),
	workspaceId: text("workspace_id").notNull(),
	preregHash: text("prereg_hash").notNull(),
	suite: text().notNull(),
	arm: text().notNull(),
	backlogId: text("backlog_id").notNull(),
	seed: integer().notNull(),
	tasks: integer().notNull(),
	resolved: integer().notNull(),
	tasksZeroHumanGate: integer("tasks_zero_human_gate").default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	wallClockMs: bigint("wall_clock_ms", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	tokensTotal: bigint("tokens_total", { mode: "number" }).notNull(),
	costUsd: doublePrecision("cost_usd").notNull(),
	priceTableVersion: text("price_table_version").notNull(),
	peakConcurrency: integer("peak_concurrency"),
	valueCapturedUsd: doublePrecision("value_captured_usd"),
	valueAvailableUsd: doublePrecision("value_available_usd"),
	budgetUsd: doublePrecision("budget_usd"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	budgetTokens: bigint("budget_tokens", { mode: "number" }),
	modelId: text("model_id").notNull(),
	harnessVersion: text("harness_version").notNull(),
	configSnapshot: jsonb("config_snapshot"),
	envFingerprint: jsonb("env_fingerprint"),
	armMeta: jsonb("arm_meta"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("benchmark_fleet_run_ws_run_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.runId.asc().nullsLast().op("text_ops")),
	unique("benchmark_fleet_run_workspace_id_run_id_backlog_id_arm_seed_key").on(table.runId, table.workspaceId, table.arm, table.backlogId, table.seed),
	pgPolicy("benchmark_fleet_run_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.fleetRunId], name: "benchmark_fleet_run_pkey"}),

]);

export const benchmarkRunResultInHarnessShared = harnessShared.table("benchmark_run_result", {
	rolloutId: text("rollout_id").primaryKey().notNull(),
	runId: text("run_id").notNull(),
	workspaceId: text("workspace_id").notNull(),
	suite: text().notNull(),
	modality: text().notNull(),
	taskId: text("task_id").notNull(),
	arm: text().notNull(),
	seed: integer().notNull(),
	resolved: boolean(),
	graderStatus: text("grader_status").notNull(),
	graderFamily: text("grader_family").notNull(),
	graderVersion: text("grader_version").notNull(),
	failToPass: jsonb("fail_to_pass"),
	passToPass: jsonb("pass_to_pass"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	tokensIn: bigint("tokens_in", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	tokensOut: bigint("tokens_out", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	tokensTotal: bigint("tokens_total", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	tokensCacheRead: bigint("tokens_cache_read", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	tokensCacheWrite: bigint("tokens_cache_write", { mode: "number" }),
	costUsd: doublePrecision("cost_usd").notNull(),
	priceTableVersion: text("price_table_version").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	wallClockMs: bigint("wall_clock_ms", { mode: "number" }).notNull(),
	turns: integer().default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	budgetTokens: bigint("budget_tokens", { mode: "number" }),
	capped: boolean().default(false).notNull(),
	generationStatus: text("generation_status").notNull(),
	generationError: text("generation_error"),
	armMeta: jsonb("arm_meta"),
	modelId: text("model_id").notNull(),
	harnessVersion: text("harness_version").notNull(),
	preregHash: text("prereg_hash").notNull(),
	rawGraderOutputRef: text("raw_grader_output_ref"),
	submissionRef: text("submission_ref"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	fleetRunId: text("fleet_run_id"),
	score: doublePrecision(),
}, (table) => [
	index("benchmark_run_result_fleet_run_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.fleetRunId.asc().nullsLast().op("text_ops")),
	index("benchmark_run_result_prereg_idx").using("btree", table.preregHash.asc().nullsLast().op("text_ops")),
	index("benchmark_run_result_ws_run_suite_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.runId.asc().nullsLast().op("text_ops"), table.suite.asc().nullsLast().op("text_ops")),
	index("benchmark_run_result_ws_suite_created_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.suite.asc().nullsLast().op("timestamptz_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	foreignKey({
			columns: [table.rolloutId],
			foreignColumns: [benchmarkRolloutInHarnessShared.rolloutId],
			name: "benchmark_run_result_rollout_id_fkey"
		}).onDelete("cascade"),
	unique("benchmark_run_result_workspace_id_run_id_suite_task_id_arm__key").on(table.runId, table.workspaceId, table.suite, table.taskId, table.arm, table.seed),
	pgPolicy("benchmark_run_result_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("benchmark_run_result_modality_check", sql`modality = ANY (ARRAY['diff'::text, 'in-container'::text])`),
	check("benchmark_run_result_arm_check", sql`arm = ANY (ARRAY['papercusp'::text, 'baseline-a-ablation'::text, 'baseline-b-native'::text, 'baseline-c-bestofn'::text])`),
	check("benchmark_run_result_grader_status_check", sql`grader_status = ANY (ARRAY['passed'::text, 'failed'::text, 'error'::text, 'timeout'::text])`),
	check("benchmark_run_result_generation_status_check", sql`generation_status = ANY (ARRAY['completed'::text, 'error'::text, 'timeout'::text])`),
	primaryKey({ columns: [table.rolloutId], name: "benchmark_run_result_pkey"}),

]);

export const benchmarkCoordEventInHarnessShared = harnessShared.table("benchmark_coord_event", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	eventId: bigint("event_id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity({ name: "harness_shared.benchmark_coord_event_event_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	fleetRunId: text("fleet_run_id").notNull(),
	runId: text("run_id").notNull(),
	workspaceId: text("workspace_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	seq: bigint({ mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }),
	kind: text().notNull(),
	agent: text(),
	taskId: text("task_id"),
	detail: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("benchmark_coord_event_run_seq_idx").using("btree", table.workspaceId.asc().nullsLast().op("int8_ops"), table.fleetRunId.asc().nullsLast().op("int8_ops"), table.seq.asc().nullsLast().op("int8_ops")),
	pgPolicy("benchmark_coord_event_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.eventId], name: "benchmark_coord_event_pkey"}),

]);

export const operatorCoordLivenessConfigInHarnessShared = harnessShared.table("operator_coord_liveness_config", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().default({}).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_coord_liveness_config_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_coord_liveness_config_pkey"}),

]);

export const codeRecipesInHarnessShared = harnessShared.table("code_recipes", {
	id: text().primaryKey().notNull(),
	title: text().notNull(),
	description: text().notNull(),
	script: text().notNull(),
	authorRole: text("author_role"),
	toolsUsed: text("tools_used").array().default([""]).notNull(),
	runCount: integer("run_count").default(0).notNull(),
	successCount: integer("success_count").default(0).notNull(),
	lastRunAt: timestamp("last_run_at", { withTimezone: true, mode: 'string' }),
	status: text().default('active').notNull(),
	promotedTool: text("promoted_tool"),
	mergedInto: text("merged_into"),
	tags: text().array().default([""]).notNull(),
	embedding: vector({ dimensions: 384 }),
	titleTsv: tsvectorCustom("title_tsv").generatedAlwaysAs(sql`to_tsvector('english'::regconfig, ((COALESCE(title, ''::text) || ' '::text) || COALESCE(description, ''::text)))`),
	createdBy: text("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("code_recipes_title_tsv_idx").using("gin", table.titleTsv.asc().nullsLast().op("tsvector_ops")),
]);

export const codeRecipeRunsInHarnessShared = harnessShared.table("code_recipe_runs", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "harness_shared.code_recipe_runs_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	recipeId: text("recipe_id").notNull(),
	workspaceId: text("workspace_id").notNull(),
	agentOwner: text("agent_owner"),
	agentRole: text("agent_role"),
	success: boolean().default(true).notNull(),
	reused: boolean().default(false).notNull(),
	ts: timestamp({ withTimezone: true }).defaultNow().notNull(),
	potSlug: text("pot_slug"),
}, (table) => [
	index("code_recipe_runs_recipe_idx").using("btree", table.recipeId.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("text_ops")),
	index("code_recipe_runs_ws_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("text_ops")),
	pgPolicy("code_recipe_runs_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const operatorHiveControlPolicyInHarnessShared = harnessShared.table("operator_hive_control_policy", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().default({}).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_hive_control_policy_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_hive_control_policy_pkey"}),

]);

export const operatorReleaseCheckpointConfigInHarnessShared = harnessShared.table("operator_release_checkpoint_config", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().default({}).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_release_checkpoint_config_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_release_checkpoint_config_pkey"}),

]);

export const agentSeatConsumptionsInHarnessShared = harnessShared.table("agent_seat_consumptions", {
	ownerId: text("owner_id").primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	fleetSlug: text("fleet_slug").notNull(),
	seatRef: text("seat_ref").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("agent_seat_consumptions_fleet_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.fleetSlug.asc().nullsLast().op("text_ops"), table.seatRef.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.ownerId], name: "agent_seat_consumptions_pkey"}),

]);

export const operatorCapabilityEnvelopesInHarnessShared = harnessShared.table("operator_capability_envelopes", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().default({}).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_capability_envelopes_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_capability_envelopes_pkey"}),

]);

export const modelPricingInHarnessShared = harnessShared.table("model_pricing", {
	modelId: text("model_id").primaryKey().notNull(),
	inputPerMtok: numeric("input_per_mtok").notNull(),
	outputPerMtok: numeric("output_per_mtok").notNull(),
	cacheReadPerMtok: numeric("cache_read_per_mtok").notNull(),
	cacheCreationPerMtok: numeric("cache_creation_per_mtok").notNull(),
	effectiveDate: date("effective_date").default(sql`CURRENT_DATE`).notNull(),
	source: text().default('code-table').notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.modelId], name: "model_pricing_pkey"}),
]);

export const benchRunEventsInHarnessShared = harnessShared.table("bench_run_events", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	eventId: bigint("event_id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity({ name: "harness_shared.bench_run_events_event_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	runId: text("run_id").notNull(),
	workspaceId: text("workspace_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	seq: bigint({ mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }),
	kind: text().notNull(),
	agent: text(),
	taskId: text("task_id"),
	payload: jsonb(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("bench_run_events_ws_run_seq_idx").using("btree", table.workspaceId.asc().nullsLast().op("int8_ops"), table.runId.asc().nullsLast().op("int8_ops"), table.seq.asc().nullsLast().op("int8_ops")),
	foreignKey({
			columns: [table.runId],
			foreignColumns: [benchRunsInHarnessShared.id],
			name: "bench_run_events_run_id_fkey"
		}).onDelete("cascade"),
	pgPolicy("bench_run_events_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.eventId], name: "bench_run_events_pkey"}),

]);

export const benchRunsInHarnessShared = harnessShared.table("bench_runs", {
	id: text().primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	arm: text().notNull(),
	taskSetId: text("task_set_id").notNull(),
	suite: text().default('swe-bench-pro').notNull(),
	model: text().notNull(),
	status: text().default('pending').notNull(),
	source: text().default('ui').notNull(),
	summary: jsonb(),
	taskCount: integer("task_count"),
	gradedCount: integer("graded_count"),
	resolvedCount: integer("resolved_count"),
	nonEmptyDiffs: integer("non_empty_diffs"),
	costUsd: doublePrecision("cost_usd"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	tokensIn: bigint("tokens_in", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	tokensOut: bigint("tokens_out", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	wallMs: bigint("wall_ms", { mode: "number" }),
	peakConcurrentBees: integer("peak_concurrent_bees"),
	recovered: boolean().default(false).notNull(),
	runError: text("run_error"),
	config: jsonb(),
	fleetRunId: text("fleet_run_id"),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }),
	finishedAt: timestamp("finished_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	infraExcluded: integer("infra_excluded"),
	potSlug: text("pot_slug"),
}, (table) => [
	index("bench_runs_ws_arm_taskset_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.arm.asc().nullsLast().op("text_ops"), table.taskSetId.asc().nullsLast().op("text_ops")),
	index("bench_runs_ws_created_idx").using("btree", table.workspaceId.asc().nullsLast().op("timestamptz_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	index("bench_runs_ws_status_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")),
	pgPolicy("bench_runs_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("bench_runs_status_check", sql`status = ANY (ARRAY['pending'::text, 'running'::text, 'grading'::text, 'done'::text, 'error'::text, 'cancelled'::text])`),
	check("bench_runs_source_check", sql`source = ANY (ARRAY['ui'::text, 'cli'::text, 'import'::text])`),
]);

export const sentinelSaysInHarnessShared = harnessShared.table("sentinel_says", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	line: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export const agentFactsInHarnessShared = harnessShared.table("agent_facts", {
	workspaceId: text("workspace_id").notNull(),
	scope: text().notNull(),
	scopeRef: text("scope_ref"),
	key: text().notNull(),
	body: text().notNull(),
	sourceRef: text("source_ref"),
	createdBy: text("created_by").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	retractedAt: timestamp("retracted_at", { withTimezone: true, mode: 'string' }),
	shareable: boolean().default(false).notNull(),
	harnessSlug: text("harness_slug"),
	authorPubkey: text("author_pubkey"),
	origin: text().default('local').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	sourceHive: text("source_hive"),
	fedKey: text("fed_key").generatedAlwaysAs(sql`((((scope || '/'::text) || COALESCE(scope_ref, ''::text)) || '/'::text) || key)`),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "harness_shared.agent_facts_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
}, (table) => [
	index("agent_facts_fold").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.scope.asc().nullsLast().op("text_ops"), table.scopeRef.asc().nullsLast().op("text_ops"), table.expiresAt.asc().nullsLast().op("text_ops")).where(sql`(retracted_at IS NULL)`),
	uniqueIndex("agent_facts_identity").using("btree", sql`workspace_id`, sql`scope`, sql`COALESCE(scope_ref, ''::text)`, sql`key`, sql`COALESCE(source_hive, ''::text)`),
	index("agent_facts_shareable").using("btree", table.workspaceId.asc().nullsLast().op("timestamptz_ops"), table.scope.asc().nullsLast().op("timestamptz_ops"), table.expiresAt.asc().nullsLast().op("timestamptz_ops")).where(sql`((shareable = true) AND (retracted_at IS NULL))`),
	pgPolicy("agent_facts_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("agent_facts_scope_check", sql`scope = ANY (ARRAY['workspace'::text, 'role'::text, 'owner'::text, 'harness'::text, 'work_item'::text])`),
	check("agent_facts_body_check", sql`char_length(body) <= 500`),
	check("agent_facts_check", sql`(scope = 'workspace'::text) OR (scope_ref IS NOT NULL)`),
]);

export const operatorMigratePolicyInHarnessShared = harnessShared.table("operator_migrate_policy", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().default({}).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_migrate_policy_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_migrate_policy_pkey"}),

]);

export const operatorTelemetryBufferConfigInHarnessShared = harnessShared.table("operator_telemetry_buffer_config", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().default({}).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_telemetry_buffer_config_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_telemetry_buffer_config_pkey"}),

]);

export const sessionBriefsInHarnessShared = harnessShared.table("session_briefs", {
	ownerId: text("owner_id").primaryKey().notNull(),
	workspaceId: text("workspace_id").default('default').notNull(),
	ownerLabel: text("owner_label").default('').notNull(),
	source: text().default('').notNull(),
	intent: text().default('').notNull(),
	currentPlanSlug: text("current_plan_slug"),
	currentFiles: jsonb("current_files").default([]).notNull(),
	harnessSlug: text("harness_slug"),
	nativeSessionId: text("native_session_id"),
	firstSeenAt: timestamp("first_seen_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	potSlug: text("pot_slug"),
}, (table) => [
	index("session_briefs_native_session_id_idx").using("btree", table.nativeSessionId.asc().nullsLast().op("text_ops")).where(sql`(native_session_id IS NOT NULL)`),
	index("session_briefs_updated_at_idx").using("btree", table.updatedAt.asc().nullsLast().op("timestamptz_ops")),
	primaryKey({ columns: [table.ownerId], name: "session_briefs_pkey"}),

]);

export const operatorScoutBudgetInHarnessShared = harnessShared.table("operator_scout_budget", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().default({}).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_scout_budget_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_scout_budget_pkey"}),

]);

export const operatorQuotaOverridesInHarnessShared = harnessShared.table("operator_quota_overrides", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().default({}).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_quota_overrides_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_quota_overrides_pkey"}),

]);

export const fleetMembershipEventsInHarnessShared = harnessShared.table("fleet_membership_events", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "harness_shared.fleet_membership_events_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id").default('default').notNull(),
	ownerId: text("owner_id").notNull(),
	ownerLabel: text("owner_label"),
	fleetSlug: text("fleet_slug"),
	fleetRole: text("fleet_role"),
	event: text().default('join').notNull(),
	at: timestamp({ withTimezone: true }).defaultNow().notNull(),
}, (table) => [
	index("fleet_membership_events_fleet_idx").using("btree", table.workspaceId.asc().nullsLast().op("int8_ops"), table.fleetSlug.asc().nullsLast().op("text_ops"), table.id.desc().nullsFirst().op("text_ops")).where(sql`(fleet_slug IS NOT NULL)`),
	index("fleet_membership_events_owner_idx").using("btree", table.workspaceId.asc().nullsLast().op("int8_ops"), table.ownerId.asc().nullsLast().op("text_ops"), table.id.desc().nullsFirst().op("text_ops")),
]);

export const memoryRecallStatsInHarnessShared = harnessShared.table("memory_recall_stats", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "harness_shared.memory_recall_stats_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	surface: text().notNull(),
	hitCount: integer("hit_count").notNull(),
	topScore: doublePrecision("top_score"),
	scores: jsonb().default([]).notNull(),
	fragmentCount: integer("fragment_count").default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	workspaceId: text("workspace_id"),
	potSlug: text("pot_slug"),
}, (table) => [
	index("memory_recall_stats_created_idx").using("btree", table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	index("memory_recall_stats_ws_pot_created_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.potSlug.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("text_ops")),
	check("memory_recall_stats_surface_check", sql`surface = ANY (ARRAY['search'::text, 'injection'::text])`),
	check("memory_recall_stats_hit_count_check", sql`hit_count >= 0`),
]);

export const crossHiveAsksInHarnessShared = harnessShared.table("cross_hive_asks", {
	workspaceId: text("workspace_id").notNull(),
	id: uuid().defaultRandom().primaryKey().notNull(),
	peerPubkey: text("peer_pubkey").notNull(),
	direction: text().default('out').notNull(),
	kind: text().notNull(),
	subject: text().default('').notNull(),
	body: text().default('').notNull(),
	correlationId: text("correlation_id").notNull(),
	state: text().default('queued').notNull(),
	replyBody: text("reply_body"),
	replyTs: timestamp("reply_ts", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	askedBy: text("asked_by"),
	potSlug: text("pot_slug").notNull(),
}, (table) => [
	index("cross_hive_asks_listing_pot_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.potSlug.asc().nullsLast().op("timestamptz_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	unique("cross_hive_asks_correlation_pot_uniq").on(table.workspaceId, table.correlationId, table.potSlug),
	check("cross_hive_asks_workspace_nonempty", sql`workspace_id <> ''::text`),
	check("cross_hive_asks_direction_check", sql`direction = ANY (ARRAY['out'::text, 'in'::text])`),
	check("cross_hive_asks_kind_check", sql`kind = ANY (ARRAY['ask'::text, 'work-request'::text])`),
	check("cross_hive_asks_state_check", sql`state = ANY (ARRAY['queued'::text, 'sent'::text, 'answered'::text, 'declined'::text, 'expired'::text])`),
	primaryKey({ columns: [table.id], name: "cross_hive_asks_pkey"}),

]);

export const scoutTicksInHarnessShared = harnessShared.table("scout_ticks", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "harness_shared.scout_ticks_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id").notNull(),
	installSlug: text("install_slug"),
	tickAt: timestamp("tick_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	status: text().default('ran').notNull(),
	gate: text(),
	ideasGenerated: integer("ideas_generated").default(0).notNull(),
	ideasRouted: integer("ideas_routed").default(0).notNull(),
	ideasDeduped: integer("ideas_deduped").default(0).notNull(),
	budgetUsedUsd: numeric("budget_used_usd"),
	detail: jsonb(),
	potSlug: text("pot_slug"),
}, (table) => [
	index("scout_ticks_ws_pot_tick_at_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.potSlug.asc().nullsLast().op("text_ops"), table.tickAt.desc().nullsFirst().op("text_ops")),
	index("scout_ticks_ws_tick_at_idx").using("btree", table.workspaceId.asc().nullsLast().op("timestamptz_ops"), table.tickAt.desc().nullsFirst().op("timestamptz_ops")),
	pgPolicy("scout_ticks_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const memoryFeedbackInHarnessShared = harnessShared.table("memory_feedback", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	memId: text("mem_id").notNull(),
	userId: uuid("user_id").notNull(),
	workspaceId: text("workspace_id").notNull(),
	action: text().notNull(),
	kind: text(),
	priorText: text("prior_text"),
	newText: text("new_text"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	potSlug: text("pot_slug"),
}, (table) => [
	index("memory_feedback_action_created_idx").using("btree", table.action.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	index("memory_feedback_mem_idx").using("btree", table.memId.asc().nullsLast().op("text_ops")),
	index("memory_feedback_user_idx").using("btree", table.userId.asc().nullsLast().op("uuid_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	index("memory_feedback_ws_pot_created_idx").using("btree", table.workspaceId.asc().nullsLast().op("timestamptz_ops"), table.potSlug.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("text_ops")),
	pgPolicy("memory_feedback_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("memory_feedback_action_check", sql`action = ANY (ARRAY['edit'::text, 'delete'::text, 'forget_all'::text])`),
	primaryKey({ columns: [table.id], name: "memory_feedback_pkey"}),

]);

export const calibrationPredictionsInHarnessShared = harnessShared.table("calibration_predictions", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity({ name: "harness_shared.calibration_predictions_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id").notNull(),
	predictor: text().notNull(),
	domain: text().notNull(),
	subjectKind: text("subject_kind").notNull(),
	subjectId: text("subject_id").notNull(),
	claim: text().notNull(),
	probability: doublePrecision().notNull(),
	stated: boolean().default(false).notNull(),
	signalOrigin: text("signal_origin").default('organic').notNull(),
	watchdogKey: text("watchdog_key"),
	horizonTs: timestamp("horizon_ts", { withTimezone: true, mode: 'string' }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: 'string' }),
	outcome: boolean(),
	resolutionNote: text("resolution_note"),
	potSlug: text("pot_slug"),
}, (table) => [
	index("calibration_predictions_matured_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.horizonTs.asc().nullsLast().op("timestamptz_ops")).where(sql`(resolved_at IS NULL)`),
	uniqueIndex("calibration_predictions_open_bet_uq").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.predictor.asc().nullsLast().op("text_ops"), table.domain.asc().nullsLast().op("text_ops"), table.subjectKind.asc().nullsLast().op("text_ops"), table.subjectId.asc().nullsLast().op("text_ops")).where(sql`(resolved_at IS NULL)`),
	index("calibration_predictions_scores_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.predictor.asc().nullsLast().op("text_ops"), table.domain.asc().nullsLast().op("text_ops")),
	index("calibration_predictions_subject_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.subjectKind.asc().nullsLast().op("text_ops"), table.subjectId.asc().nullsLast().op("text_ops")),
	index("calibration_predictions_ws_pot_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.potSlug.asc().nullsLast().op("text_ops")),
	check("calibration_predictions_ws_nonempty", sql`workspace_id <> ''::text`),
	check("calibration_predictions_predictor_nonempty", sql`predictor <> ''::text`),
	check("calibration_predictions_probability_range", sql`(probability >= (0)::double precision) AND (probability <= (1)::double precision)`),
	check("calibration_predictions_origin_vocab", sql`signal_origin = ANY (ARRAY['organic'::text, 'drill'::text, 'replay'::text, 'shadow'::text])`),
	check("calibration_predictions_outcome_resolved", sql`(outcome IS NULL) OR (resolved_at IS NOT NULL)`),
]);

export const gitSyncCommitAttributionInHarnessShared = harnessShared.table("git_sync_commit_attribution", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "harness_shared.git_sync_commit_attribution_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	repo: text().notNull(),
	commitSha: text("commit_sha").notNull(),
	file: text().notNull(),
	agentId: text("agent_id"),
	sessionId: text("session_id"),
	contributor: text(),
	workItemId: text("work_item_id"),
	planSlug: text("plan_slug"),
	ts: timestamp({ withTimezone: true }).defaultNow().notNull(),
}, (table) => [
	index("git_sync_commit_attr_repo_file_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.repo.asc().nullsLast().op("timestamptz_ops"), table.file.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("text_ops")),
	index("git_sync_commit_attr_sha_idx").using("btree", table.commitSha.asc().nullsLast().op("text_ops")),
	index("git_sync_commit_attr_work_item_idx").using("btree", table.workItemId.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("text_ops")).where(sql`(work_item_id IS NOT NULL)`),
]);

export const editAttributionLedgerInHarnessShared = harnessShared.table("edit_attribution_ledger", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "harness_shared.edit_attribution_ledger_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id"),
	harnessSlug: text("harness_slug"),
	repo: text(),
	file: text().notNull(),
	agentId: text("agent_id").notNull(),
	sessionId: text("session_id"),
	contributor: text(),
	workItemId: text("work_item_id"),
	planSlug: text("plan_slug"),
	intent: text(),
	ts: timestamp({ withTimezone: true }).defaultNow().notNull(),
	repoRoot: text("repo_root"),
}, (table) => [
	index("edit_attribution_ledger_repo_file_idx").using("btree", table.repoRoot.asc().nullsLast().op("text_ops"), table.file.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("text_ops")),
	index("edit_attribution_ledger_work_item_idx").using("btree", table.workItemId.asc().nullsLast().op("timestamptz_ops"), table.ts.desc().nullsFirst().op("timestamptz_ops")).where(sql`(work_item_id IS NOT NULL)`),
]);

export const agentRateBudgetInHarnessShared = harnessShared.table("agent_rate_budget", {
	bucketKey: text("bucket_key").primaryKey().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	windowStart: bigint("window_start", { mode: "number" }).default(0).notNull(),
	reqInWindow: integer("req_in_window").default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	inTokInWindow: bigint("in_tok_in_window", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	outTokInWindow: bigint("out_tok_in_window", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	pausedUntil: bigint("paused_until", { mode: "number" }).default(0).notNull(),
	paceDelayMs: integer("pace_delay_ms").default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	lastAcquireAt: bigint("last_acquire_at", { mode: "number" }).default(0).notNull(),
	limits: jsonb().default({}).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
	rpmFactor: doublePrecision("rpm_factor"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	rpmFactorAt: bigint("rpm_factor_at", { mode: "number" }),
}, (table) => [
	primaryKey({ columns: [table.bucketKey], name: "agent_rate_budget_pkey"}),
]);

export const operatorIntegrationCredentialsInHarnessShared = harnessShared.table("operator_integration_credentials", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().default({}).notNull(),
	payloadCt: byteaCustom("payload_ct"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(sql`(EXTRACT(epoch FROM now()) * 1000)::bigint`).notNull(),
}, (table) => [
	pgPolicy("oic_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_integration_credentials_pkey"}),

]);

export const directivesInPapercuspShared = papercuspShared.table("directives", {
	id: text().primaryKey().notNull(),
	title: text().notNull(),
	body: text().notNull(),
	status: text().notNull(),
	createdBy: text("created_by").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdTs: bigint("created_ts", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	deadlineTs: bigint("deadline_ts", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	budgetCents: bigint("budget_cents", { mode: "number" }),
	priority: text(),
	assignedDepartments: jsonb("assigned_departments").default([]).notNull(),
	linkedProjectIds: jsonb("linked_project_ids").default([]).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedTs: bigint("updated_ts", { mode: "number" }).notNull(),
}, (table) => [
	index("directives_created_idx").using("btree", table.createdTs.desc().nullsFirst().op("int8_ops")),
	index("directives_status_idx").using("btree", table.status.asc().nullsLast().op("text_ops")),
]);

export const userActionsInHarnessShared = harnessShared.table("user_actions", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	harnessSlug: text("harness_slug").notNull(),
	kind: text().notNull(),
	status: text().notNull(),
	summary: text(),
	detailUrl: text("detail_url"),
	errorText: text("error_text"),
	invocationId: text("invocation_id"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	startedAt: bigint("started_at", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	finishedAt: bigint("finished_at", { mode: "number" }),
	actor: text(),
	workspaceId: text("workspace_id").default('').notNull(),
}, (table) => [
	index("user_actions_running_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops")).where(sql`(status = 'running'::text)`),
	index("user_actions_slug_started_idx").using("btree", table.harnessSlug.asc().nullsLast().op("int8_ops"), table.startedAt.desc().nullsFirst().op("int8_ops")),
	index("user_actions_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	pgPolicy("user_actions_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const elConvCallsInHarnessShared = harnessShared.table("el_conv_calls", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	ts: timestamp({ withTimezone: true }).defaultNow().notNull(),
	conversationId: text("conversation_id").notNull(),
	agentId: text("agent_id"),
	workspace: text(),
	durationSecs: integer("duration_secs").default(0).notNull(),
	ym: text().default(sql`to_char(now(), 'YYYY-MM'::text)`).notNull(),
}, (table) => [
	index("el_conv_calls_ym_idx").using("btree", table.ym.asc().nullsLast().op("text_ops")),
	unique("el_conv_calls_conversation_id_key").on(table.conversationId),
]);

export const agentActionsInHarnessShared = harnessShared.table("agent_actions", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	ts: timestamp({ withTimezone: true }).defaultNow().notNull(),
	agent: text().notNull(),
	commandId: text("command_id").notNull(),
	args: jsonb().default({}).notNull(),
	status: text().notNull(),
	errorCode: text("error_code"),
	durationMs: integer("duration_ms"),
	sessionId: text("session_id"),
	requestId: text("request_id"),
	workspaceId: text("workspace_id"),
}, (table) => [
	index("agent_actions_agent_ts_idx").using("btree", table.agent.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("text_ops")),
	index("agent_actions_id_ts_idx").using("btree", table.commandId.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("timestamptz_ops")),
	index("agent_actions_ts_idx").using("btree", table.ts.desc().nullsFirst().op("timestamptz_ops")),
]);

export const agentQueriesInHarnessShared = harnessShared.table("agent_queries", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	ts: timestamp({ withTimezone: true }).defaultNow().notNull(),
	agent: text().notNull(),
	queryId: text("query_id").notNull(),
	argsCompact: jsonb("args_compact"),
	requestId: text("request_id"),
	workspaceId: text("workspace_id"),
}, (table) => [
	index("agent_queries_agent_id_ts").using("btree", table.agent.asc().nullsLast().op("text_ops"), table.queryId.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("timestamptz_ops")),
	index("agent_queries_ts_idx").using("btree", table.ts.desc().nullsFirst().op("timestamptz_ops")),
]);

export const goalsInHarnessShared = harnessShared.table("goals", {
	id: text().primaryKey().notNull(),
	installSlug: text("install_slug").notNull(),
	title: text().notNull(),
	body: text(),
	parentId: text("parent_id"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	budgetCents: bigint("budget_cents", { mode: "number" }),
	status: text().default('active').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	metadata: jsonb(),
	workspaceId: text("workspace_id").notNull(),
	search: tsvectorCustom("_search").generatedAlwaysAs(sql`(setweight(to_tsvector('english'::regconfig, COALESCE(title, ''::text)), 'A'::"char") || setweight(to_tsvector('english'::regconfig, COALESCE(body, ''::text)), 'B'::"char"))`),
}, (table) => [
	index("goals_install_idx").using("btree", table.installSlug.asc().nullsLast().op("text_ops")),
	index("goals_parent_idx").using("btree", table.parentId.asc().nullsLast().op("text_ops")),
	index("goals_search_idx").using("gin", table.search.asc().nullsLast().op("tsvector_ops")),
	index("goals_status_idx").using("btree", table.status.asc().nullsLast().op("text_ops")),
	index("goals_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.parentId],
			foreignColumns: [table.id],
			name: "goals_parent_id_fkey"
		}).onDelete("set null"),
	pgPolicy("goals_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("goals_workspace_nonempty", sql`workspace_id <> ''::text`),
]);

export const operatorBudgetInHarnessShared = harnessShared.table("operator_budget", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_budget_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_budget_pkey"}),

]);

export const operatorCredentialsInHarnessShared = harnessShared.table("operator_credentials", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
	payloadCt: byteaCustom("payload_ct"),
}, (table) => [
	pgPolicy("operator_credentials_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_credentials_pkey"}),

]);

export const operatorPublishCredentialsInHarnessShared = harnessShared.table("operator_publish_credentials", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
	payloadCt: byteaCustom("payload_ct"),
}, (table) => [
	pgPolicy("operator_publish_credentials_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_publish_credentials_pkey"}),

]);

export const operatorMarketplaceTokenInHarnessShared = harnessShared.table("operator_marketplace_token", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
	payloadCt: byteaCustom("payload_ct"),
}, (table) => [
	pgPolicy("operator_marketplace_token_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_marketplace_token_pkey"}),

]);

export const operatorVoiceCredentialsInHarnessShared = harnessShared.table("operator_voice_credentials", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
	payloadCt: byteaCustom("payload_ct"),
}, (table) => [
	pgPolicy("operator_voice_credentials_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_voice_credentials_pkey"}),

]);

export const operatorStandingCandidatesInHarnessShared = harnessShared.table("operator_standing_candidates", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_standing_candidates_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_standing_candidates_pkey"}),

]);

export const operatorAgentConfigInHarnessShared = harnessShared.table("operator_agent_config", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_agent_config_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_agent_config_pkey"}),

]);

export const operatorSttSpendInHarnessShared = harnessShared.table("operator_stt_spend", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_stt_spend_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_stt_spend_pkey"}),

]);

export const operatorTtsSpendInHarnessShared = harnessShared.table("operator_tts_spend", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_tts_spend_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_tts_spend_pkey"}),

]);

export const operatorVoicePrefsInHarnessShared = harnessShared.table("operator_voice_prefs", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	pgPolicy("operator_voice_prefs_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_voice_prefs_pkey"}),

]);

export const harnessSmokeTestInHarnessShared = harnessShared.table("harness_smoke_test", {
	harnessSlug: text("harness_slug").primaryKey().notNull(),
	status: text().default('unknown').notNull(),
	passContent: text("pass_content"),
	failureContent: text("failure_content"),
	results: jsonb(),
	startupLog: text("startup_log"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	mtimeMs: bigint("mtime_ms", { mode: "number" }).default(0).notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
}, (table) => [
	pgPolicy("harness_smoke_test_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.harnessSlug], name: "harness_smoke_test_pkey"}),

]);

export const periodicSweepRunsInHarnessShared = harnessShared.table("periodic_sweep_runs", {
	sweepName: text("sweep_name").primaryKey().notNull(),
	lastRunAt: timestamp("last_run_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lastReleased: integer("last_released").default(0).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	workspaceId: text("workspace_id").notNull(),
}, (table) => [
	index("periodic_sweep_runs_workspace_id_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.sweepName], name: "periodic_sweep_runs_pkey"}),

]);

export const projectsInHarnessShared = harnessShared.table("projects", {
	id: text().primaryKey().notNull(),
	name: text().notNull(),
	status: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	budgetCents: bigint("budget_cents", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	spentCents: bigint("spent_cents", { mode: "number" }).default(0).notNull(),
	owningDept: text("owning_dept"),
	vertical: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdTs: bigint("created_ts", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedTs: bigint("updated_ts", { mode: "number" }).notNull(),
	metadata: jsonb(),
	spec: text(),
	specUpdatedAt: timestamp("spec_updated_at", { withTimezone: true, mode: 'string' }),
	specManuallyEditedAt: timestamp("spec_manually_edited_at", { withTimezone: true, mode: 'string' }),
	slug: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	costCapCents: bigint("cost_cap_cents", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	earnedCents: bigint("earned_cents", { mode: "number" }).default(0).notNull(),
	parentSlug: text("parent_slug"),
	workspaceId: text("workspace_id").notNull(),
	search: tsvectorCustom("_search").generatedAlwaysAs(sql`(setweight(to_tsvector('english'::regconfig, COALESCE(name, ''::text)), 'A'::"char") || setweight(to_tsvector('english'::regconfig, COALESCE(slug, ''::text)), 'B'::"char"))`),
	ephemeral: boolean().default(false).notNull(),
}, (table) => [
	index("projects_ephemeral_idx").using("btree", table.slug.asc().nullsLast().op("text_ops")).where(sql`(ephemeral = true)`),
	index("projects_parent_idx").using("btree", table.parentSlug.asc().nullsLast().op("text_ops")),
	index("projects_search_idx").using("gin", table.search.asc().nullsLast().op("tsvector_ops")),
	index("projects_status_idx").using("btree", table.status.asc().nullsLast().op("text_ops")),
	index("projects_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	uniqueIndex("projects_ws_slug_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.slug.asc().nullsLast().op("text_ops")),
	pgPolicy("projects_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("projects_workspace_nonempty", sql`workspace_id <> ''::text`),
]);

export const memoryCanonicalInHarnessShared = harnessShared.table("memory_canonical", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	payload: jsonb().default({}).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lastValidatedAt: timestamp("last_validated_at", { withTimezone: true, mode: 'string' }),
	lastSurfacedAt: timestamp("last_surfaced_at", { withTimezone: true, mode: 'string' }),
	state: text().default('active').notNull(),
	userId: text("user_id").generatedAlwaysAs(sql`(payload ->> 'user_id'::text)`),
	workspaceId: text("workspace_id").generatedAlwaysAs(sql`(payload ->> 'workspace_id'::text)`),
}, (table) => [
	index("memory_canonical_recently_surfaced_idx").using("btree", table.lastSurfacedAt.desc().nullsLast().op("timestamptz_ops")).where(sql`(last_surfaced_at IS NOT NULL)`),
	index("memory_canonical_state_idx").using("btree", table.state.asc().nullsLast().op("text_ops")).where(sql`(state <> 'active'::text)`),
	index("memory_canonical_user_id_col_idx").using("btree", table.userId.asc().nullsLast().op("text_ops")),
	index("memory_canonical_user_id_idx").using("btree", sql`((payload ->> 'user_id'::text))`),
	index("memory_canonical_workspace_id_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	index("memory_canonical_ws_user_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.userId.asc().nullsLast().op("text_ops")),
	check("memory_canonical_state_check", sql`state = ANY (ARRAY['active'::text, 'broken_anchor'::text, 'superseded'::text, 'contradicted'::text, 'forgotten'::text, 'archived'::text])`),
	primaryKey({ columns: [table.id], name: "memory_canonical_pkey"}),

]);

export const eiPermigDefault20260618InHarnessShared = harnessShared.table("_ei_permig_default_20260618", {
	issueId: text("issue_id"),
});

export const memoryPrecisionBenchInHarnessShared = harnessShared.table("memory_precision_bench", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	ranAt: timestamp("ran_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	backend: text().default('hybrid').notNull(),
	corpusVersion: text("corpus_version").notNull(),
	goldVersion: text("gold_version").notNull(),
	corpusN: integer("corpus_n").default(0).notNull(),
	goldN: integer("gold_n").default(0).notNull(),
	floorCosine: doublePrecision("floor_cosine").notNull(),
	floorLex: doublePrecision("floor_lex").notNull(),
	fpAt5: doublePrecision("fp_at_5"),
	rAt10: doublePrecision("r_at_10"),
	pAt5: doublePrecision("p_at_5"),
	mrr: doublePrecision(),
	medianTopScore: doublePrecision("median_top_score"),
	latencyP50Ms: doublePrecision("latency_p50_ms"),
	byClass: jsonb("by_class"),
	costUsd: doublePrecision("cost_usd"),
	notes: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("memory_precision_bench_ws_ran_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.ranAt.desc().nullsFirst().op("text_ops")),
	pgPolicy("memory_precision_bench_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const hlcClockInHarnessShared = harnessShared.table("hlc_clock", {
	id: smallint().default(1).primaryKey().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	lastMs: bigint("last_ms", { mode: "number" }).default(0).notNull(),
	lastCount: integer("last_count").default(0).notNull(),
	nodeId: text("node_id"),
}, (table) => [
	check("hlc_clock_singleton", sql`id = 1`),
	primaryKey({ columns: [table.id], name: "hlc_clock_pkey"}),

]);

export const messageRecipientsInPapercuspShared = papercuspShared.table("message_recipients", {
	messageId: text("message_id").notNull(),
	deptSlug: text("dept_slug").notNull(),
}, (table) => [
	index("recipients_dept_idx").using("btree", table.deptSlug.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.messageId],
			foreignColumns: [messagesInPapercuspShared.id],
			name: "message_recipients_message_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.messageId, table.deptSlug], name: "message_recipients_pkey"}),
]);

export const knownSchemaVersionsInHarnessShared = harnessShared.table("known_schema_versions", {
	workspaceId: text("workspace_id").default('').notNull(),
	harnessSlug: text("harness_slug").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	maxKnownVersion: bigint("max_known_version", { mode: "number" }).default(1).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspaceId, table.harnessSlug], name: "known_schema_versions_pkey"}),
	pgPolicy("known_schema_versions_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const insightsFirstVisitInHarnessShared = harnessShared.table("insights_first_visit", {
	workspaceId: text("workspace_id").default('').notNull(),
	harnessSlug: text("harness_slug").notNull(),
	userId: text("user_id").notNull(),
	seenAtTs: timestamp("seen_at_ts", { withTimezone: true, mode: 'string' }),
}, (table) => [
	primaryKey({ columns: [table.workspaceId, table.harnessSlug, table.userId], name: "insights_first_visit_pkey"}),
	pgPolicy("insights_first_visit_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const userTrustListInHarnessShared = harnessShared.table("user_trust_list", {
	workspaceId: text("workspace_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	trustedGithubUserId: bigint("trusted_github_user_id", { mode: "number" }).notNull(),
	note: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdTs: bigint("created_ts", { mode: "number" }).notNull(),
}, (table) => [
	index("user_trust_list_ws_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.workspaceId, table.trustedGithubUserId], name: "user_trust_list_pkey"}),
	pgPolicy("user_trust_list_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const substrateMetaInHarnessShared = harnessShared.table("substrate_meta", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	key: text().notNull(),
	value: text().notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspaceId, table.harnessSlug, table.key], name: "substrate_meta_pkey"}),
]);

export const tuiViewStateInHarnessShared = harnessShared.table("tui_view_state", {
	workspaceId: text("workspace_id").notNull(),
	ownerId: text("owner_id").notNull(),
	state: jsonb().default({}).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspaceId, table.ownerId], name: "tui_view_state_pkey"}),
	pgPolicy("tui_view_state_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const mobilePushTokensInHarnessShared = harnessShared.table("mobile_push_tokens", {
	deviceId: text("device_id").notNull(),
	platform: text().notNull(),
	token: text().notNull(),
	registeredAt: timestamp("registered_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("mobile_push_tokens_workspace_idx").using("btree", table.deviceId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.deviceId],
			foreignColumns: [mobileDevicesInHarnessShared.deviceId],
			name: "mobile_push_tokens_device_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.deviceId, table.platform], name: "mobile_push_tokens_pkey"}),
	pgPolicy("mobile_push_tokens_workspace_policy", { as: "permissive", for: "all", to: ["public"], using: sql`(EXISTS ( SELECT 1
   FROM harness_shared.mobile_devices d
  WHERE ((d.device_id = mobile_push_tokens.device_id) AND (d.workspace_id = current_setting('app.workspace_id'::text, true)))))` }),
	check("mobile_push_tokens_platform_check", sql`platform = ANY (ARRAY['apns'::text, 'fcm'::text])`),
]);

export const coordWatermarksInHarnessShared = harnessShared.table("coord_watermarks", {
	workspaceId: text("workspace_id").default('default').notNull(),
	ownerId: text("owner_id").notNull(),
	surfaces: jsonb().default({}).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspaceId, table.ownerId], name: "coord_watermarks_pkey"}),
	pgPolicy("coord_watermarks_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const roleCapabilityGrantsInHarnessShared = harnessShared.table("role_capability_grants", {
	workspaceId: text("workspace_id").notNull(),
	role: text().notNull(),
	capabilities: jsonb().default([]).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspaceId, table.role], name: "role_capability_grants_pkey"}),
	pgPolicy("role_capability_grants_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const interactiveUsageFilesInHarnessShared = harnessShared.table("interactive_usage_files", {
	workspaceId: text("workspace_id").notNull(),
	filePath: text("file_path").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	byteOffset: bigint("byte_offset", { mode: "number" }).default(0).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspaceId, table.filePath], name: "interactive_usage_files_pkey"}),
]);

export const operatorGymGatesInHarnessShared = harnessShared.table("operator_gym_gates", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	payload: jsonb().default({}).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspaceId, table.harnessSlug], name: "operator_gym_gates_pkey"}),
	pgPolicy("operator_gym_gates_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const userPreferencesInHarnessShared = harnessShared.table("user_preferences", {
	userId: uuid("user_id").notNull(),
	payload: jsonb().default({}).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
}, (table) => [
	foreignKey({
			columns: [table.userId],
			foreignColumns: [usersInHarnessShared.id],
			name: "user_preferences_user_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.userId, table.workspaceId], name: "user_preferences_pkey"}),
]);

export const workItemBlockedInHarnessShared = harnessShared.table("work_item_blocked", {
	workspaceId: text("workspace_id").default('default').notNull(),
	harnessSlug: text("harness_slug").notNull(),
	featureId: text("feature_id").notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspaceId, table.harnessSlug, table.featureId], name: "work_item_blocked_pkey"}),
]);

export const coordOpenEscalationsInHarnessShared = harnessShared.table("coord_open_escalations", {
	workspaceId: text("workspace_id").notNull(),
	msgId: text("msg_id").notNull(),
	ts: timestamp({ withTimezone: true }).notNull(),
	body: jsonb().notNull(),
}, (table) => [
	index("coord_open_escalations_ws_ts").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.ts.asc().nullsLast().op("text_ops"), table.msgId.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.workspaceId, table.msgId], name: "coord_open_escalations_pkey"}),
]);

export const agentNamesInHarnessShared = harnessShared.table("agent_names", {
	workspaceId: text("workspace_id").notNull(),
	agentName: text("agent_name").notNull(),
	ownerUser: text("owner_user").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("agent_names_owner_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.ownerUser.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.workspaceId, table.agentName], name: "agent_names_pkey"}),
	check("agent_names_name_nonempty", sql`agent_name <> ''::text`),
	check("agent_names_owner_nonempty", sql`owner_user <> ''::text`),
]);

export const agentNameSessionsInHarnessShared = harnessShared.table("agent_name_sessions", {
	workspaceId: text("workspace_id").notNull(),
	sessionOwnerId: text("session_owner_id").notNull(),
	agentName: text("agent_name").notNull(),
	ownerUser: text("owner_user").notNull(),
	adoptedAt: timestamp("adopted_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("agent_name_sessions_name_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.agentName.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.workspaceId, table.sessionOwnerId], name: "agent_name_sessions_pkey"}),
	check("agent_name_sessions_name_nonempty", sql`agent_name <> ''::text`),
]);

export const harnessPhaseLastUsedInHarnessShared = harnessShared.table("harness_phase_last_used", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	userId: text("user_id").notNull(),
	phase: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedTs: bigint("updated_ts", { mode: "number" }).notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspaceId, table.harnessSlug, table.userId], name: "harness_phase_last_used_pkey"}),
	pgPolicy("harness_phase_last_used_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const operatorCurationLogInHarnessShared = harnessShared.table("operator_curation_log", {
	workspaceId: text("workspace_id").notNull(),
	signalId: text("signal_id").notNull(),
	kind: text().notNull(),
	policyVersion: text("policy_version").default('').notNull(),
	surfacedAt: timestamp("surfaced_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("operator_curation_log_surfaced_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.surfacedAt.desc().nullsFirst().op("text_ops")),
	primaryKey({ columns: [table.workspaceId, table.signalId], name: "operator_curation_log_pkey"}),
]);

export const harnessFeatureDebugNotesInHarnessShared = harnessShared.table("harness_feature_debug_notes", {
	workspaceId: text("workspace_id").default('').notNull(),
	harnessSlug: text("harness_slug").notNull(),
	featureId: text("feature_id").notNull(),
	content: text().default('').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	mtimeMs: bigint("mtime_ms", { mode: "number" }).default(0).notNull(),
}, (table) => [
	index("hfdn_harness_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.workspaceId, table.harnessSlug, table.featureId], name: "harness_feature_debug_notes_pkey"}),
	pgPolicy("harness_feature_debug_notes_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const steeringChurnEscalationsInHarnessShared = harnessShared.table("steering_churn_escalations", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	featureId: text("feature_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	lastEscalatedTs: bigint("last_escalated_ts", { mode: "number" }).notNull(),
	churnCount: integer("churn_count").default(0).notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspaceId, table.harnessSlug, table.featureId], name: "steering_churn_escalations_pkey"}),
	pgPolicy("steering_churn_escalations_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const provisionStateInHarnessShared = harnessShared.table("provision_state", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	pluginSlug: text("plugin_slug").notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspaceId, table.harnessSlug, table.pluginSlug], name: "provision_state_pkey"}),
	pgPolicy("provision_state_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const pluginReloadStateInHarnessShared = harnessShared.table("plugin_reload_state", {
	pluginId: text("plugin_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	state: jsonb().notNull(),
	byteSize: integer("byte_size").notNull(),
	savedAt: timestamp("saved_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.pluginId, table.harnessSlug], name: "plugin_reload_state_pkey"}),
]);

export const harnessSkillsInHarnessShared = harnessShared.table("harness_skills", {
	workspaceId: text("workspace_id").default('').notNull(),
	harnessSlug: text("harness_slug").notNull(),
	name: text().notNull(),
	content: text().default('').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	mtimeMs: bigint("mtime_ms", { mode: "number" }).default(0).notNull(),
}, (table) => [
	index("harness_skills_lookup_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.workspaceId, table.harnessSlug, table.name], name: "harness_skills_pkey"}),
	pgPolicy("harness_skills_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const trustedAuthorsInHarnessShared = harnessShared.table("trusted_authors", {
	workspaceId: text("workspace_id").default('').notNull(),
	harnessSlug: text("harness_slug").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	trustedGithubUserId: bigint("trusted_github_user_id", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	trustedByGithubUserId: bigint("trusted_by_github_user_id", { mode: "number" }).notNull(),
	trustedAt: timestamp("trusted_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("trusted_authors_by_idx").using("btree", table.workspaceId.asc().nullsLast().op("int8_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.trustedByGithubUserId.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.workspaceId, table.harnessSlug, table.trustedGithubUserId], name: "trusted_authors_pkey"}),
	pgPolicy("trusted_authors_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const p2PRefusedOpCountersInHarnessShared = harnessShared.table("p2p_refused_op_counters", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	reason: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	count: bigint({ mode: "number" }).default(0).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspaceId, table.harnessSlug, table.reason], name: "p2p_refused_op_counters_pkey"}),
	check("p2p_refused_op_counters_nonneg", sql`count >= 0`),
]);

export const harnessGeneratorItemsInHarnessShared = harnessShared.table("harness_generator_items", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	featureId: text("feature_id").notNull(),
	items: jsonb().default([]).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedTs: bigint("updated_ts", { mode: "number" }).notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspaceId, table.harnessSlug, table.featureId], name: "harness_generator_items_pkey"}),
	pgPolicy("harness_generator_items_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const harnessFeatureNotesInHarnessShared = harnessShared.table("harness_feature_notes", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	featureId: text("feature_id").notNull(),
	content: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	index("harness_feature_notes_harness_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.workspaceId, table.harnessSlug, table.featureId], name: "harness_feature_notes_pkey"}),
	pgPolicy("harness_feature_notes_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const hiddenPluginsInHarnessShared = harnessShared.table("hidden_plugins", {
	basename: text().notNull(),
	reason: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	hiddenAt: bigint("hidden_at", { mode: "number" }).default(0).notNull(),
	hiddenBy: text("hidden_by"),
	workspaceId: text("workspace_id").default('').notNull(),
}, (table) => [
	index("hidden_plugins_basename_idx").using("btree", table.basename.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.basename, table.workspaceId], name: "hidden_plugins_pkey"}),
	pgPolicy("hidden_plugins_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const harnessPromptOverridesInHarnessShared = harnessShared.table("harness_prompt_overrides", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	role: text().notNull(),
	promptMd: text("prompt_md").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspaceId, table.harnessSlug, table.role], name: "harness_prompt_overrides_pkey"}),
	pgPolicy("harness_prompt_overrides_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const harnessTextArtifactsInHarnessShared = harnessShared.table("harness_text_artifacts", {
	harnessSlug: text("harness_slug").notNull(),
	relPath: text("rel_path").notNull(),
	content: text().default('').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
}, (table) => [
	index("hta_updated_idx").using("btree", table.harnessSlug.asc().nullsLast().op("int8_ops"), table.updatedAt.desc().nullsFirst().op("text_ops")),
	index("hta_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.harnessSlug, table.relPath], name: "harness_text_artifacts_pkey"}),
	pgPolicy("harness_text_artifacts_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const carryNotesInHarnessShared = harnessShared.table("carry_notes", {
	workspaceId: text("workspace_id").notNull(),
	scope: text().notNull(),
	note: text(),
	journal: jsonb().default([]).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedTs: bigint("updated_ts", { mode: "number" }).notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspaceId, table.scope], name: "carry_notes_pkey"}),
	pgPolicy("carry_notes_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const p2PGrantorEpochsInHarnessShared = harnessShared.table("p2p_grantor_epochs", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	grantorGithubUserId: bigint("grantor_github_user_id", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	highWaterEpoch: bigint("high_water_epoch", { mode: "number" }).default(0).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspaceId, table.harnessSlug, table.grantorGithubUserId], name: "p2p_grantor_epochs_pkey"}),
	check("p2p_grantor_epochs_nonneg", sql`high_water_epoch >= 0`),
]);

export const substrateMergeCursorInHarnessShared = harnessShared.table("substrate_merge_cursor", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	logKeyhex: text("log_keyhex").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	position: bigint({ mode: "number" }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspaceId, table.harnessSlug, table.logKeyhex], name: "substrate_merge_cursor_pkey"}),
]);

export const systemPrincipalsInHarnessShared = harnessShared.table("system_principals", {
	workspaceId: text("workspace_id").notNull(),
	name: text().notNull(),
	bearerHash: text("bearer_hash").notNull(),
	capabilities: jsonb().default([]).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("system_principals_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.workspaceId, table.name], name: "system_principals_pkey"}),
	pgPolicy("system_principals_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("system_principals_workspace_nonempty", sql`workspace_id <> ''::text`),
]);

export const pluginKvInHarnessShared = harnessShared.table("plugin_kv", {
	pluginId: text("plugin_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	key: text().notNull(),
	value: jsonb().notNull(),
	byteSize: integer("byte_size").notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_plugin_kv_prefix").using("btree", table.pluginId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_pattern_ops"), table.key.asc().nullsLast().op("text_pattern_ops")),
	index("idx_plugin_kv_quota").using("btree", table.pluginId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.pluginId, table.harnessSlug, table.key], name: "plugin_kv_pkey"}),
]);

export const planWorkGroupMembersInHarnessShared = harnessShared.table("plan_work_group_members", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	planSlug: text("plan_slug").notNull(),
	memberUser: text("member_user").notNull(),
	memberName: text("member_name"),
	joinedAt: timestamp("joined_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspaceId, table.harnessSlug, table.planSlug, table.memberUser], name: "plan_work_group_members_pkey"}),
	check("plan_work_group_members_user_nonempty", sql`member_user <> ''::text`),
]);

export const harnessMissionStateInHarnessShared = harnessShared.table("harness_mission_state", {
	workspaceId: text("workspace_id").default('default').notNull(),
	harnessSlug: text("harness_slug").notNull(),
	costWarnFired: boolean("cost_warn_fired").default(false).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	readyForProdAt: bigint("ready_for_prod_at", { mode: "number" }),
	lanes: jsonb().default([]).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspaceId, table.harnessSlug], name: "harness_mission_state_pkey"}),
	pgPolicy("harness_mission_state_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const harnessRunChunksInHarnessShared = harnessShared.table("harness_run_chunks", {
	workspaceId: text("workspace_id").default('default').notNull(),
	harnessSlug: text("harness_slug").notNull(),
	runId: text("run_id").notNull(),
	seq: integer().notNull(),
	chunkData: text("chunk_data").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).notNull(),
}, (table) => [
	index("harness_run_chunks_run_idx").using("btree", table.workspaceId.asc().nullsLast().op("int4_ops"), table.harnessSlug.asc().nullsLast().op("int4_ops"), table.runId.asc().nullsLast().op("int4_ops"), table.seq.asc().nullsLast().op("int4_ops")),
	primaryKey({ columns: [table.workspaceId, table.harnessSlug, table.runId, table.seq], name: "harness_run_chunks_pkey"}),
	pgPolicy("harness_run_chunks_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const autoloopStateInHarnessShared = harnessShared.table("autoloop_state", {
	harnessSlug: text("harness_slug").notNull(),
	role: text().default('director').notNull(),
	lastFiredAt: timestamp("last_fired_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lastStatus: text("last_status"),
	consecutiveErrors: integer("consecutive_errors").default(0).notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
}, (table) => [
	primaryKey({ columns: [table.harnessSlug, table.role, table.workspaceId], name: "autoloop_state_pkey"}),
	pgPolicy("autoloop_state_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const piSessionsInHarnessShared = harnessShared.table("pi_sessions", {
	workspaceId: text("workspace_id").notNull(),
	sessionId: text("session_id").notNull(),
	bearerHash: text("bearer_hash").notNull(),
	capabilities: jsonb().default([]).notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	endedAt: timestamp("ended_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("pi_sessions_active_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.sessionId.asc().nullsLast().op("text_ops")).where(sql`(ended_at IS NULL)`),
	index("pi_sessions_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.workspaceId, table.sessionId], name: "pi_sessions_pkey"}),
	pgPolicy("pi_sessions_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("pi_sessions_workspace_nonempty", sql`workspace_id <> ''::text`),
]);

export const supervisorNotesConsolidatedInHarnessShared = harnessShared.table("supervisor_notes_consolidated", {
	workspaceId: text("workspace_id").default('default').notNull(),
	harnessSlug: text("harness_slug").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).generatedAlwaysAsIdentity({ name: "harness_shared.supervisor_notes_consolidated_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	body: text().default('').notNull(),
	source: text().default('').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdAt: bigint("created_at", { mode: "number" }).notNull(),
}, (table) => [
	index("supervisor_notes_consolidated_recent_idx").using("btree", table.harnessSlug.asc().nullsLast().op("int8_ops"), table.createdAt.desc().nullsFirst().op("int8_ops")),
	primaryKey({ columns: [table.harnessSlug, table.id], name: "supervisor_notes_consolidated_pkey"}),
]);

export const attentionTriageInHarnessShared = harnessShared.table("attention_triage", {
	workspaceId: text("workspace_id").notNull(),
	itemId: text("item_id").notNull(),
	action: text().notNull(),
	note: text(),
	triagedBy: text("triaged_by"),
	triagedAt: timestamp("triaged_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspaceId, table.itemId], name: "attention_triage_pkey"}),
	pgPolicy("attention_triage_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("attention_triage_action_check", sql`action = ANY (ARRAY['confirm'::text, 'escalate'::text, 'downgrade'::text, 'resolve'::text])`),
]);

export const memoryAnchorsInHarnessShared = harnessShared.table("memory_anchors", {
	memoryId: uuid("memory_id").notNull(),
	kind: text().notNull(),
	value: text().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lastCheckedAt: timestamp("last_checked_at", { withTimezone: true, mode: 'string' }),
	lastCheckOk: boolean("last_check_ok"),
}, (table) => [
	index("memory_anchors_lookup_idx").using("btree", table.kind.asc().nullsLast().op("text_ops"), table.value.asc().nullsLast().op("text_ops")),
	index("memory_anchors_recheck_idx").using("btree", table.lastCheckedAt.asc().nullsFirst().op("timestamptz_ops")),
	foreignKey({
			columns: [table.memoryId],
			foreignColumns: [memoryCanonicalInHarnessShared.id],
			name: "memory_anchors_memory_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.memoryId, table.kind, table.value], name: "memory_anchors_pkey"}),
	check("memory_anchors_kind_check", sql`kind = ANY (ARRAY['file'::text, 'feature'::text, 'plan'::text, 'migration'::text, 'symbol'::text])`),
]);

export const p2PMeteringContributionInHarnessShared = harnessShared.table("p2p_metering_contribution", {
	workspaceId: text("workspace_id").notNull(),
	attestedUserId: text("attested_user_id").notNull(),
	axis: text().notNull(),
	amount: doublePrecision().default(0).notNull(),
	unit: text().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspaceId, table.attestedUserId, table.axis], name: "p2p_metering_contribution_pkey"}),
	check("p2p_metering_contribution_axis", sql`axis = ANY (ARRAY['remote'::text, 'local'::text])`),
	check("p2p_metering_contribution_nonneg", sql`amount >= (0)::double precision`),
	check("p2p_metering_contribution_ws_nonempty", sql`workspace_id <> ''::text`),
	check("p2p_metering_contribution_user_nonempty", sql`attested_user_id <> ''::text`),
	check("p2p_metering_contribution_unit_nonempty", sql`unit <> ''::text`),
]);

export const pluginConfigsInHarnessShared = harnessShared.table("plugin_configs", {
	harnessSlug: text("harness_slug").notNull(),
	pluginSlug: text("plugin_slug").notNull(),
	config: jsonb().default({}).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	workspaceId: text("workspace_id").notNull(),
	configCt: byteaCustom("config_ct"),
}, (table) => [
	index("plugin_configs_plugin_idx").using("btree", table.pluginSlug.asc().nullsLast().op("text_ops")),
	index("plugin_configs_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.harnessSlug, table.pluginSlug], name: "plugin_configs_pkey"}),
	pgPolicy("plugin_configs_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("plugin_configs_workspace_nonempty", sql`workspace_id <> ''::text`),
]);

export const harnessArchivesInHarnessShared = harnessShared.table("harness_archives", {
	harnessSlug: text("harness_slug").notNull(),
	phase: text().default('staging').notNull(),
	id: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	sizeBytes: bigint("size_bytes", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).default(0).notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
}, (table) => [
	index("harness_archives_slug_phase_ts_idx").using("btree", table.harnessSlug.asc().nullsLast().op("int8_ops"), table.phase.asc().nullsLast().op("int8_ops"), table.ts.desc().nullsFirst().op("int8_ops")),
	primaryKey({ columns: [table.harnessSlug, table.phase, table.id], name: "harness_archives_pkey"}),
	pgPolicy("harness_archives_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const harnessScreenshotsInHarnessShared = harnessShared.table("harness_screenshots", {
	harnessSlug: text("harness_slug").notNull(),
	phase: text().default('staging').notNull(),
	id: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	sizeBytes: bigint("size_bytes", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).default(0).notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
}, (table) => [
	index("harness_screenshots_slug_phase_ts_idx").using("btree", table.harnessSlug.asc().nullsLast().op("int8_ops"), table.phase.asc().nullsLast().op("int8_ops"), table.ts.desc().nullsFirst().op("int8_ops")),
	primaryKey({ columns: [table.harnessSlug, table.phase, table.id], name: "harness_screenshots_pkey"}),
	pgPolicy("harness_screenshots_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const coordTopicsInHarnessShared = harnessShared.table("coord_topics", {
	workspaceId: text("workspace_id").default('default').notNull(),
	slug: text().notNull(),
	title: text(),
	description: text().default('').notNull(),
	createdBy: text("created_by"),
	mergedInto: text("merged_into"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("coord_topics_live_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("text_ops")).where(sql`(merged_into IS NULL)`),
	primaryKey({ columns: [table.workspaceId, table.slug], name: "coord_topics_pkey"}),
	check("coord_topics_slug_nonempty", sql`slug <> ''::text`),
	check("coord_topics_workspace_nonempty", sql`workspace_id <> ''::text`),
]);

export const harnessDockLayoutsInHarnessShared = harnessShared.table("harness_dock_layouts", {
	workspaceId: text("workspace_id").notNull(),
	userId: text("user_id").notNull(),
	layoutName: text("layout_name").default('default').notNull(),
	schemaVersion: integer("schema_version").default(1).notNull(),
	layoutJson: jsonb("layout_json").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedTs: bigint("updated_ts", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdTs: bigint("created_ts", { mode: "number" }).notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspaceId, table.userId, table.layoutName], name: "harness_dock_layouts_pkey"}),
	pgPolicy("harness_dock_layouts_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const harnessPromotionsInHarnessShared = harnessShared.table("harness_promotions", {
	workspaceId: text("workspace_id").default('default').notNull(),
	harnessSlug: text("harness_slug").notNull(),
	promotionId: text("promotion_id").notNull(),
	fromPhase: text("from_phase").notNull(),
	toPhase: text("to_phase").notNull(),
	sha: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).notNull(),
}, (table) => [
	index("harness_promotions_ts_idx").using("btree", table.workspaceId.asc().nullsLast().op("int8_ops"), table.harnessSlug.asc().nullsLast().op("int8_ops"), table.ts.desc().nullsFirst().op("int8_ops")),
	primaryKey({ columns: [table.workspaceId, table.harnessSlug, table.promotionId], name: "harness_promotions_pkey"}),
	pgPolicy("harness_promotions_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const pluginEnablesInHarnessShared = harnessShared.table("plugin_enables", {
	harnessSlug: text("harness_slug").notNull(),
	pluginSlug: text("plugin_slug").notNull(),
	version: text().notNull(),
	configHash: text("config_hash").default('').notNull(),
	enabledAt: timestamp("enabled_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	workspaceId: text("workspace_id").notNull(),
}, (table) => [
	index("plugin_enables_plugin_idx").using("btree", table.pluginSlug.asc().nullsLast().op("text_ops")),
	index("plugin_enables_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.harnessSlug, table.pluginSlug], name: "plugin_enables_pkey"}),
	pgPolicy("plugin_enables_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("plugin_enables_workspace_nonempty", sql`workspace_id <> ''::text`),
]);

export const rationaleIndexInHarnessShared = harnessShared.table("rationale_index", {
	sourceId: text("source_id").notNull(),
	key: text().notNull(),
	entryId: text("entry_id").notNull(),
	kind: text(),
	entry: jsonb().notNull(),
	sortKey: text("sort_key"),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("rationale_index_key_idx").using("btree", table.key.asc().nullsLast().op("text_ops"), table.sortKey.desc().nullsFirst().op("text_ops")),
	index("rationale_index_source_idx").using("btree", table.sourceId.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.sourceId, table.key, table.entryId], name: "rationale_index_pkey"}),
]);

export const pluginCapabilityGrantsInHarnessShared = harnessShared.table("plugin_capability_grants", {
	pluginName: text("plugin_name").notNull(),
	pluginVersion: text("plugin_version").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	capability: text().notNull(),
	grantedAt: timestamp("granted_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	grantedBy: text("granted_by"),
	reason: text(),
}, (table) => [
	index("plugin_caps_by_harness").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.pluginName.asc().nullsLast().op("text_ops")),
	index("plugin_caps_by_plugin").using("btree", table.pluginName.asc().nullsLast().op("text_ops"), table.pluginVersion.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.pluginName, table.pluginVersion, table.harnessSlug, table.capability], name: "plugin_capability_grants_pkey"}),
]);

export const mcpToolResultsInHarnessShared = harnessShared.table("mcp_tool_results", {
	ownerKey: text("owner_key").notNull(),
	idempotencyKey: text("idempotency_key").notNull(),
	toolName: text("tool_name").notNull(),
	workspaceId: text("workspace_id").default('*').notNull(),
	result: jsonb().notNull(),
	isError: boolean("is_error").default(false).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("mcp_tool_results_created_at_idx").using("btree", table.createdAt.asc().nullsLast().op("timestamptz_ops")),
	primaryKey({ columns: [table.ownerKey, table.idempotencyKey], name: "mcp_tool_results_pkey"}),
]);

export const tuiLayoutsInHarnessShared = harnessShared.table("tui_layouts", {
	workspaceId: text("workspace_id").notNull(),
	ownerId: text("owner_id").notNull(),
	name: text().notNull(),
	kdl: text().notNull(),
	description: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("tui_layouts_owner_idx").using("btree", table.workspaceId.asc().nullsLast().op("timestamptz_ops"), table.ownerId.asc().nullsLast().op("timestamptz_ops"), table.updatedAt.desc().nullsFirst().op("timestamptz_ops")),
	primaryKey({ columns: [table.workspaceId, table.ownerId, table.name], name: "tui_layouts_pkey"}),
	pgPolicy("tui_layouts_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const harnessDesignArtifactsInHarnessShared = harnessShared.table("harness_design_artifacts", {
	id: text().notNull(),
	harnessSlug: text("harness_slug").notNull(),
	featureId: text("feature_id").notNull(),
	kind: text().notNull(),
	payload: jsonb().notNull(),
	metadata: jsonb(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdTs: bigint("created_ts", { mode: "number" }).notNull(),
}, (table) => [
	index("hda_created_idx").using("btree", table.harnessSlug.asc().nullsLast().op("int8_ops"), table.createdTs.desc().nullsFirst().op("text_ops")),
	index("hda_feature_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.featureId.asc().nullsLast().op("text_ops")),
	index("hda_kind_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.featureId.asc().nullsLast().op("text_ops"), table.kind.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.id, table.harnessSlug], name: "harness_design_artifacts_pkey"}),
	check("hda_kind_chk", sql`kind = ANY (ARRAY['spec'::text, 'sketch'::text, 'screenshot'::text, 'annotation'::text, 'rejected_candidate'::text, 'review'::text])`),
]);

export const p2PMeteringSpendInHarnessShared = harnessShared.table("p2p_metering_spend", {
	workspaceId: text("workspace_id").notNull(),
	hostRef: text("host_ref").notNull(),
	fleetSlug: text("fleet_slug").notNull(),
	axis: text().notNull(),
	amount: doublePrecision().default(0).notNull(),
	unit: text().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("p2p_metering_spend_fleet_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.fleetSlug.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.workspaceId, table.hostRef, table.fleetSlug, table.axis], name: "p2p_metering_spend_pkey"}),
	check("p2p_metering_spend_axis", sql`axis = ANY (ARRAY['remote'::text, 'local'::text])`),
	check("p2p_metering_spend_nonneg", sql`amount >= (0)::double precision`),
	check("p2p_metering_spend_ws_nonempty", sql`workspace_id <> ''::text`),
	check("p2p_metering_spend_host_nonempty", sql`host_ref <> ''::text`),
	check("p2p_metering_spend_fleet_nonempty", sql`fleet_slug <> ''::text`),
	check("p2p_metering_spend_unit_nonempty", sql`unit <> ''::text`),
]);

export const federationRefusedOpCountersInHarnessShared = harnessShared.table("federation_refused_op_counters", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	sourceHive: text("source_hive").notNull(),
	tableTag: text("table_tag").notNull(),
	reason: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	count: bigint({ mode: "number" }).default(0).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspaceId, table.harnessSlug, table.sourceHive, table.tableTag, table.reason], name: "federation_refused_op_counters_pkey"}),
	check("federation_refused_op_counters_nonneg", sql`count >= 0`),
	check("federation_refused_op_counters_ws_nonempty", sql`workspace_id <> ''::text`),
	check("federation_refused_op_counters_slug_nonempty", sql`harness_slug <> ''::text`),
	check("federation_refused_op_counters_source_nonempty", sql`source_hive <> ''::text`),
	check("federation_refused_op_counters_tag_nonempty", sql`table_tag <> ''::text`),
	check("federation_refused_op_counters_reason_nonempty", sql`reason <> ''::text`),
]);

export const scoutLensWeightsInHarnessShared = harnessShared.table("scout_lens_weights", {
	workspaceId: text("workspace_id").notNull(),
	lens: text().notNull(),
	wins: integer().default(0).notNull(),
	decided: integer().default(0).notNull(),
	weight: numeric().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	potSlug: text("pot_slug").notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspaceId, table.lens, table.potSlug], name: "scout_lens_weights_pkey"}),
	pgPolicy("scout_lens_weights_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const harnessLanesInHarnessShared = harnessShared.table("harness_lanes", {
	harnessSlug: text("harness_slug").notNull(),
	phase: text().default('staging').notNull(),
	role: text().notNull(),
	featureId: text("feature_id"),
	pid: integer(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	startedAt: bigint("started_at", { mode: "number" }).notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
}, (table) => [
	index("harness_lanes_started_idx").using("btree", table.startedAt.asc().nullsLast().op("int8_ops")),
	index("harness_lanes_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.harnessSlug, table.phase, table.role], name: "harness_lanes_pkey"}),
	pgPolicy("harness_lanes_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const harnessHookLogsInHarnessShared = harnessShared.table("harness_hook_logs", {
	harnessSlug: text("harness_slug").notNull(),
	logId: text("log_id").notNull(),
	name: text().default('').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	sizeBytes: bigint("size_bytes", { mode: "number" }).default(0).notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
	content: text().default('').notNull(),
}, (table) => [
	index("harness_hook_logs_slug_ts_idx").using("btree", table.harnessSlug.asc().nullsLast().op("int8_ops"), table.ts.desc().nullsFirst().op("int8_ops")),
	primaryKey({ columns: [table.harnessSlug, table.logId], name: "harness_hook_logs_pkey"}),
	pgPolicy("harness_hook_logs_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const harnessCheckpointsInHarnessShared = harnessShared.table("harness_checkpoints", {
	harnessSlug: text("harness_slug").notNull(),
	name: text().notNull(),
	content: text().default('').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	waitingSinceMs: bigint("waiting_since_ms", { mode: "number" }).default(0).notNull(),
	granted: boolean().default(false).notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
	consumed: boolean().default(false).notNull(),
}, (table) => [
	index("harness_checkpoints_slug_waiting_idx").using("btree", table.harnessSlug.asc().nullsLast().op("int8_ops"), table.waitingSinceMs.asc().nullsLast().op("int8_ops")),
	primaryKey({ columns: [table.harnessSlug, table.name], name: "harness_checkpoints_pkey"}),
	pgPolicy("harness_checkpoints_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const hivesInHarnessShared = harnessShared.table("hives", {
	workspaceId: text("workspace_id").notNull(),
	homeSlug: text("home_slug").notNull(),
	publicKey: byteaCustom("public_key").notNull(),
	keychainId: text("keychain_id").notNull(),
	title: text(),
	description: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdAt: bigint("created_at", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspaceId, table.homeSlug], name: "hives_pkey"}),
	unique("hives_public_key_key").on(table.publicKey),
	pgPolicy("hives_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const fleetSagasInHarnessShared = harnessShared.table("fleet_sagas", {
	workspaceId: text("workspace_id").notNull(),
	sagaId: text("saga_id").notNull(),
	name: text().notNull(),
	status: text().default('running').notNull(),
	steps: jsonb().default([]).notNull(),
	error: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("fleet_sagas_open_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.updatedAt.asc().nullsLast().op("text_ops")).where(sql`(status = 'running'::text)`),
	primaryKey({ columns: [table.workspaceId, table.sagaId], name: "fleet_sagas_pkey"}),
]);

export const fleetTombstonesInHarnessShared = harnessShared.table("fleet_tombstones", {
	workspaceId: text("workspace_id").notNull(),
	refKind: text("ref_kind").notNull(),
	refId: text("ref_id").notNull(),
	reason: text().default('').notNull(),
	deletedBy: text("deleted_by"),
	deletedAt: timestamp("deleted_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	gcAfter: timestamp("gc_after", { withTimezone: true, mode: 'string' }).notNull(),
	restoredAt: timestamp("restored_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("fleet_tombstones_gc_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.gcAfter.asc().nullsLast().op("timestamptz_ops")).where(sql`(restored_at IS NULL)`),
	primaryKey({ columns: [table.workspaceId, table.refKind, table.refId], name: "fleet_tombstones_pkey"}),
]);

export const claimAuditInHarnessShared = harnessShared.table("claim_audit", {
	workspaceId: text("workspace_id").default('').notNull(),
	id: bigserial({ mode: "bigint" }).notNull(),
	harnessSlug: text("harness_slug").notNull(),
	featureId: text("feature_id").notNull(),
	claimerPubkey: text("claimer_pubkey").notNull(),
	attemptTs: timestamp("attempt_ts", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	outcome: text().notNull(),
	detail: text(),
}, (table) => [
	index("claim_audit_feature_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.featureId.asc().nullsLast().op("timestamptz_ops"), table.attemptTs.desc().nullsFirst().op("timestamptz_ops")),
	primaryKey({ columns: [table.workspaceId, table.id], name: "claim_audit_pkey"}),
	pgPolicy("claim_audit_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("claim_audit_outcome_check", sql`outcome = ANY (ARRAY['won'::text, 'lost'::text, 'timeout'::text, 'error'::text])`),
]);

export const prReviewerSettingsInHarnessShared = harnessShared.table("pr_reviewer_settings", {
	workspaceId: text("workspace_id").default('').notNull(),
	harnessSlug: text("harness_slug").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	githubUserId: bigint("github_user_id", { mode: "number" }).notNull(),
	prReviewerRoleEnabled: boolean("pr_reviewer_role_enabled").default(false).notNull(),
	autoReview: boolean("auto_review").default(false).notNull(),
	autoMerge: boolean("auto_merge").default(false).notNull(),
	mergeMethod: text("merge_method").default('squash').notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspaceId, table.harnessSlug, table.githubUserId], name: "pr_reviewer_settings_pkey"}),
	pgPolicy("pr_reviewer_settings_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("pr_reviewer_settings_merge_method_check", sql`merge_method = ANY (ARRAY['squash'::text, 'merge'::text, 'rebase'::text])`),
]);

export const directiveSummariesConsolidatedInHarnessShared = harnessShared.table("directive_summaries_consolidated", {
	workspaceId: text("workspace_id").default('default').notNull(),
	harnessSlug: text("harness_slug").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).generatedAlwaysAsIdentity({ name: "harness_shared.directive_summaries_consolidated_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	directiveId: text("directive_id").notNull(),
	source: text().default('ceo').notNull(),
	summary: text().default('').notNull(),
	callerSlug: text("caller_slug"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdAt: bigint("created_at", { mode: "number" }).notNull(),
}, (table) => [
	index("directive_summaries_consolidated_recent_idx").using("btree", table.harnessSlug.asc().nullsLast().op("int8_ops"), table.createdAt.desc().nullsFirst().op("int8_ops")),
	primaryKey({ columns: [table.harnessSlug, table.id], name: "directive_summaries_consolidated_pkey"}),
]);

export const tuiCrewsInHarnessShared = harnessShared.table("tui_crews", {
	workspaceId: text("workspace_id").notNull(),
	ownerId: text("owner_id").notNull(),
	name: text().notNull(),
	members: jsonb().default([]).notNull(),
	layoutName: text("layout_name"),
	description: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("tui_crews_owner_idx").using("btree", table.workspaceId.asc().nullsLast().op("timestamptz_ops"), table.ownerId.asc().nullsLast().op("timestamptz_ops"), table.updatedAt.desc().nullsFirst().op("timestamptz_ops")),
	primaryKey({ columns: [table.workspaceId, table.ownerId, table.name], name: "tui_crews_pkey"}),
	pgPolicy("tui_crews_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const harnessSnapshotsConsolidatedInHarnessShared = harnessShared.table("harness_snapshots_consolidated", {
	harnessSlug: text("harness_slug").notNull(),
	snapshotId: text("snapshot_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).notNull(),
	iterNum: integer("iter_num").default(0).notNull(),
	files: jsonb().default([]).notNull(),
	featureCounts: jsonb("feature_counts").default({}).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdTs: bigint("created_ts", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedTs: bigint("updated_ts", { mode: "number" }).notNull(),
}, (table) => [
	index("hsc_iter_idx").using("btree", table.harnessSlug.asc().nullsLast().op("int4_ops"), table.iterNum.desc().nullsFirst().op("text_ops")),
	index("hsc_ts_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("int8_ops")),
	primaryKey({ columns: [table.harnessSlug, table.snapshotId], name: "harness_snapshots_consolidated_pkey"}),
]);

export const harnessPlanStatusInHarnessShared = harnessShared.table("harness_plan_status", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	planSlug: text("plan_slug").notNull(),
	status: text().notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	currentWave: text("current_wave"),
	priority: integer(),
}, (table) => [
	index("hps_started_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")).where(sql`(status = 'started'::text)`),
	primaryKey({ columns: [table.workspaceId, table.harnessSlug, table.planSlug], name: "harness_plan_status_pkey"}),
	pgPolicy("harness_plan_status_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("harness_plan_status_status_check", sql`status = ANY (ARRAY['started'::text, 'paused'::text, 'done'::text])`),
]);

export const agentModesInHarnessShared = harnessShared.table("agent_modes", {
	workspaceId: text("workspace_id").default('default').notNull(),
	ownerId: text("owner_id").notNull(),
	axisKey: text("axis_key").notNull(),
	mode: text().notNull(),
	reason: text().default('').notNull(),
	setBy: text("set_by").notNull(),
	ownerDirected: boolean("owner_directed").default(false).notNull(),
	setAt: timestamp("set_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("agent_modes_owner_idx").using("btree", table.ownerId.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.workspaceId, table.ownerId, table.axisKey], name: "agent_modes_pkey"}),
]);

export const sessionIngestStateInHarnessShared = harnessShared.table("session_ingest_state", {
	sourceKind: text("source_kind").notNull(),
	filePath: text("file_path").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	byteOffset: bigint("byte_offset", { mode: "number" }).default(0).notNull(),
	turnCount: integer("turn_count").default(0).notNull(),
	sessionId: text("session_id"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	mtimeMs: bigint("mtime_ms", { mode: "number" }),
	lastError: text("last_error"),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.sourceKind, table.filePath], name: "session_ingest_state_pkey"}),
]);

export const commsTrustListInHarnessShared = harnessShared.table("comms_trust_list", {
	workspaceId: text("workspace_id").default('').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	trustedGithubUserId: bigint("trusted_github_user_id", { mode: "number" }).notNull(),
	tier: text(),
	note: text(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdTs: bigint("created_ts", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedTs: bigint("updated_ts", { mode: "number" }).notNull(),
	gate: boolean().default(false).notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspaceId, table.trustedGithubUserId], name: "comms_trust_list_pkey"}),
	check("comms_trust_list_tier_check", sql`tier = ANY (ARRAY['observe'::text, 'message'::text, 'wake'::text, 'steer'::text])`),
]);

export const blueprintsInHarnessShared = harnessShared.table("blueprints", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	blueprintId: text("blueprint_id").notNull(),
	version: text().default('0.1.0').notNull(),
	resolved: jsonb().notNull(),
	contentHash: text("content_hash").notNull(),
	sourcePath: text("source_path"),
	sourceCommit: text("source_commit"),
	projectedAt: timestamp("projected_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspaceId, table.harnessSlug], name: "blueprints_pkey"}),
	pgPolicy("blueprints_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const gymAutoloopConfigInHarnessShared = harnessShared.table("gym_autoloop_config", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	enabled: boolean().default(false).notNull(),
	budgetUsd: doublePrecision("budget_usd"),
	spentUsd: doublePrecision("spent_usd").default(0).notNull(),
	status: text().default('idle').notNull(),
	lastCycle: integer("last_cycle"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	lastCycleAt: bigint("last_cycle_at", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspaceId, table.harnessSlug], name: "gym_autoloop_config_pkey"}),
	pgPolicy("gym_autoloop_config_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const prCheckStatusCacheInHarnessShared = harnessShared.table("pr_check_status_cache", {
	workspaceId: text("workspace_id").default('').notNull(),
	harnessSlug: text("harness_slug").notNull(),
	headSha: text("head_sha").notNull(),
	checkName: text("check_name").notNull(),
	status: text().notNull(),
	conclusion: text(),
	detailsUrl: text("details_url"),
	fetchedAt: timestamp("fetched_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	raw: jsonb(),
}, (table) => [
	index("pr_check_status_cache_sha_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.headSha.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.workspaceId, table.harnessSlug, table.headSha, table.checkName], name: "pr_check_status_cache_pkey"}),
	pgPolicy("pr_check_status_cache_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const featureClaimsInHarnessShared = harnessShared.table("feature_claims", {
	workspaceId: text("workspace_id").default('').notNull(),
	harnessSlug: text("harness_slug").notNull(),
	featureId: text("feature_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	seq: bigint({ mode: "number" }).notNull(),
	claimerPubkey: text("claimer_pubkey").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	claimerGithubUserId: bigint("claimer_github_user_id", { mode: "number" }).notNull(),
	claimedAt: timestamp("claimed_at", { withTimezone: true, mode: 'string' }).notNull(),
	outcome: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	schemaVersion: bigint("schema_version", { mode: "number" }).default(1).notNull(),
}, (table) => [
	index("feature_claims_outcome_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.featureId.asc().nullsLast().op("text_ops"), table.outcome.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.workspaceId, table.harnessSlug, table.featureId, table.seq], name: "feature_claims_pkey"}),
	pgPolicy("feature_claims_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const harnessSnapshotsInHarnessShared = harnessShared.table("harness_snapshots", {
	workspaceId: text("workspace_id").default('default').notNull(),
	harnessSlug: text("harness_slug").notNull(),
	snapshotId: text("snapshot_id").notNull(),
	iteration: integer().notNull(),
	featuresJson: text("features_json"),
	validationMd: text("validation_md"),
	notesMd: text("notes_md"),
	configJson: text("config_json"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	takenAt: bigint("taken_at", { mode: "number" }).notNull(),
}, (table) => [
	index("harness_snapshots_recent_idx").using("btree", table.workspaceId.asc().nullsLast().op("int8_ops"), table.harnessSlug.asc().nullsLast().op("int8_ops"), table.takenAt.desc().nullsFirst().op("int8_ops")),
	primaryKey({ columns: [table.workspaceId, table.harnessSlug, table.snapshotId], name: "harness_snapshots_pkey"}),
	pgPolicy("harness_snapshots_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const harnessBrainstormInHarnessShared = harnessShared.table("harness_brainstorm", {
	harnessSlug: text("harness_slug").notNull(),
	phase: text().default('staging').notNull(),
	content: text().default('').notNull(),
	canvas: jsonb(),
	mindmap: jsonb(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
	contentTsv: tsvectorCustom("content_tsv"),
	contentEmbedding: vector("content_embedding", { dimensions: 384 }),
}, (table) => [
	index("harness_brainstorm_content_embedding_hnsw").using("hnsw", table.contentEmbedding.asc().nullsLast().op("vector_cosine_ops")),
	index("harness_brainstorm_tsv_idx").using("gin", table.contentTsv.asc().nullsLast().op("tsvector_ops")),
	index("harness_brainstorm_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.harnessSlug, table.phase], name: "harness_brainstorm_pkey"}),
	pgPolicy("harness_brainstorm_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const autonomyPolicyInHarnessShared = harnessShared.table("autonomy_policy", {
	workspaceId: text("workspace_id").default('default').notNull(),
	category: text().notNull(),
	ceiling: text().default('never-auto').notNull(),
	locked: boolean().default(false).notNull(),
	graduatedLevel: text("graduated_level").default('never-auto').notNull(),
	thresholdOverrides: jsonb("threshold_overrides").default({}).notNull(),
	ownerOverride: jsonb("owner_override"),
	updatedBy: text("updated_by").default('system').notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspaceId, table.category], name: "autonomy_policy_pkey"}),
	check("autonomy_policy_ceiling_check", sql`ceiling = ANY (ARRAY['never-auto'::text, 'trivial'::text, 'low'::text, 'moderate'::text, 'high'::text, 'critical'::text])`),
	check("autonomy_policy_graduated_level_check", sql`graduated_level = ANY (ARRAY['never-auto'::text, 'trivial'::text, 'low'::text, 'moderate'::text, 'high'::text, 'critical'::text])`),
]);

export const executedActionsConsolidatedInHarnessShared = harnessShared.table("executed_actions_consolidated", {
	workspaceId: text("workspace_id").default('default').notNull(),
	harnessSlug: text("harness_slug").notNull(),
	actionId: uuid("action_id").notNull(),
	op: text(),
	callerSlug: text("caller_slug"),
	targetSlug: text("target_slug"),
	reason: text(),
	request: jsonb(),
	response: jsonb(),
	executedAt: timestamp("executed_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("executed_actions_consolidated_recent_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.executedAt.desc().nullsFirst().op("text_ops")),
	primaryKey({ columns: [table.harnessSlug, table.actionId], name: "executed_actions_consolidated_pkey"}),
]);

export const hiveSettingsInHarnessShared = harnessShared.table("hive_settings", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	settingKey: text("setting_key").notNull(),
	value: text(),
	authorPubkey: text("author_pubkey"),
	origin: text().default('local').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdAt: bigint("created_at", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
	fedHlc: text("fed_hlc"),
}, (table) => [
	primaryKey({ columns: [table.workspaceId, table.harnessSlug, table.settingKey], name: "hive_settings_pkey"}),
	pgPolicy("hive_settings_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const negativeSpaceDemandInHarnessShared = harnessShared.table("negative_space_demand", {
	workspaceId: text("workspace_id").notNull(),
	surface: text().notNull(),
	queryNorm: text("query_norm").notNull(),
	exampleQuery: text("example_query").notNull(),
	missCount: integer("miss_count").notNull(),
	distinctAgents: integer("distinct_agents").default(1).notNull(),
	firstMissedAt: timestamp("first_missed_at", { withTimezone: true, mode: 'string' }).notNull(),
	lastMissedAt: timestamp("last_missed_at", { withTimezone: true, mode: 'string' }).notNull(),
	candidateImprovementId: text("candidate_improvement_id"),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspaceId, table.surface, table.queryNorm], name: "negative_space_demand_pkey"}),
	check("negative_space_demand_surface_check", sql`surface = ANY (ARRAY['docs'::text, 'memory'::text, 'plans'::text])`),
	check("negative_space_demand_miss_count_check", sql`miss_count > 0`),
]);

export const webhookAuditInHarnessShared = harnessShared.table("webhook_audit", {
	workspaceId: text("workspace_id").default('').notNull(),
	id: bigserial({ mode: "bigint" }).notNull(),
	harnessSlug: text("harness_slug").notNull(),
	targetUrl: text("target_url").notNull(),
	eventKind: text("event_kind").notNull(),
	payload: jsonb(),
	statusCode: integer("status_code"),
	attemptCount: integer("attempt_count").default(1).notNull(),
	sentAt: timestamp("sent_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	error: text(),
}, (table) => [
	index("webhook_audit_recent_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.sentAt.desc().nullsFirst().op("text_ops")),
	primaryKey({ columns: [table.workspaceId, table.id], name: "webhook_audit_pkey"}),
	pgPolicy("webhook_audit_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const harnessFeaturePrsInHarnessShared = harnessShared.table("harness_feature_prs", {
	workspaceId: text("workspace_id").default('').notNull(),
	harnessSlug: text("harness_slug").notNull(),
	featureId: text("feature_id").notNull(),
	prUrl: text("pr_url").notNull(),
	prState: text("pr_state").default('unknown').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	openedTs: bigint("opened_ts", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedTs: bigint("updated_ts", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	fedHlc: text("fed_hlc"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	authorGithubUserId: bigint("author_github_user_id", { mode: "number" }),
}, (table) => [
	index("hfp_harness_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.workspaceId, table.harnessSlug, table.featureId], name: "harness_feature_prs_pkey"}),
	pgPolicy("harness_feature_prs_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const hiveIntegrationRequestsInHarnessShared = harnessShared.table("hive_integration_requests", {
	workspaceId: text("workspace_id").default('').notNull(),
	repoKey: text("repo_key").notNull(),
	devicePubkey: text("device_pubkey").notNull(),
	headSha: text("head_sha").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	authorGithubUserId: bigint("author_github_user_id", { mode: "number" }),
	reason: text().notNull(),
	state: text().default('pending').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdTs: bigint("created_ts", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ratifiedTs: bigint("ratified_ts", { mode: "number" }),
	potSlug: text("pot_slug").notNull(),
}, (table) => [
	index("hive_integration_requests_author_idx").using("btree", table.workspaceId.asc().nullsLast().op("int8_ops"), table.devicePubkey.asc().nullsLast().op("int8_ops"), table.createdTs.asc().nullsLast().op("int8_ops")),
	primaryKey({ columns: [table.workspaceId, table.repoKey, table.devicePubkey, table.headSha, table.potSlug], name: "hive_integration_requests_pkey"}),
	check("hive_integration_requests_reason_check", sql`reason = 'below-steer-tier'::text`),
	check("hive_integration_requests_state_check", sql`state = ANY (ARRAY['pending'::text, 'ratified'::text])`),
]);

export const autoReviewAuditInHarnessShared = harnessShared.table("auto_review_audit", {
	workspaceId: text("workspace_id").default('').notNull(),
	id: bigserial({ mode: "bigint" }).notNull(),
	harnessSlug: text("harness_slug").notNull(),
	prNumber: integer("pr_number").notNull(),
	prUrl: text("pr_url"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	authorGithubId: bigint("author_github_id", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	reviewerGithubId: bigint("reviewer_github_id", { mode: "number" }).notNull(),
	action: text().notNull(),
	detail: text(),
	ts: timestamp({ withTimezone: true }).defaultNow().notNull(),
}, (table) => [
	index("auto_review_audit_pr_idx").using("btree", table.workspaceId.asc().nullsLast().op("int4_ops"), table.harnessSlug.asc().nullsLast().op("int4_ops"), table.prNumber.asc().nullsLast().op("int4_ops"), table.ts.desc().nullsFirst().op("int4_ops")),
	primaryKey({ columns: [table.workspaceId, table.id], name: "auto_review_audit_pkey"}),
	pgPolicy("auto_review_audit_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("auto_review_audit_action_check", sql`action = ANY (ARRAY['auto_approve'::text, 'auto_merge'::text, 'manual_approve'::text, 'manual_merge'::text, 'skipped_untrusted'::text, 'skipped_checks_failing'::text, 'error'::text, 'agent_review'::text, 'agent_review_error'::text])`),
]);

export const coordQuarantineInHarnessShared = harnessShared.table("coord_quarantine", {
	workspaceId: text("workspace_id").default('').notNull(),
	msgId: text("msg_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	surface: text().notNull(),
	body: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	authorGithubUserId: bigint("author_github_user_id", { mode: "number" }),
	authorDevicePubkey: text("author_device_pubkey").notNull(),
	reason: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	msgTs: bigint("msg_ts", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdTs: bigint("created_ts", { mode: "number" }).notNull(),
}, (table) => [
	index("coord_quarantine_author_idx").using("btree", table.workspaceId.asc().nullsLast().op("int8_ops"), table.authorDevicePubkey.asc().nullsLast().op("int8_ops"), table.createdTs.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.workspaceId, table.msgId], name: "coord_quarantine_pkey"}),
	check("coord_quarantine_reason_check", sql`reason = ANY (ARRAY['below-message-tier'::text, 'handoff-below-steer'::text, 'rate-exceeded'::text])`),
]);

export const perfRegressionSnapshotsInHarnessShared = harnessShared.table("perf_regression_snapshots", {
	workspaceId: text("workspace_id").notNull(),
	capturedAt: timestamp("captured_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	loopLagP95Ms: doublePrecision("loop_lag_p95_ms"),
	connSaturationPct: doublePrecision("conn_saturation_pct"),
	dispatchOrphanRate: doublePrecision("dispatch_orphan_rate"),
	dispatchSample: integer("dispatch_sample"),
	coordOpenEscalations: integer("coord_open_escalations"),
	breached: jsonb(),
	advTabSwitchMedianMs: doublePrecision("adv_tab_switch_median_ms"),
	advFcpMs: doublePrecision("adv_fcp_ms"),
}, (table) => [
	index("perf_regression_snapshots_ws_captured_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.capturedAt.desc().nullsFirst().op("text_ops")),
	primaryKey({ columns: [table.workspaceId, table.capturedAt], name: "perf_regression_snapshots_pkey"}),
	pgPolicy("perf_regression_snapshots_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const harnessEscalationsInHarnessShared = harnessShared.table("harness_escalations", {
	harnessSlug: text("harness_slug").notNull(),
	phase: text().default('staging').notNull(),
	escalation: text(),
	supervisorNotes: text("supervisor_notes"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	mtimeMs: bigint("mtime_ms", { mode: "number" }).default(0).notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
	bodyTsv: tsvectorCustom("body_tsv"),
	bodyEmbedding: vector("body_embedding", { dimensions: 384 }),
	riskTier: text("risk_tier"),
	authority: text(),
}, (table) => [
	index("harness_escalations_body_embedding_hnsw").using("hnsw", table.bodyEmbedding.asc().nullsLast().op("vector_cosine_ops")),
	index("harness_escalations_tsv_idx").using("gin", table.bodyTsv.asc().nullsLast().op("tsvector_ops")),
	primaryKey({ columns: [table.harnessSlug, table.phase], name: "harness_escalations_pkey"}),
	pgPolicy("harness_escalations_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("harness_escalations_risk_tier_check", sql`(risk_tier IS NULL) OR (risk_tier = ANY (ARRAY['trivial'::text, 'low'::text, 'moderate'::text, 'high'::text, 'critical'::text]))`),
	check("harness_escalations_authority_check", sql`(authority IS NULL) OR (authority = ANY (ARRAY['system'::text, 'owner'::text]))`),
]);

export const pendingReviewsInHarnessShared = harnessShared.table("pending_reviews", {
	harnessSlug: text("harness_slug").notNull(),
	reviewId: text("review_id").notNull(),
	featureId: text("feature_id"),
	kind: text().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).notNull(),
	resolved: boolean().default(false).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	mtimeMs: bigint("mtime_ms", { mode: "number" }).default(0).notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
	phase: text().default('staging').notNull(),
}, (table) => [
	index("pending_reviews_slug_resolved_ts_idx").using("btree", table.harnessSlug.asc().nullsLast().op("int8_ops"), table.resolved.asc().nullsLast().op("int8_ops"), table.ts.desc().nullsFirst().op("text_ops")),
	index("pending_reviews_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.harnessSlug, table.reviewId, table.phase], name: "pending_reviews_pkey"}),
	pgPolicy("pending_reviews_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const harnessTestsInHarnessShared = harnessShared.table("harness_tests", {
	harnessSlug: text("harness_slug").notNull(),
	phase: text().default('staging').notNull(),
	testId: text("test_id").notNull(),
	name: text().default('').notNull(),
	status: text().default('pending').notNull(),
	durationMs: integer("duration_ms").default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	lastRunTs: bigint("last_run_ts", { mode: "number" }),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	mtimeMs: bigint("mtime_ms", { mode: "number" }).default(0).notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
}, (table) => [
	primaryKey({ columns: [table.harnessSlug, table.phase, table.testId], name: "harness_tests_pkey"}),
	pgPolicy("harness_tests_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const harnessPlanAssertionsInHarnessShared = harnessShared.table("harness_plan_assertions", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	valId: text("val_id").notNull(),
	planSlug: text("plan_slug").notNull(),
	itemId: text("item_id").notNull(),
	verifyText: text("verify_text").notNull(),
	evidenceText: text("evidence_text").default('').notNull(),
	status: text().default('todo').notNull(),
	requiresTest: boolean("requires_test").default(true).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("hpa_plan_item_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.planSlug.asc().nullsLast().op("text_ops"), table.itemId.asc().nullsLast().op("text_ops")),
	index("hpa_requires_test_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops")).where(sql`(NOT requires_test)`),
	primaryKey({ columns: [table.workspaceId, table.harnessSlug, table.valId], name: "harness_plan_assertions_pkey"}),
	pgPolicy("harness_plan_assertions_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("harness_plan_assertions_status_check", sql`status = ANY (ARRAY['todo'::text, 'validating'::text, 'passed'::text, 'failed'::text])`),
]);

export const featureQueueInHarnessShared = harnessShared.table("feature_queue", {
	workspaceId: text("workspace_id").default('').notNull(),
	harnessSlug: text("harness_slug").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	githubUserId: bigint("github_user_id", { mode: "number" }).notNull(),
	featureId: text("feature_id").notNull(),
	queuedAt: timestamp("queued_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	removedAt: timestamp("removed_at", { withTimezone: true, mode: 'string' }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	schemaVersion: bigint("schema_version", { mode: "number" }).default(1).notNull(),
	authorPubkey: text("author_pubkey"),
	origin: text().default('local').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	fedHlc: text("fed_hlc"),
}, (table) => [
	index("feature_queue_feature_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.featureId.asc().nullsLast().op("text_ops")),
	index("feature_queue_user_idx").using("btree", table.workspaceId.asc().nullsLast().op("int8_ops"), table.harnessSlug.asc().nullsLast().op("int8_ops"), table.githubUserId.asc().nullsLast().op("int8_ops")).where(sql`(removed_at IS NULL)`),
	primaryKey({ columns: [table.workspaceId, table.harnessSlug, table.githubUserId, table.featureId], name: "feature_queue_pkey"}),
	pgPolicy("feature_queue_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const harnessDecisionsInHarnessShared = harnessShared.table("harness_decisions", {
	harnessSlug: text("harness_slug").notNull(),
	lineHash: text("line_hash").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).default(0).notNull(),
	iso: text().default('').notNull(),
	verb: text().notNull(),
	args: text().default('').notNull(),
	iteration: integer(),
	isGhost: boolean("is_ghost").default(false).notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
	bodyTsv: tsvectorCustom("body_tsv"),
	bodyEmbedding: vector("body_embedding", { dimensions: 384 }),
}, (table) => [
	index("harness_decisions_body_embedding_hnsw").using("hnsw", table.bodyEmbedding.asc().nullsLast().op("vector_cosine_ops")),
	index("harness_decisions_body_tsv_idx").using("gin", table.bodyTsv.asc().nullsLast().op("tsvector_ops")),
	index("harness_decisions_slug_ts_idx").using("btree", table.harnessSlug.asc().nullsLast().op("int8_ops"), table.ts.asc().nullsLast().op("int8_ops")),
	primaryKey({ columns: [table.harnessSlug, table.lineHash], name: "harness_decisions_pkey"}),
	pgPolicy("harness_decisions_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const contributorUsageEventsInHarnessShared = harnessShared.table("contributor_usage_events", {
	harnessSlug: text("harness_slug").notNull(),
	eventId: text("event_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	githubUserId: bigint("github_user_id", { mode: "number" }).notNull(),
	devicePubkey: text("device_pubkey").notNull(),
	kind: text().notNull(),
	refId: text("ref_id"),
	payload: jsonb(),
	ts: timestamp({ withTimezone: true }).defaultNow().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	schemaVersion: bigint("schema_version", { mode: "number" }).default(1).notNull(),
	origin: text().default('local').notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
}, (table) => [
	index("idx_usage_events_kind").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.kind.asc().nullsLast().op("timestamptz_ops"), table.ts.desc().nullsFirst().op("timestamptz_ops")),
	index("idx_usage_events_user").using("btree", table.harnessSlug.asc().nullsLast().op("int8_ops"), table.githubUserId.asc().nullsLast().op("timestamptz_ops"), table.ts.desc().nullsFirst().op("timestamptz_ops")),
	primaryKey({ columns: [table.harnessSlug, table.eventId], name: "contributor_usage_events_pkey"}),
]);

export const agentFleetsInHarnessShared = harnessShared.table("agent_fleets", {
	workspaceId: text("workspace_id").notNull(),
	fleetSlug: text("fleet_slug").notNull(),
	title: text(),
	description: text(),
	owner: text(),
	leaderOwnerId: text("leader_owner_id"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdAt: bigint("created_at", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
	colorScheme: text("color_scheme"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	lastLaunchAt: bigint("last_launch_at", { mode: "number" }),
	lastLaunchCount: integer("last_launch_count"),
}, (table) => [
	primaryKey({ columns: [table.workspaceId, table.fleetSlug], name: "agent_fleets_pkey"}),
	pgPolicy("agent_fleets_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const resourceAllotmentsInHarnessShared = harnessShared.table("resource_allotments", {
	workspaceId: text("workspace_id").notNull(),
	fleetSlug: text("fleet_slug").notNull(),
	resourceKind: text("resource_kind").notNull(),
	resourceRef: text("resource_ref").notNull(),
	sharePct: integer("share_pct").default(0).notNull(),
	axis: jsonb().default({}).notNull(),
	status: text().default('active').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdByGithubUserId: bigint("created_by_github_user_id", { mode: "number" }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	quantity: integer(),
}, (table) => [
	index("resource_allotments_fleet_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.fleetSlug.asc().nullsLast().op("text_ops")).where(sql`(status = 'active'::text)`),
	index("resource_allotments_ws_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")).where(sql`(status = 'active'::text)`),
	primaryKey({ columns: [table.workspaceId, table.fleetSlug, table.resourceKind, table.resourceRef], name: "resource_allotments_pkey"}),
	check("resource_allotments_ws_nonempty", sql`workspace_id <> ''::text`),
	check("resource_allotments_fleet_nonempty", sql`fleet_slug <> ''::text`),
	check("resource_allotments_ref_nonempty", sql`resource_ref <> ''::text`),
	check("resource_allotments_pct", sql`(share_pct >= 0) AND (share_pct <= 100)`),
	check("resource_allotments_status", sql`status = ANY (ARRAY['active'::text, 'paused'::text])`),
	check("resource_allotments_kind", sql`resource_kind = ANY (ARRAY['account'::text, 'gpu'::text, 'agent_slot'::text])`),
	check("resource_allotments_quantity", sql`((resource_kind = 'agent_slot'::text) AND (quantity IS NOT NULL) AND (quantity >= 1) AND (quantity <= 1000)) OR ((resource_kind <> 'agent_slot'::text) AND (quantity IS NULL))`),
]);

export const harnessPendingIssuesInHarnessShared = harnessShared.table("harness_pending_issues", {
	harnessSlug: text("harness_slug").notNull(),
	phase: text().default('staging').notNull(),
	issueId: text("issue_id").notNull(),
	featureId: text("feature_id"),
	title: text().default('').notNull(),
	severity: text().default('normal').notNull(),
	source: text().default('').notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	mtimeMs: bigint("mtime_ms", { mode: "number" }).default(0).notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
}, (table) => [
	primaryKey({ columns: [table.harnessSlug, table.phase, table.issueId], name: "harness_pending_issues_pkey"}),
	pgPolicy("harness_pending_issues_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const featureWorkingSetInHarnessShared = harnessShared.table("feature_working_set", {
	workspaceId: text("workspace_id").default('').notNull(),
	harnessSlug: text("harness_slug").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	githubUserId: bigint("github_user_id", { mode: "number" }).notNull(),
	featureId: text("feature_id").notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	clearedAt: timestamp("cleared_at", { withTimezone: true, mode: 'string' }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	schemaVersion: bigint("schema_version", { mode: "number" }).default(1).notNull(),
	authorPubkey: text("author_pubkey"),
	origin: text().default('local').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	fedHlc: text("fed_hlc"),
}, (table) => [
	index("feature_working_set_feature_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.featureId.asc().nullsLast().op("text_ops")).where(sql`(cleared_at IS NULL)`),
	index("feature_working_set_user_idx").using("btree", table.workspaceId.asc().nullsLast().op("int8_ops"), table.harnessSlug.asc().nullsLast().op("int8_ops"), table.githubUserId.asc().nullsLast().op("int8_ops")).where(sql`(cleared_at IS NULL)`),
	primaryKey({ columns: [table.workspaceId, table.harnessSlug, table.githubUserId, table.featureId], name: "feature_working_set_pkey"}),
	pgPolicy("feature_working_set_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const learningGovernorLoopsInHarnessShared = harnessShared.table("learning_governor_loops", {
	workspaceId: text("workspace_id").notNull(),
	loopId: text("loop_id").notNull(),
	displayName: text("display_name").notNull(),
	budgetKind: text("budget_kind").default('lifetime').notNull(),
	budgetUsd: numeric("budget_usd"),
	spentUsd: numeric("spent_usd").default('0').notNull(),
	priority: integer().default(100).notNull(),
	enabled: boolean().default(true).notNull(),
	enforcement: text().default('governor').notNull(),
	meta: jsonb(),
	registeredAt: timestamp("registered_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspaceId, table.loopId], name: "learning_governor_loops_pkey"}),
	pgPolicy("learning_governor_loops_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const harnessRunOutputInHarnessShared = harnessShared.table("harness_run_output", {
	workspaceId: text("workspace_id").default('default').notNull(),
	harnessSlug: text("harness_slug").notNull(),
	runId: text("run_id").notNull(),
	role: text(),
	promptBody: text("prompt_body").default('').notNull(),
	jsonlBody: text("jsonl_body").default('').notNull(),
	outBody: text("out_body").default('').notNull(),
	errBody: text("err_body").default('').notNull(),
	exitCode: integer("exit_code"),
	durationMs: integer("duration_ms"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	startedAt: bigint("started_at", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	endedAt: bigint("ended_at", { mode: "number" }).notNull(),
}, (table) => [
	index("harness_run_output_recent_idx").using("btree", table.workspaceId.asc().nullsLast().op("int8_ops"), table.harnessSlug.asc().nullsLast().op("int8_ops"), table.endedAt.desc().nullsFirst().op("int8_ops")),
	primaryKey({ columns: [table.workspaceId, table.harnessSlug, table.runId], name: "harness_run_output_pkey"}),
	pgPolicy("harness_run_output_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const hiveEpochKeysInHarnessShared = harnessShared.table("hive_epoch_keys", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	epoch: integer().notNull(),
	memberDevicePubkey: text("member_device_pubkey").notNull(),
	wrappedKey: text("wrapped_key").notNull(),
	authorPubkey: text("author_pubkey"),
	origin: text().default('local').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	fedHlc: text("fed_hlc"),
	epochKeyFedKey: text("epoch_key_fed_key").generatedAlwaysAs(sql`(((epoch)::text || ':'::text) || member_device_pubkey)`),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdAt: bigint("created_at", { mode: "number" }).default(sql`(EXTRACT(epoch FROM now()) * 1000)::bigint`).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(sql`(EXTRACT(epoch FROM now()) * 1000)::bigint`).notNull(),
}, (table) => [
	index("hive_epoch_keys_by_member").using("btree", table.workspaceId.asc().nullsLast().op("int4_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.memberDevicePubkey.asc().nullsLast().op("text_ops"), table.epoch.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.workspaceId, table.harnessSlug, table.epoch, table.memberDevicePubkey], name: "hive_epoch_keys_pkey"}),
	pgPolicy("hive_epoch_keys_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const hivePolicyInHarnessShared = harnessShared.table("hive_policy", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	policyJson: text("policy_json").notNull(),
	ownerPubkey: text("owner_pubkey").notNull(),
	signature: text().notNull(),
	policyVersion: integer("policy_version").default(1).notNull(),
	authorPubkey: text("author_pubkey"),
	origin: text().default('local').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	fedHlc: text("fed_hlc"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdAt: bigint("created_at", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspaceId, table.harnessSlug], name: "hive_policy_pkey"}),
	pgPolicy("hive_policy_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const fleetEkgSessionsInHarnessShared = harnessShared.table("fleet_ekg_sessions", {
	workspaceId: text("workspace_id").notNull(),
	ownerId: text("owner_id").notNull(),
	sessionId: text("session_id").notNull(),
	agent: text(),
	harnessSlug: text("harness_slug"),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).notNull(),
	endedAt: timestamp("ended_at", { withTimezone: true, mode: 'string' }).notNull(),
	eventCount: integer("event_count").notNull(),
	features: jsonb().notNull(),
	toolMix: jsonb("tool_mix").notNull(),
	bigrams: jsonb().notNull(),
	computedAt: timestamp("computed_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("fleet_ekg_sessions_ended_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.endedAt.asc().nullsLast().op("timestamptz_ops")),
	primaryKey({ columns: [table.workspaceId, table.ownerId, table.sessionId], name: "fleet_ekg_sessions_pkey"}),
	check("fleet_ekg_sessions_event_count_check", sql`event_count > 0`),
]);

export const beeClaimSpecsInHarnessShared = harnessShared.table("bee_claim_specs", {
	workspaceId: text("workspace_id").default('default').notNull(),
	beeId: text("bee_id").notNull(),
	spec: jsonb().notNull(),
	revision: integer().default(0).notNull(),
	updatedBy: text("updated_by"),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	idOnly: boolean("id_only").default(false).notNull(),
	harnessSlug: text("harness_slug"),
	origin: text().default('local').notNull(),
	authorPubkey: text("author_pubkey"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	fedHlc: text("fed_hlc"),
}, (table) => [
	primaryKey({ columns: [table.workspaceId, table.beeId], name: "bee_claim_specs_pkey"}),
	pgPolicy("bee_claim_specs_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("bee_claim_specs_bee_nonempty", sql`bee_id <> ''::text`),
	check("bee_claim_specs_ws_nonempty", sql`workspace_id <> ''::text`),
]);

export const crossHiveOutboxInHarnessShared = harnessShared.table("cross_hive_outbox", {
	workspaceId: text("workspace_id").notNull(),
	id: text().notNull(),
	fromHivePubkey: text("from_hive_pubkey").notNull(),
	toHivePubkey: text("to_hive_pubkey").notNull(),
	kind: text().notNull(),
	subject: text().default('').notNull(),
	body: text().default('').notNull(),
	correlationId: text("correlation_id"),
	sig: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdAt: bigint("created_at", { mode: "number" }).default(0).notNull(),
	attemptCount: integer("attempt_count").default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	lastAttemptAt: bigint("last_attempt_at", { mode: "number" }).default(0).notNull(),
	potSlug: text("pot_slug").notNull(),
}, (table) => [
	index("cross_hive_outbox_pending_pot_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.potSlug.asc().nullsLast().op("text_ops"), table.createdAt.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.workspaceId, table.id, table.potSlug], name: "cross_hive_outbox_pkey"}),
	check("cross_hive_outbox_workspace_nonempty", sql`workspace_id <> ''::text`),
	check("cross_hive_outbox_kind_check", sql`kind = ANY (ARRAY['ask'::text, 'work-request'::text, 'answer'::text, 'decline'::text])`),
]);

export const agentChatsConsolidatedInHarnessShared = harnessShared.table("agent_chats_consolidated", {
	workspaceId: text("workspace_id").default('').notNull(),
	harnessSlug: text("harness_slug").notNull(),
	id: text().notNull(),
	role: text().notNull(),
	featureId: text("feature_id"),
	title: text(),
	transcript: jsonb().default([]).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	totalInputTokens: bigint("total_input_tokens", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	totalOutputTokens: bigint("total_output_tokens", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	totalCostUsdCents: bigint("total_cost_usd_cents", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdAt: bigint("created_at", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	archivedAt: bigint("archived_at", { mode: "number" }),
}, (table) => [
	index("agent_chats_consolidated_recent_idx").using("btree", table.workspaceId.asc().nullsLast().op("int8_ops"), table.harnessSlug.asc().nullsLast().op("int8_ops"), table.updatedAt.desc().nullsFirst().op("int8_ops")),
	primaryKey({ columns: [table.workspaceId, table.harnessSlug, table.id], name: "agent_chats_consolidated_pkey"}),
	pgPolicy("agent_chats_consolidated_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const slotParkedMessagesInHarnessShared = harnessShared.table("slot_parked_messages", {
	id: text().notNull(),
	workspaceId: text("workspace_id").notNull(),
	slotKind: text("slot_kind").notNull(),
	slotRef: text("slot_ref").notNull(),
	harnessSlug: text("harness_slug"),
	fromOwner: text("from_owner").notNull(),
	envelope: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdTs: bigint("created_ts", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ttlMs: bigint("ttl_ms", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	deliveredTs: bigint("delivered_ts", { mode: "number" }),
	deliveredTo: text("delivered_to"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	droppedTs: bigint("dropped_ts", { mode: "number" }),
	droppedReason: text("dropped_reason"),
}, (table) => [
	index("slot_parked_messages_pending_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.slotKind.asc().nullsLast().op("text_ops"), table.slotRef.asc().nullsLast().op("text_ops")).where(sql`((delivered_ts IS NULL) AND (dropped_ts IS NULL))`),
	primaryKey({ columns: [table.id, table.workspaceId], name: "slot_parked_messages_pkey"}),
	pgPolicy("slot_parked_messages_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const sessionTurnsInHarnessShared = harnessShared.table("session_turns", {
	workspaceId: text("workspace_id").default('default').notNull(),
	sourceKind: text("source_kind").notNull(),
	sessionId: text("session_id").notNull(),
	turnIdx: integer("turn_idx").notNull(),
	ts: timestamp({ withTimezone: true }),
	owner: text(),
	harnessSlug: text("harness_slug"),
	cwd: text(),
	speaker: text().notNull(),
	text: text().notNull(),
	textTsv: tsvectorCustom("text_tsv").generatedAlwaysAs(sql`to_tsvector('english'::regconfig, "left"(text, 20000))`),
	ingestedAt: timestamp("ingested_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	textEmbedding: vector("text_embedding", { dimensions: 384 }),
}, (table) => [
	index("session_turns_embedding_idx").using("hnsw", table.textEmbedding.asc().nullsLast().op("vector_cosine_ops")),
	index("session_turns_ingested_idx").using("btree", table.ingestedAt.asc().nullsLast().op("timestamptz_ops")),
	index("session_turns_owner_ts_idx").using("btree", table.owner.asc().nullsLast().op("timestamptz_ops"), table.ts.asc().nullsLast().op("timestamptz_ops")),
	index("session_turns_session_idx").using("btree", table.sessionId.asc().nullsLast().op("text_ops")),
	index("session_turns_tsv_idx").using("gin", table.textTsv.asc().nullsLast().op("tsvector_ops")),
	primaryKey({ columns: [table.workspaceId, table.sourceKind, table.sessionId, table.turnIdx], name: "session_turns_pkey"}),
]);

export const workItemClaimsInHarnessShared = harnessShared.table("work_item_claims", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	workItemId: text("work_item_id").notNull(),
	claimId: uuid("claim_id").defaultRandom().notNull(),
	owner: text().notNull(),
	ownerLabel: text("owner_label"),
	holderPubkey: text("holder_pubkey"),
	intent: text().default('').notNull(),
	ttlSec: integer("ttl_sec").default(1800).notNull(),
	acquiredTs: timestamp("acquired_ts", { withTimezone: true, mode: 'string' }).default(sql`clock_timestamp()`).notNull(),
	expiresTs: timestamp("expires_ts", { withTimezone: true, mode: 'string' }).notNull(),
	lastActivityTs: timestamp("last_activity_ts", { withTimezone: true, mode: 'string' }).default(sql`clock_timestamp()`).notNull(),
	potSlug: text("pot_slug"),
}, (table) => [
	index("work_item_claims_expires_idx").using("btree", table.expiresTs.asc().nullsLast().op("timestamptz_ops")),
	index("work_item_claims_owner_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.owner.asc().nullsLast().op("text_ops")),
	index("work_item_claims_pot_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.potSlug.asc().nullsLast().op("text_ops")).where(sql`(pot_slug IS NOT NULL)`),
	primaryKey({ columns: [table.workspaceId, table.harnessSlug, table.workItemId], name: "work_item_claims_pkey"}),
	check("work_item_claims_workspace_nonempty", sql`workspace_id <> ''::text`),
	check("work_item_claims_owner_nonempty", sql`owner <> ''::text`),
]);

export const harnessStatusInHarnessShared = harnessShared.table("harness_status", {
	harnessSlug: text("harness_slug").notNull(),
	phase: text().default('staging').notNull(),
	status: text().notNull(),
	iteration: integer().default(0).notNull(),
	totalFeatures: integer("total_features").default(0).notNull(),
	passedCount: integer("passed_count").default(0).notNull(),
	todoCount: integer("todo_count").default(0).notNull(),
	blockedCount: integer("blocked_count").default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	lastActiveTs: bigint("last_active_ts", { mode: "number" }),
	costUsd: numeric("cost_usd", { precision: 10, scale:  4 }),
	workspaceId: text("workspace_id").default('').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	expiresAt: bigint("expires_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	index("harness_status_expires_idx").using("btree", table.expiresAt.asc().nullsLast().op("int8_ops")),
	index("harness_status_updated_idx").using("btree", table.updatedAt.asc().nullsLast().op("int8_ops")),
	index("harness_status_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.harnessSlug, table.phase], name: "harness_status_pkey"}),
	pgPolicy("harness_status_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("harness_status_status_check", sql`status = ANY (ARRAY['idle'::text, 'running'::text, 'stalled'::text, 'paused'::text, 'error'::text])`),
]);

export const planItemClaimsInHarnessShared = harnessShared.table("plan_item_claims", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	planSlug: text("plan_slug").notNull(),
	itemId: text("item_id").notNull(),
	claimId: uuid("claim_id").defaultRandom().notNull(),
	owner: text().notNull(),
	ownerLabel: text("owner_label"),
	ownerName: text("owner_name"),
	intent: text().default('').notNull(),
	livenessMode: text("liveness_mode").default('availability').notNull(),
	ttlSec: integer("ttl_sec").default(1200).notNull(),
	acquiredTs: timestamp("acquired_ts", { withTimezone: true, mode: 'string' }).default(sql`clock_timestamp()`).notNull(),
	expiresTs: timestamp("expires_ts", { withTimezone: true, mode: 'string' }).notNull(),
	lastActivityTs: timestamp("last_activity_ts", { withTimezone: true, mode: 'string' }).default(sql`clock_timestamp()`).notNull(),
}, (table) => [
	index("plan_item_claims_expires_idx").using("btree", table.expiresTs.asc().nullsLast().op("timestamptz_ops")),
	index("plan_item_claims_name_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.ownerName.asc().nullsLast().op("text_ops")).where(sql`(owner_name IS NOT NULL)`),
	index("plan_item_claims_owner_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.owner.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.workspaceId, table.harnessSlug, table.planSlug, table.itemId], name: "plan_item_claims_pkey"}),
	check("plan_item_claims_mode_check", sql`liveness_mode = ANY (ARRAY['availability'::text, 'activity'::text])`),
	check("plan_item_claims_workspace_nonempty", sql`workspace_id <> ''::text`),
	check("plan_item_claims_owner_nonempty", sql`owner <> ''::text`),
]);

export const coordThreadsInHarnessShared = harnessShared.table("coord_threads", {
	workspaceId: text("workspace_id").default('default').notNull(),
	threadId: text("thread_id").notNull(),
	parentKind: text("parent_kind").notNull(),
	parentRef: text("parent_ref").notNull(),
	title: text(),
	createdBy: text("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lastPostAt: timestamp("last_post_at", { withTimezone: true, mode: 'string' }),
	postCount: integer("post_count").default(0).notNull(),
	harnessSlug: text("harness_slug"),
	origin: text().default('local').notNull(),
	authorPubkey: text("author_pubkey"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	fedHlc: text("fed_hlc"),
}, (table) => [
	uniqueIndex("coord_threads_fed_uq").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.threadId.asc().nullsLast().op("text_ops")).where(sql`(harness_slug IS NOT NULL)`),
	uniqueIndex("coord_threads_parent_uq").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.parentKind.asc().nullsLast().op("text_ops"), table.parentRef.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.workspaceId, table.threadId], name: "coord_threads_pkey"}),
	check("coord_threads_parent_nonempty", sql`(parent_ref <> ''::text) AND (parent_kind <> ''::text)`),
	check("coord_threads_workspace_nonempty", sql`workspace_id <> ''::text`),
]);

export const p2PForeignWorkspacesInHarnessShared = harnessShared.table("p2p_foreign_workspaces", {
	workspaceId: text("workspace_id").notNull(),
	offerId: text("offer_id").notNull(),
	fleetSlug: text("fleet_slug").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	originGithubUserId: bigint("origin_github_user_id", { mode: "number" }).notNull(),
	executorDevice: text("executor_device").notNull(),
	rootPath: text("root_path").notNull(),
	clonePath: text("clone_path").notNull(),
	sessionId: text("session_id"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	executionEpoch: bigint("execution_epoch", { mode: "number" }).default(0).notNull(),
	state: text().default('provisioning').notNull(),
	parkReason: text("park_reason"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	baseSha: text("base_sha"),
}, (table) => [
	uniqueIndex("p2p_foreign_workspaces_root_path_key").using("btree", table.rootPath.asc().nullsLast().op("text_ops")),
	index("p2p_foreign_workspaces_session_idx").using("btree", table.sessionId.asc().nullsLast().op("text_ops")).where(sql`(session_id IS NOT NULL)`),
	index("p2p_foreign_workspaces_state_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.state.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.workspaceId, table.offerId], name: "p2p_foreign_workspaces_pkey"}),
	check("p2p_foreign_workspaces_state_check", sql`state = ANY (ARRAY['provisioning'::text, 'active'::text, 'winding-down'::text, 'parked'::text, 'reaped'::text])`),
]);

export const harnessChunkPlansInHarnessShared = harnessShared.table("harness_chunk_plans", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	featureId: text("feature_id").notNull(),
	chunkId: text("chunk_id").notNull(),
	chunkIndex: integer("chunk_index").notNull(),
	files: jsonb().notNull(),
	description: text().notNull(),
	status: text().default('pending').notNull(),
	strikes: integer().default(0).notNull(),
	lastError: text("last_error"),
	commitSha: text("commit_sha"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdTs: bigint("created_ts", { mode: "number" }).default(sql`(EXTRACT(epoch FROM now()) * 1000)::bigint`).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedTs: bigint("updated_ts", { mode: "number" }).default(sql`(EXTRACT(epoch FROM now()) * 1000)::bigint`).notNull(),
	spawnedBySpawnId: text("spawned_by_spawn_id"),
}, (table) => [
	index("chunk_plans_by_spawned_by").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.spawnedBySpawnId.asc().nullsLast().op("text_ops")).where(sql`(spawned_by_spawn_id IS NOT NULL)`),
	index("idx_chunk_plans_by_feature").using("btree", table.workspaceId.asc().nullsLast().op("int4_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.featureId.asc().nullsLast().op("text_ops"), table.chunkIndex.asc().nullsLast().op("int4_ops")),
	index("idx_chunk_plans_by_status").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")).where(sql`(status = ANY (ARRAY['in_progress'::text, 'failing'::text, 'escalated'::text]))`),
	primaryKey({ columns: [table.workspaceId, table.harnessSlug, table.featureId, table.chunkId], name: "harness_chunk_plans_pkey"}),
	pgPolicy("chunk_plans_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const experimentRunsInHarnessShared = harnessShared.table("experiment_runs", {
	workspaceId: text("workspace_id").notNull(),
	batteryId: text("battery_id").notNull(),
	testId: text("test_id").notNull(),
	tier: text().notNull(),
	arms: jsonb().default([]).notNull(),
	baselineId: text("baseline_id").notNull(),
	winner: text(),
	comparison: jsonb(),
	totalCostUsd: numeric("total_cost_usd").default('0').notNull(),
	budgetExhausted: boolean("budget_exhausted").default(false).notNull(),
	decision: text().default('proposed').notNull(),
	signalOrigin: text("signal_origin").default('replay').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("experiment_runs_ws_created_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	index("experiment_runs_ws_test_idx").using("btree", table.workspaceId.asc().nullsLast().op("timestamptz_ops"), table.testId.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("text_ops")),
	primaryKey({ columns: [table.workspaceId, table.batteryId], name: "experiment_runs_pkey"}),
	pgPolicy("experiment_runs_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("experiment_runs_tier_check", sql`tier = ANY (ARRAY['offline'::text, 'shadow'::text, 'live'::text])`),
	check("experiment_runs_decision_check", sql`decision = ANY (ARRAY['proposed'::text, 'applied'::text, 'rejected'::text])`),
	check("experiment_runs_signal_origin_check", sql`signal_origin = ANY (ARRAY['organic'::text, 'drill'::text, 'replay'::text, 'shadow'::text])`),
]);

export const sharedSessionPresenceInHarnessShared = harnessShared.table("shared_session_presence", {
	workspaceId: text("workspace_id").default('').notNull(),
	harnessSlug: text("harness_slug").notNull(),
	ownerId: text("owner_id").notNull(),
	kind: text().default('su').notNull(),
	intent: text(),
	planSlug: text("plan_slug"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	githubUserId: bigint("github_user_id", { mode: "number" }).notNull(),
	machineLabel: text("machine_label").notNull(),
	devicePubkey: text("device_pubkey").notNull(),
	lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	schemaVersion: bigint("schema_version", { mode: "number" }).default(1).notNull(),
	fleetSlug: text("fleet_slug"),
	fleetRole: text("fleet_role"),
	potSlug: text("pot_slug"),
}, (table) => [
	index("shared_session_presence_device_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.devicePubkey.asc().nullsLast().op("text_ops")),
	index("shared_session_presence_fleet_idx").using("btree", table.workspaceId.asc().nullsLast().op("timestamptz_ops"), table.fleetSlug.asc().nullsLast().op("text_ops"), table.lastSeenAt.desc().nullsFirst().op("timestamptz_ops")).where(sql`(fleet_slug IS NOT NULL)`),
	index("shared_session_presence_pot_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.potSlug.asc().nullsLast().op("text_ops"), table.lastSeenAt.desc().nullsFirst().op("text_ops")).where(sql`(pot_slug IS NOT NULL)`),
	primaryKey({ columns: [table.workspaceId, table.ownerId, table.machineLabel], name: "shared_session_presence_pkey"}),
]);

export const harnessProposalsSharedInHarnessShared = harnessShared.table("harness_proposals_shared", {
	harnessSlug: text("harness_slug").notNull(),
	proposalId: text("proposal_id").notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	mtimeMs: bigint("mtime_ms", { mode: "number" }).default(0).notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
	phase: text().default('staging').notNull(),
	status: text().default('pending').notNull(),
	reviewVerdict: text("review_verdict"),
	reviewSummary: text("review_summary"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	reviewedAt: bigint("reviewed_at", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	appliedAt: bigint("applied_at", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	rejectedAt: bigint("rejected_at", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	sizeBytes: bigint("size_bytes", { mode: "number" }).default(0).notNull(),
}, (table) => [
	index("harness_proposals_shared_slug_ts_idx").using("btree", table.harnessSlug.asc().nullsLast().op("int8_ops"), table.ts.desc().nullsFirst().op("text_ops")),
	index("harness_proposals_shared_status_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")),
	index("harness_proposals_shared_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.harnessSlug, table.proposalId, table.phase], name: "harness_proposals_shared_pkey"}),
	pgPolicy("harness_proposals_shared_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const messagesConsolidatedInHarnessShared = harnessShared.table("messages_consolidated", {
	workspaceId: text("workspace_id").default('default').notNull(),
	harnessSlug: text("harness_slug").notNull(),
	id: uuid().defaultRandom().notNull(),
	fromSlug: text("from_slug"),
	toSlug: text("to_slug"),
	kind: text(),
	subject: text(),
	body: text(),
	parentMessageId: uuid("parent_message_id"),
	status: text().default('pending').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true, mode: 'string' }),
	toRole: text("to_role"),
	fromFeatureId: text("from_feature_id"),
	toFeatureId: text("to_feature_id"),
}, (table) => [
	index("messages_consolidated_recent_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("text_ops")),
	primaryKey({ columns: [table.harnessSlug, table.id], name: "messages_consolidated_pkey"}),
]);

export const fleetGovernorInHarnessShared = harnessShared.table("fleet_governor", {
	workspaceId: text("workspace_id").notNull(),
	kind: text().notNull(),
	scopeKey: text("scope_key").notNull(),
	capacity: numeric(),
	refillPerSec: numeric("refill_per_sec"),
	tokens: numeric(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }),
	cbState: text("cb_state"),
	cbFailures: integer("cb_failures").default(0).notNull(),
	cbThreshold: integer("cb_threshold"),
	cbCooldownSec: integer("cb_cooldown_sec"),
	cbOpenedAt: timestamp("cb_opened_at", { withTimezone: true, mode: 'string' }),
	credits: integer(),
	creditMax: integer("credit_max"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspaceId, table.kind, table.scopeKey], name: "fleet_governor_pkey"}),
	check("fleet_governor_kind_chk", sql`kind = ANY (ARRAY['bucket'::text, 'circuit'::text, 'credit'::text])`),
]);

export const hiveEvalScoresInHarnessShared = harnessShared.table("hive_eval_scores", {
	runId: text("run_id").notNull(),
	rubricHash: text("rubric_hash").notNull(),
	rubricVersion: text("rubric_version").notNull(),
	outcomeGatePassed: boolean("outcome_gate_passed").notNull(),
	efficiencyScore: numeric("efficiency_score").notNull(),
	speedScore: numeric("speed_score").notNull(),
	composite: numeric().notNull(),
	judgeComposite: numeric("judge_composite"),
	regressions: boolean().notNull(),
	plantedBugCaught: boolean("planted_bug_caught").notNull(),
	fabricationDetected: boolean("fabrication_detected").notNull(),
	criticalPathRatio: numeric("critical_path_ratio").notNull(),
	floorCeiling: numeric("floor_ceiling").notNull(),
	detail: jsonb().notNull(),
	scoredAt: timestamp("scored_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("hive_eval_scores_composite_idx").using("btree", table.composite.asc().nullsLast().op("numeric_ops")),
	index("hive_eval_scores_run_idx").using("btree", table.runId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.runId],
			foreignColumns: [hiveEvalRunsInHarnessShared.runId],
			name: "hive_eval_scores_run_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.runId, table.rubricHash], name: "hive_eval_scores_pkey"}),
]);

export const harnessPlanPartsInHarnessShared = harnessShared.table("harness_plan_parts", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	planSlug: text("plan_slug").notNull(),
	partKey: text("part_key").notNull(),
	kind: text().notNull(),
	body: text().default('').notNull(),
	ordinal: integer().default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }).notNull(),
	author: text(),
	tombstone: boolean().default(false).notNull(),
	origin: text().default('local').notNull(),
	partFedKey: text("part_fed_key").generatedAlwaysAs(sql`((plan_slug || '/'::text) || part_key)`),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdAt: bigint("created_at", { mode: "number" }).default(sql`(EXTRACT(epoch FROM now()) * 1000)::bigint`).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(sql`(EXTRACT(epoch FROM now()) * 1000)::bigint`).notNull(),
	fedHlc: text("fed_hlc"),
}, (table) => [
	index("harness_plan_parts_by_plan").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.planSlug.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.workspaceId, table.harnessSlug, table.planSlug, table.partKey], name: "harness_plan_parts_pkey"}),
	pgPolicy("harness_plan_parts_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const hiveReportsInHarnessShared = harnessShared.table("hive_reports", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	reportId: text("report_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	reporterGithubUserId: bigint("reporter_github_user_id", { mode: "number" }).notNull(),
	reporterGithubUsername: text("reporter_github_username"),
	targetKind: text("target_kind").notNull(),
	targetRef: text("target_ref").notNull(),
	reportReason: text("report_reason"),
	status: text().default('open').notNull(),
	authorPubkey: text("author_pubkey"),
	origin: text().default('local').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	fedHlc: text("fed_hlc"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdAt: bigint("created_at", { mode: "number" }).default(sql`(EXTRACT(epoch FROM now()) * 1000)::bigint`).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(sql`(EXTRACT(epoch FROM now()) * 1000)::bigint`).notNull(),
}, (table) => [
	index("hive_reports_by_status").using("btree", table.workspaceId.asc().nullsLast().op("int8_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("text_ops")),
	primaryKey({ columns: [table.workspaceId, table.harnessSlug, table.reportId], name: "hive_reports_pkey"}),
	pgPolicy("hive_reports_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const sharedPresenceInHarnessShared = harnessShared.table("shared_presence", {
	workspaceId: text("workspace_id").default('').notNull(),
	harnessSlug: text("harness_slug").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	githubUserId: bigint("github_user_id", { mode: "number" }).notNull(),
	machineLabel: text("machine_label").notNull(),
	devicePubkey: text("device_pubkey").notNull(),
	intent: text(),
	currentView: text("current_view"),
	lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	schemaVersion: bigint("schema_version", { mode: "number" }).default(1).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	fedHlc: text("fed_hlc"),
	fleetSlug: text("fleet_slug"),
	fleetRole: text("fleet_role"),
	authorPubkey: text("author_pubkey"),
	potSlug: text("pot_slug"),
}, (table) => [
	index("shared_presence_fleet_recent_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.fleetSlug.asc().nullsLast().op("text_ops"), table.lastSeenAt.desc().nullsFirst().op("text_ops")),
	index("shared_presence_pot_recent_idx").using("btree", table.workspaceId.asc().nullsLast().op("timestamptz_ops"), table.potSlug.asc().nullsLast().op("text_ops"), table.lastSeenAt.desc().nullsFirst().op("timestamptz_ops")),
	index("shared_presence_recent_idx").using("btree", table.workspaceId.asc().nullsLast().op("timestamptz_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.lastSeenAt.desc().nullsFirst().op("text_ops")),
	index("shared_presence_user_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("int8_ops"), table.githubUserId.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.workspaceId, table.harnessSlug, table.githubUserId, table.machineLabel], name: "shared_presence_pkey"}),
	pgPolicy("shared_presence_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const regretFindingsInHarnessShared = harnessShared.table("regret_findings", {
	workspaceId: text("workspace_id").notNull(),
	runId: text("run_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	role: text(),
	badnessScore: doublePrecision("badness_score").notNull(),
	badnessReasons: jsonb("badness_reasons").default([]).notNull(),
	divergenceTurn: integer("divergence_turn"),
	divergenceKind: text("divergence_kind"),
	divergenceEvidence: jsonb("divergence_evidence"),
	candidateChanges: jsonb("candidate_changes").default([]).notNull(),
	replayStatus: text("replay_status").default('pending').notNull(),
	replayScores: jsonb("replay_scores"),
	reportImprovementId: text("report_improvement_id"),
	minedAt: timestamp("mined_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("regret_findings_pending_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.minedAt.desc().nullsFirst().op("text_ops")).where(sql`(replay_status = 'pending'::text)`),
	primaryKey({ columns: [table.workspaceId, table.runId], name: "regret_findings_pkey"}),
	check("regret_findings_replay_status_check", sql`replay_status = ANY (ARRAY['pending'::text, 'replayed'::text, 'skipped'::text])`),
	check("regret_findings_divergence_kind_check", sql`(divergence_kind IS NULL) OR (divergence_kind = ANY (ARRAY['error-loop'::text, 'repeat-loop'::text, 'burn-inflection'::text, 'rescue-marker'::text]))`),
]);

export const p2PFleetLeaderLeasesInHarnessShared = harnessShared.table("p2p_fleet_leader_leases", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ownerGithubUserId: bigint("owner_github_user_id", { mode: "number" }).notNull(),
	fleetSlug: text("fleet_slug").notNull(),
	devicePubkey: text("device_pubkey").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	leaderGithubUserId: bigint("leader_github_user_id", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	sinceMs: bigint("since_ms", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	rosterEpoch: bigint("roster_epoch", { mode: "number" }).default(0).notNull(),
	leaderLeaseFedKey: text("leader_lease_fed_key").generatedAlwaysAs(sql`(((owner_github_user_id)::text || '/'::text) || fleet_slug)`),
	authorPubkey: text("author_pubkey"),
	origin: text().default('local').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	fedHlc: text("fed_hlc"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdAt: bigint("created_at", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	index("p2p_fleet_leader_leases_hive_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.workspaceId, table.harnessSlug, table.ownerGithubUserId, table.fleetSlug], name: "p2p_fleet_leader_leases_pkey"}),
	pgPolicy("p2p_fleet_leader_leases_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("p2p_fleet_leader_leases_owner_positive", sql`(owner_github_user_id > 0) AND (leader_github_user_id > 0)`),
	check("p2p_fleet_leader_leases_epoch_nonnegative", sql`(since_ms >= 0) AND (roster_epoch >= 0)`),
]);

export const gymQdArchiveInHarnessShared = harnessShared.table("gym_qd_archive", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	nicheKey: text("niche_key").notNull(),
	candidateId: text("candidate_id").notNull(),
	scope: text().notNull(),
	domain: text().notNull(),
	risk: text().notNull(),
	fitness: doublePrecision().notNull(),
	descriptor: jsonb().notNull(),
	source: text().default('gym').notNull(),
	rationale: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdAt: bigint("created_at", { mode: "number" }).default(sql`(EXTRACT(epoch FROM now()) * 1000)::bigint`).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
	federatable: boolean().default(false).notNull(),
	outcomeRecord: jsonb("outcome_record"),
}, (table) => [
	index("gym_qd_archive_candidate_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.candidateId.asc().nullsLast().op("text_ops")),
	index("gym_qd_archive_source_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.source.asc().nullsLast().op("text_ops")),
	index("gym_qd_archive_ws_harness_fitness_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.fitness.desc().nullsFirst().op("text_ops")),
	primaryKey({ columns: [table.workspaceId, table.harnessSlug, table.nicheKey], name: "gym_qd_archive_pkey"}),
	pgPolicy("gym_qd_archive_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const prReviewReportsInHarnessShared = harnessShared.table("pr_review_reports", {
	workspaceId: text("workspace_id").default('').notNull(),
	harnessSlug: text("harness_slug").notNull(),
	prNumber: integer("pr_number").notNull(),
	prUrl: text("pr_url").notNull(),
	headSha: text("head_sha").default('').notNull(),
	featureId: text("feature_id"),
	recommendation: text().notNull(),
	summary: text().notNull(),
	rationale: text().notNull(),
	risks: jsonb().default([]).notNull(),
	checksObserved: jsonb("checks_observed").default({}).notNull(),
	model: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	tokensIn: bigint("tokens_in", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	tokensOut: bigint("tokens_out", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	costUsdCents: bigint("cost_usd_cents", { mode: "number" }).default(0).notNull(),
	reviewedAt: timestamp("reviewed_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("pr_review_reports_pr_idx").using("btree", table.workspaceId.asc().nullsLast().op("int4_ops"), table.harnessSlug.asc().nullsLast().op("int4_ops"), table.prNumber.asc().nullsLast().op("int4_ops"), table.reviewedAt.desc().nullsFirst().op("int4_ops")),
	primaryKey({ columns: [table.workspaceId, table.harnessSlug, table.prNumber, table.headSha], name: "pr_review_reports_pkey"}),
	pgPolicy("pr_review_reports_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("pr_review_reports_recommendation_check", sql`recommendation = ANY (ARRAY['approve'::text, 'request_changes'::text, 'reject'::text])`),
]);

export const p2PFleetDirectoryInHarnessShared = harnessShared.table("p2p_fleet_directory", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ownerGithubUserId: bigint("owner_github_user_id", { mode: "number" }).notNull(),
	fleetSlug: text("fleet_slug").notNull(),
	recordJson: text("record_json").notNull(),
	signerDevicePubkey: text("signer_device_pubkey").notNull(),
	signature: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	recordVersion: bigint("record_version", { mode: "number" }).default(1).notNull(),
	archived: boolean().default(false).notNull(),
	fleetDirFedKey: text("fleet_dir_fed_key").generatedAlwaysAs(sql`(((owner_github_user_id)::text || '/'::text) || fleet_slug)`),
	authorPubkey: text("author_pubkey"),
	origin: text().default('local').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	fedHlc: text("fed_hlc"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdAt: bigint("created_at", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspaceId, table.harnessSlug, table.ownerGithubUserId, table.fleetSlug], name: "p2p_fleet_directory_pkey"}),
	pgPolicy("p2p_fleet_directory_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const workerChunkLoopOutcomesInHarnessShared = harnessShared.table("worker_chunk_loop_outcomes", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).generatedAlwaysAsIdentity({ name: "harness_shared.worker_chunk_loop_outcomes_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	featureId: text("feature_id").notNull(),
	executionPath: text("execution_path").notNull(),
	outcomeKind: text("outcome_kind").notNull(),
	chunksCommitted: integer("chunks_committed"),
	replanStrikes: integer("replan_strikes"),
	escalatedChunkId: text("escalated_chunk_id"),
	detail: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdTs: bigint("created_ts", { mode: "number" }).default(sql`(EXTRACT(epoch FROM now()) * 1000)::bigint`).notNull(),
	resumed: boolean(),
	abortReason: text("abort_reason"),
	totalReplans: integer("total_replans"),
	chunksCommittedSoFar: integer("chunks_committed_so_far"),
	totalChunksPlanned: integer("total_chunks_planned"),
}, (table) => [
	index("worker_chunk_loop_outcomes_abort_reason_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.executionPath.asc().nullsLast().op("text_ops"), table.abortReason.asc().nullsLast().op("text_ops")).where(sql`(abort_reason IS NOT NULL)`),
	index("worker_chunk_loop_outcomes_path_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.executionPath.asc().nullsLast().op("text_ops"), table.outcomeKind.asc().nullsLast().op("text_ops")),
	index("worker_chunk_loop_outcomes_recent_idx").using("btree", table.workspaceId.asc().nullsLast().op("int8_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.createdTs.desc().nullsFirst().op("int8_ops")),
	primaryKey({ columns: [table.id, table.workspaceId], name: "worker_chunk_loop_outcomes_pkey"}),
	pgPolicy("worker_chunk_loop_outcomes_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const planItemAssignmentsInHarnessShared = harnessShared.table("plan_item_assignments", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	planSlug: text("plan_slug").notNull(),
	itemId: text("item_id").notNull(),
	assigneeName: text("assignee_name"),
	assignedByUser: text("assigned_by_user"),
	assignedTs: timestamp("assigned_ts", { withTimezone: true, mode: 'string' }),
	releasedTs: timestamp("released_ts", { withTimezone: true, mode: 'string' }),
	strategy: text(),
	note: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	authorPubkey: text("author_pubkey"),
	origin: text().default('local').notNull(),
	fedKey: text("fed_key").generatedAlwaysAs(sql`((plan_slug || ':'::text) || item_id)`),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	fedHlc: text("fed_hlc"),
}, (table) => [
	index("plan_item_assignments_assignee_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.assigneeName.asc().nullsLast().op("text_ops")).where(sql`((assignee_name IS NOT NULL) AND (released_ts IS NULL))`),
	index("plan_item_assignments_plan_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.planSlug.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.workspaceId, table.harnessSlug, table.planSlug, table.itemId], name: "plan_item_assignments_pkey"}),
	check("plan_item_assignments_workspace_nonempty", sql`workspace_id <> ''::text`),
	check("plan_item_assignments_item_nonempty", sql`item_id <> ''::text`),
]);

export const sharedRepoBindingCacheInHarnessShared = harnessShared.table("shared_repo_binding_cache", {
	workspaceId: text("workspace_id").default('').notNull(),
	provider: text().default('github').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	githubRepositoryId: bigint("github_repository_id", { mode: "number" }).notNull(),
	githubFullName: text("github_full_name").notNull(),
	harnessTopic: text("harness_topic").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	harnessLink: text("harness_link").notNull(),
	privacy: text().notNull(),
	claimStatus: text("claim_status").default('unclaimed').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	provisionalOwnerGithubUserId: bigint("provisional_owner_github_user_id", { mode: "number" }).notNull(),
	provisionalOwnerGithubLogin: text("provisional_owner_github_login").default('').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	claimedByGithubUserIds: bigint("claimed_by_github_user_ids", { mode: "number" }).array().default([]).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	claimedAt: timestamp("claimed_at", { withTimezone: true, mode: 'string' }),
	lastPermissionVerifiedAt: timestamp("last_permission_verified_at", { withTimezone: true, mode: 'string' }),
	supersededByHarnessTopic: text("superseded_by_harness_topic"),
	cachedAt: timestamp("cached_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("srbc_by_full_name_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.githubFullName.asc().nullsLast().op("text_ops")),
	index("srbc_by_harness_topic_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessTopic.asc().nullsLast().op("text_ops")),
	index("srbc_stale_cache_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.cachedAt.asc().nullsLast().op("text_ops")).where(sql`(claim_status = ANY (ARRAY['unclaimed'::text, 'claimed'::text]))`),
	primaryKey({ columns: [table.workspaceId, table.provider, table.githubRepositoryId], name: "shared_repo_binding_cache_pkey"}),
	pgPolicy("shared_repo_binding_cache_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("shared_repo_binding_cache_provider_check", sql`provider = 'github'::text`),
	check("shared_repo_binding_cache_privacy_check", sql`privacy = ANY (ARRAY['shared-private'::text, 'shared-public'::text])`),
	check("shared_repo_binding_cache_claim_status_check", sql`claim_status = ANY (ARRAY['unclaimed'::text, 'claimed'::text, 'stale'::text, 'superseded'::text])`),
]);

export const hivePlacementsInHarnessShared = harnessShared.table("hive_placements", {
	workspaceId: text("workspace_id").notNull(),
	installSlug: text("install_slug").notNull(),
	workItemId: text("work_item_id").notNull(),
	harnessSlug: text("harness_slug"),
	queenOwnerId: text("queen_owner_id"),
	beeSpawnId: text("bee_spawn_id"),
	beeOwnerId: text("bee_owner_id"),
	status: text().default('working').notNull(),
	failCount: integer("fail_count").default(0).notNull(),
	lastDisposition: text("last_disposition"),
	escalationMsgId: text("escalation_msg_id"),
	placedAt: timestamp("placed_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lastRecoveryAt: timestamp("last_recovery_at", { withTimezone: true, mode: 'string' }),
	lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	infraLossCount: integer("infra_loss_count").default(0).notNull(),
	lastLossSpawnId: text("last_loss_spawn_id"),
}, (table) => [
	index("hive_placements_open_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.installSlug.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.workspaceId, table.installSlug, table.workItemId], name: "hive_placements_pkey"}),
	check("hive_placements_status_check", sql`status = ANY (ARRAY['working'::text, 'recovering'::text, 'cursed'::text, 'stranded'::text, 'completed'::text, 'abandoned'::text])`),
]);

export const contributorsInHarnessShared = harnessShared.table("contributors", {
	workspaceId: text("workspace_id").default('').notNull(),
	harnessSlug: text("harness_slug").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	githubUserId: bigint("github_user_id", { mode: "number" }).notNull(),
	githubUsername: text("github_username").notNull(),
	displayName: text("display_name"),
	avatarUrl: text("avatar_url"),
	deviceAttestations: jsonb("device_attestations").default([]).notNull(),
	revokedPubkeys: text("revoked_pubkeys").array().default([""]).notNull(),
	joinedAt: timestamp("joined_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: 'string' }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	schemaVersion: bigint("schema_version", { mode: "number" }).default(1).notNull(),
	bindingStatus: text("binding_status").default('unverified').notNull(),
	channel1VerifiedAt: timestamp("channel1_verified_at", { withTimezone: true, mode: 'string' }),
	channel2VerifiedAt: timestamp("channel2_verified_at", { withTimezone: true, mode: 'string' }),
	channel2BranchRef: text("channel2_branch_ref"),
	bindingLastCheckedAt: timestamp("binding_last_checked_at", { withTimezone: true, mode: 'string' }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	fedHlc: text("fed_hlc"),
}, (table) => [
	index("contributors_username_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.githubUsername.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.workspaceId, table.harnessSlug, table.githubUserId], name: "contributors_pkey"}),
	pgPolicy("contributors_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const beekeeperScoresInHarnessShared = harnessShared.table("beekeeper_scores", {
	runId: text("run_id").notNull(),
	judgeModel: text("judge_model").notNull(),
	rubricHash: text("rubric_hash").notNull(),
	judgeTemp: real("judge_temp"),
	weights: jsonb().notNull(),
	success: boolean(),
	tokensPerTask: numeric("tokens_per_task"),
	timeToGreenSecs: numeric("time_to_green_secs"),
	firstAttemptPass: boolean("first_attempt_pass"),
	recurrence: integer(),
	escalation: boolean(),
	recallHit: numeric("recall_hit"),
	d1: real().notNull(),
	d2: real().notNull(),
	d3: real().notNull(),
	composite: real().notNull(),
	rationale: text(),
	scoredAt: timestamp("scored_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("beekeeper_scores_run_idx").using("btree", table.runId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.runId],
			foreignColumns: [beekeeperRunsInHarnessShared.runId],
			name: "beekeeper_scores_run_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.runId, table.rubricHash], name: "beekeeper_scores_pkey"}),
]);

export const gateVerdictsInHarnessShared = harnessShared.table("gate_verdicts", {
	workspaceId: text("workspace_id").notNull(),
	verdictId: text("verdict_id").notNull(),
	harnessSlug: text("harness_slug"),
	schemaV: integer("schema_v").default(1).notNull(),
	repoKey: text("repo_key").notNull(),
	stagingSha: text("staging_sha").notNull(),
	shardId: text("shard_id").notNull(),
	inputsHash: text("inputs_hash").notNull(),
	verdict: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	durationMs: bigint("duration_ms", { mode: "number" }).default(0).notNull(),
	devicePubkey: text("device_pubkey").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	verdictTs: bigint("verdict_ts", { mode: "number" }).notNull(),
	sig: text().notNull(),
	origin: text().default('local').notNull(),
	authorPubkey: text("author_pubkey"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	fedHlc: text("fed_hlc"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("gate_verdicts_shard_inputs_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.repoKey.asc().nullsLast().op("text_ops"), table.shardId.asc().nullsLast().op("text_ops"), table.inputsHash.asc().nullsLast().op("text_ops")),
	index("gate_verdicts_staging_sha_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.repoKey.asc().nullsLast().op("text_ops"), table.stagingSha.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.workspaceId, table.verdictId], name: "gate_verdicts_pkey"}),
	pgPolicy("gate_verdicts_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("gate_verdicts_verdict_check", sql`verdict = ANY (ARRAY['pass'::text, 'fail'::text])`),
]);

export const gymQdForeignElitesInHarnessShared = harnessShared.table("gym_qd_foreign_elites", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	nicheKey: text("niche_key").notNull(),
	sourceHive: text("source_hive").notNull(),
	candidateId: text("candidate_id").notNull(),
	scope: text().notNull(),
	domain: text().notNull(),
	risk: text().notNull(),
	fitness: doublePrecision().notNull(),
	descriptor: jsonb().notNull(),
	rationale: text(),
	noveltyGift: boolean("novelty_gift").default(false).notNull(),
	authorPubkey: text("author_pubkey"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdAt: bigint("created_at", { mode: "number" }).default(sql`(EXTRACT(epoch FROM now()) * 1000)::bigint`).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(sql`(EXTRACT(epoch FROM now()) * 1000)::bigint`).notNull(),
	outcomeRecord: jsonb("outcome_record"),
	outcomeVerified: boolean("outcome_verified").default(false).notNull(),
}, (table) => [
	index("gym_qd_foreign_elites_by_source").using("btree", table.sourceHive.asc().nullsLast().op("text_ops")),
	index("gym_qd_foreign_elites_fitness_idx").using("btree", table.workspaceId.asc().nullsLast().op("float8_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.fitness.desc().nullsFirst().op("text_ops")),
	primaryKey({ columns: [table.workspaceId, table.harnessSlug, table.nicheKey, table.sourceHive], name: "gym_qd_foreign_elites_pkey"}),
	pgPolicy("gym_qd_foreign_elites_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const benchRunTasksInHarnessShared = harnessShared.table("bench_run_tasks", {
	runId: text("run_id").notNull(),
	workspaceId: text("workspace_id").notNull(),
	instanceId: text("instance_id").notNull(),
	taskStatus: text("task_status").default('todo').notNull(),
	resolved: boolean(),
	beeId: text("bee_id"),
	disposition: text(),
	stopReason: text("stop_reason"),
	generationError: text("generation_error"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	tokensIn: bigint("tokens_in", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	tokensOut: bigint("tokens_out", { mode: "number" }),
	costUsd: doublePrecision("cost_usd"),
	turns: integer(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	wallClockMs: bigint("wall_clock_ms", { mode: "number" }),
	diffBytes: integer("diff_bytes"),
	armMeta: jsonb("arm_meta"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("bench_run_tasks_ws_run_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.runId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.runId],
			foreignColumns: [benchRunsInHarnessShared.id],
			name: "bench_run_tasks_run_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.runId, table.instanceId], name: "bench_run_tasks_pkey"}),
	pgPolicy("bench_run_tasks_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("bench_run_tasks_task_status_check", sql`task_status = ANY (ARRAY['todo'::text, 'in_progress'::text, 'collected'::text, 'graded'::text, 'error'::text])`),
]);

export const hivePendingJoinsInHarnessShared = harnessShared.table("hive_pending_joins", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	githubUserId: bigint("github_user_id", { mode: "number" }).notNull(),
	githubUsername: text("github_username").notNull(),
	displayName: text("display_name"),
	avatarUrl: text("avatar_url"),
	deviceAttestations: jsonb("device_attestations").default([]).notNull(),
	status: text().default('pending').notNull(),
	reason: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	requestedAt: bigint("requested_at", { mode: "number" }).default(sql`(EXTRACT(epoch FROM now()) * 1000)::bigint`).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	decidedAt: bigint("decided_at", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	decidedByGithubUserId: bigint("decided_by_github_user_id", { mode: "number" }),
	authorPubkey: text("author_pubkey"),
	origin: text().default('local').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	fedHlc: text("fed_hlc"),
	pendingJoinFedKey: text("pending_join_fed_key").generatedAlwaysAs(sql`(github_user_id)::text`),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdAt: bigint("created_at", { mode: "number" }).default(sql`(EXTRACT(epoch FROM now()) * 1000)::bigint`).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(sql`(EXTRACT(epoch FROM now()) * 1000)::bigint`).notNull(),
}, (table) => [
	index("hive_pending_joins_by_status").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.workspaceId, table.harnessSlug, table.githubUserId], name: "hive_pending_joins_pkey"}),
	pgPolicy("hive_pending_joins_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const p2PWorkOffersInHarnessShared = harnessShared.table("p2p_work_offers", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	publisherGithubUserId: bigint("publisher_github_user_id", { mode: "number" }).notNull(),
	offerId: text("offer_id").notNull(),
	recordJson: text("record_json").notNull(),
	signerDevicePubkey: text("signer_device_pubkey").notNull(),
	signature: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	recordVersion: bigint("record_version", { mode: "number" }).default(1).notNull(),
	fleetSlug: text("fleet_slug").notNull(),
	offerKind: text("offer_kind").notNull(),
	status: text().default('open').notNull(),
	localDisposition: text("local_disposition"),
	offerFedKey: text("offer_fed_key").generatedAlwaysAs(sql`(((publisher_github_user_id)::text || '/'::text) || offer_id)`),
	authorPubkey: text("author_pubkey"),
	origin: text().default('local').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	fedHlc: text("fed_hlc"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdAt: bigint("created_at", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	index("p2p_work_offers_fleet_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.fleetSlug.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.workspaceId, table.harnessSlug, table.publisherGithubUserId, table.offerId], name: "p2p_work_offers_pkey"}),
	pgPolicy("p2p_work_offers_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const datatypeRegistryInHarnessShared = harnessShared.table("datatype_registry", {
	id: text().notNull(),
	workspaceId: text("workspace_id").notNull(),
	title: text().notNull(),
	description: text().notNull(),
	tier: text().default('generic-kind').notNull(),
	workItemKind: text("work_item_kind"),
	payloadSchema: jsonb("payload_schema"),
	authoritativeWriter: text("authoritative_writer").default('papercusp').notNull(),
	selfImprovement: jsonb("self_improvement"),
	status: text().default('active').notNull(),
	published: boolean().default(false).notNull(),
	tags: text().array().default([""]).notNull(),
	embedding: vector({ dimensions: 384 }),
	titleTsv: tsvectorCustom("title_tsv").generatedAlwaysAs(sql`to_tsvector('english'::regconfig, ((COALESCE(title, ''::text) || ' '::text) || COALESCE(description, ''::text)))`),
	createdBy: text("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	reviewStatus: text("review_status").default('none').notNull(),
	potSlug: text("pot_slug"),
}, (table) => [
	index("datatype_registry_review_pending_idx").using("btree", table.reviewStatus.asc().nullsLast().op("text_ops")).where(sql`(review_status = 'pending'::text)`),
	index("datatype_registry_title_tsv_idx").using("gin", table.titleTsv.asc().nullsLast().op("tsvector_ops")),
	uniqueIndex("datatype_registry_ws_kind_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.workItemKind.asc().nullsLast().op("text_ops")).where(sql`(work_item_kind IS NOT NULL)`),
	index("datatype_registry_ws_pot_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.potSlug.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.id, table.workspaceId], name: "datatype_registry_pkey"}),
	pgPolicy("datatype_registry_approved_global_read", { as: "permissive", for: "select", to: ["public"], using: sql`(review_status = 'approved'::text)` }),
	pgPolicy("datatype_registry_workspace_isolation", { as: "permissive", for: "all", to: ["public"] }),
]);

export const coordConversationsInHarnessShared = harnessShared.table("coord_conversations", {
	workspaceId: text("workspace_id").default('default').notNull(),
	id: text().notNull(),
	kind: text().notNull(),
	scope: text().default('operator').notNull(),
	harnessSlug: text("harness_slug"),
	askerId: text("asker_id").notNull(),
	title: text(),
	body: text().default('').notNull(),
	state: text().default('open').notNull(),
	acceptedAnswer: text("accepted_answer"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	acceptedPostId: bigint("accepted_post_id", { mode: "number" }),
	captureTarget: text("capture_target"),
	promotedIssueId: text("promoted_issue_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: 'string' }),
	origin: text().default('local').notNull(),
	authorPubkey: text("author_pubkey"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	fedHlc: text("fed_hlc"),
}, (table) => [
	index("coord_conversations_open_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.kind.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")).where(sql`(state = 'open'::text)`),
	index("coord_conversations_scope_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.scope.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("text_ops")),
	primaryKey({ columns: [table.workspaceId, table.id], name: "coord_conversations_pkey"}),
	check("coord_conversations_kind_check", sql`kind = ANY (ARRAY['question'::text, 'discussion'::text])`),
	check("coord_conversations_scope_check", sql`scope = ANY (ARRAY['operator'::text, 'harness'::text])`),
	check("coord_conversations_state_check", sql`state = ANY (ARRAY['open'::text, 'resolved'::text, 'closed'::text])`),
	check("coord_conversations_scope_slug_check", sql`((scope = 'harness'::text) AND (harness_slug IS NOT NULL) AND (harness_slug <> ''::text)) OR ((scope = 'operator'::text) AND (harness_slug IS NULL))`),
	check("coord_conversations_id_nonempty", sql`id <> ''::text`),
	check("coord_conversations_workspace_nonempty", sql`workspace_id <> ''::text`),
]);

export const snapshotFeaturesInHarnessShared = harnessShared.table("snapshot_features", {
	harnessSlug: text("harness_slug").notNull(),
	snapshotId: text("snapshot_id").notNull(),
	featureId: text("feature_id").notNull(),
	title: text().notNull(),
	summary: text(),
	status: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	attempts: bigint({ mode: "number" }).notNull(),
	claims: text(),
	notes: text(),
	metadata: jsonb(),
	kind: text(),
	projectId: text("project_id"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	expectedCostCents: bigint("expected_cost_cents", { mode: "number" }),
	tags: jsonb(),
	needsHumanReview: boolean("needs_human_review").default(false).notNull(),
	deprecationReason: text("deprecation_reason"),
	parentId: text("parent_id"),
	goalId: text("goal_id"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdTs: bigint("created_ts", { mode: "number" }).notNull(),
}, (table) => [
	index("sf_snapshot_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.snapshotId.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.harnessSlug, table.snapshotId, table.featureId], name: "snapshot_features_pkey"}),
]);

export const agentRunsConsolidatedInHarnessShared = harnessShared.table("agent_runs_consolidated", {
	harnessSlug: text("harness_slug").notNull(),
	runId: text("run_id").notNull(),
	role: text().notNull(),
	featureId: text("feature_id"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	sizeBytes: bigint("size_bytes", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	durationMs: bigint("duration_ms", { mode: "number" }).default(0).notNull(),
	costUsd: doublePrecision("cost_usd").default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	inputTokens: bigint("input_tokens", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	outputTokens: bigint("output_tokens", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	cacheCreationTokens: bigint("cache_creation_tokens", { mode: "number" }).default(0).notNull(),
	running: boolean().default(false).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	lastEventTs: bigint("last_event_ts", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdTs: bigint("created_ts", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedTs: bigint("updated_ts", { mode: "number" }).notNull(),
	workspaceId: text("workspace_id").default('default').notNull(),
	backend: text(),
	model: text(),
	costIsEstimate: boolean("cost_is_estimate").default(false).notNull(),
}, (table) => [
	index("arc_feature_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.featureId.asc().nullsLast().op("text_ops")),
	index("arc_role_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.role.asc().nullsLast().op("text_ops")),
	index("arc_running_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.running.asc().nullsLast().op("text_ops")).where(sql`(running = true)`),
	index("arc_ts_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("int8_ops")),
	index("arc_workspace_ts_idx").using("btree", table.workspaceId.asc().nullsLast().op("int8_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("text_ops")),
	primaryKey({ columns: [table.harnessSlug, table.runId], name: "agent_runs_consolidated_pkey"}),
]);

export const transferLessonsInHarnessShared = harnessShared.table("transfer_lessons", {
	workspaceId: text("workspace_id").notNull(),
	id: uuid().defaultRandom().notNull(),
	signature: text().notNull(),
	title: text(),
	lessonText: text("lesson_text").notNull(),
	sourceKind: text("source_kind").default('transcript').notNull(),
	sourceRef: text("source_ref"),
	tier: text().default('probationary').notNull(),
	status: text().default('candidate').notNull(),
	testCount: integer("test_count").default(0).notNull(),
	passCount: integer("pass_count").default(0).notNull(),
	failCount: integer("fail_count").default(0).notNull(),
	lastTestedAt: timestamp("last_tested_at", { withTimezone: true, mode: 'string' }),
	lastBatteryId: text("last_battery_id"),
	lastDelta: numeric("last_delta"),
	memoryId: uuid("memory_id"),
	packCandidateId: uuid("pack_candidate_id"),
	signalOrigin: text("signal_origin").default('replay').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("transfer_lessons_ws_created_idx").using("btree", table.workspaceId.asc().nullsLast().op("timestamptz_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	index("transfer_lessons_ws_tier_tested_idx").using("btree", table.workspaceId.asc().nullsLast().op("timestamptz_ops"), table.tier.asc().nullsLast().op("text_ops"), table.lastTestedAt.asc().nullsFirst().op("text_ops")),
	primaryKey({ columns: [table.workspaceId, table.id], name: "transfer_lessons_pkey"}),
	unique("transfer_lessons_signature_uniq").on(table.workspaceId, table.signature),
	pgPolicy("transfer_lessons_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("transfer_lessons_source_kind_check", sql`source_kind = ANY (ARRAY['transcript'::text, 'memory'::text, 'pack-candidate'::text])`),
	check("transfer_lessons_tier_check", sql`tier = ANY (ARRAY['probationary'::text, 'validated'::text, 'retired'::text])`),
	check("transfer_lessons_status_check", sql`status = ANY (ARRAY['candidate'::text, 'passed'::text, 'failed'::text, 'error'::text])`),
	check("transfer_lessons_signal_origin_check", sql`signal_origin = ANY (ARRAY['organic'::text, 'drill'::text, 'replay'::text, 'shadow'::text])`),
]);

export const p2PPeerGrantsInHarnessShared = harnessShared.table("p2p_peer_grants", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	grantorGithubUserId: bigint("grantor_github_user_id", { mode: "number" }).notNull(),
	grantorLogin: text("grantor_login"),
	granteeKind: text("grantee_kind").notNull(),
	granteeRef: text("grantee_ref").notNull(),
	capabilities: text().array().default([""]).notNull(),
	preset: text(),
	status: text().default('active').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	grantorEpoch: bigint("grantor_epoch", { mode: "number" }).default(0).notNull(),
	wakeRateCapPerHour: integer("wake_rate_cap_per_hour"),
	excludedDevicePubkeys: text("excluded_device_pubkeys").array().default([""]).notNull(),
	note: text(),
	grantFedKey: text("grant_fed_key").generatedAlwaysAs(sql`(((((grantor_github_user_id)::text || ':'::text) || grantee_kind) || ':'::text) || grantee_ref)`),
	origin: text().default('local').notNull(),
	authorPubkey: text("author_pubkey"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	fedHlc: text("fed_hlc"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("p2p_peer_grants_grantee_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.granteeKind.asc().nullsLast().op("text_ops"), table.granteeRef.asc().nullsLast().op("text_ops")).where(sql`(status = 'active'::text)`),
	primaryKey({ columns: [table.workspaceId, table.harnessSlug, table.grantorGithubUserId, table.granteeKind, table.granteeRef], name: "p2p_peer_grants_pkey"}),
	pgPolicy("p2p_peer_grants_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("p2p_peer_grants_ws_nonempty", sql`workspace_id <> ''::text`),
	check("p2p_peer_grants_slug_nonempty", sql`harness_slug <> ''::text`),
	check("p2p_peer_grants_grantor_pos", sql`grantor_github_user_id > 0`),
	check("p2p_peer_grants_grantee_kind", sql`grantee_kind = ANY (ARRAY['fleet'::text, 'pool'::text])`),
	check("p2p_peer_grants_grantee_nonempty", sql`grantee_ref <> ''::text`),
	check("p2p_peer_grants_status", sql`status = ANY (ARRAY['active'::text, 'revoked'::text])`),
	check("p2p_peer_grants_epoch_nonneg", sql`grantor_epoch >= 0`),
	check("p2p_peer_grants_wake_cap_pos", sql`(wake_rate_cap_per_hour IS NULL) OR (wake_rate_cap_per_hour > 0)`),
]);

export const p2PReceiptsInHarnessShared = harnessShared.table("p2p_receipts", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	receiptId: text("receipt_id").notNull(),
	kind: text().notNull(),
	offerId: text("offer_id"),
	action: text().notNull(),
	refusalCode: text("refusal_code"),
	missingCapability: text("missing_capability"),
	budgetAxis: text("budget_axis"),
	detail: text().notNull(),
	requesterKind: text("requester_kind"),
	requesterRef: text("requester_ref"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	requesterGithubUserId: bigint("requester_github_user_id", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	responderGithubUserId: bigint("responder_github_user_id", { mode: "number" }).notNull(),
	responderDevicePubkey: text("responder_device_pubkey"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	receiptTs: bigint("receipt_ts", { mode: "number" }).notNull(),
	origin: text().default('local').notNull(),
	authorPubkey: text("author_pubkey"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	fedHlc: text("fed_hlc"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("p2p_receipts_offer_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.offerId.asc().nullsLast().op("int8_ops"), table.receiptTs.asc().nullsLast().op("text_ops")).where(sql`(offer_id IS NOT NULL)`),
	index("p2p_receipts_ts_idx").using("btree", table.workspaceId.asc().nullsLast().op("int8_ops"), table.harnessSlug.asc().nullsLast().op("int8_ops"), table.receiptTs.asc().nullsLast().op("int8_ops")),
	primaryKey({ columns: [table.workspaceId, table.harnessSlug, table.receiptId], name: "p2p_receipts_pkey"}),
	pgPolicy("p2p_receipts_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("p2p_receipts_ws_nonempty", sql`workspace_id <> ''::text`),
	check("p2p_receipts_slug_nonempty", sql`harness_slug <> ''::text`),
	check("p2p_receipts_id_nonempty", sql`receipt_id <> ''::text`),
	check("p2p_receipts_kind", sql`kind = ANY (ARRAY['refusal'::text, 'excused-breach'::text])`),
	check("p2p_receipts_action_nonempty", sql`action <> ''::text`),
	check("p2p_receipts_responder_pos", sql`responder_github_user_id > 0`),
]);

export const harnessDocsInHarnessShared = harnessShared.table("harness_docs", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	docId: text("doc_id").notNull(),
	source: text().default('manual').notNull(),
	subjectRef: jsonb("subject_ref").default([]).notNull(),
	anchorPaths: text("anchor_paths").array().default([""]).notNull(),
	generatedFromSha: text("generated_from_sha"),
	lastVerifiedSha: text("last_verified_sha"),
	lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true, mode: 'string' }),
	overlay: text(),
	status: text().default('untracked').notNull(),
	statusDetail: text("status_detail"),
	statusCheckedAt: timestamp("status_checked_at", { withTimezone: true, mode: 'string' }),
	regenEnqueuedAt: timestamp("regen_enqueued_at", { withTimezone: true, mode: 'string' }),
	reverifyFlaggedAt: timestamp("reverify_flagged_at", { withTimezone: true, mode: 'string' }),
	title: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	authorPubkey: text("author_pubkey"),
	origin: text().default('local').notNull(),
	regenAttempts: integer("regen_attempts").default(0).notNull(),
	reverifyAttempts: integer("reverify_attempts").default(0).notNull(),
}, (table) => [
	index("harness_docs_anchor_paths_idx").using("gin", table.anchorPaths.asc().nullsLast().op("array_ops")),
	index("harness_docs_status_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.workspaceId, table.harnessSlug, table.docId], name: "harness_docs_pkey"}),
	pgPolicy("harness_docs_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("harness_docs_source_check", sql`source = ANY (ARRAY['generated'::text, 'manual'::text, 'augmented'::text])`),
	check("harness_docs_status_check", sql`status = ANY (ARRAY['fresh'::text, 'stale'::text, 'review'::text, 'untracked'::text, 'unknown'::text])`),
	check("harness_docs_workspace_nonempty", sql`workspace_id <> ''::text`),
	check("harness_docs_doc_id_nonempty", sql`doc_id <> ''::text`),
]);

export const hiveMembersInHarnessShared = harnessShared.table("hive_members", {
	workspaceId: text("workspace_id").notNull(),
	hiveHomeSlug: text("hive_home_slug").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	githubUserId: bigint("github_user_id", { mode: "number" }).notNull(),
	githubUsername: text("github_username").notNull(),
	displayName: text("display_name"),
	avatarUrl: text("avatar_url"),
	deviceAttestations: jsonb("device_attestations").default([]).notNull(),
	revokedPubkeys: text("revoked_pubkeys").array().default([""]).notNull(),
	joinedAt: timestamp("joined_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: 'string' }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	schemaVersion: bigint("schema_version", { mode: "number" }).default(1).notNull(),
	bindingStatus: text("binding_status").default('unverified').notNull(),
	channel1VerifiedAt: timestamp("channel1_verified_at", { withTimezone: true, mode: 'string' }),
	channel2VerifiedAt: timestamp("channel2_verified_at", { withTimezone: true, mode: 'string' }),
	channel2BranchRef: text("channel2_branch_ref"),
	bindingLastCheckedAt: timestamp("binding_last_checked_at", { withTimezone: true, mode: 'string' }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	origin: text().default('local').notNull(),
	authorPubkey: text("author_pubkey"),
	repoPermission: text("repo_permission"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	permissionCheckedAt: bigint("permission_checked_at", { mode: "number" }),
	fedHlc: text("fed_hlc"),
}, (table) => [
	index("hive_members_username_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.hiveHomeSlug.asc().nullsLast().op("text_ops"), table.githubUsername.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.workspaceId, table.hiveHomeSlug],
			foreignColumns: [hivesInHarnessShared.workspaceId, hivesInHarnessShared.homeSlug],
			name: "hive_members_hive_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.workspaceId, table.hiveHomeSlug, table.githubUserId], name: "hive_members_pkey"}),
	pgPolicy("hive_members_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("hive_members_workspace_id_concrete", sql`(workspace_id <> '*'::text) AND (workspace_id <> ''::text)`),
]);

export const replayRunsInHarnessShared = harnessShared.table("replay_runs", {
	workspaceId: text("workspace_id").notNull(),
	runId: text("run_id").notNull(),
	batteryId: text("battery_id").notNull(),
	variantId: text("variant_id").notNull(),
	variantLabel: text("variant_label"),
	caseRef: text("case_ref").notNull(),
	turnIndex: integer("turn_index"),
	repeat: integer().default(0).notNull(),
	status: text().default('started').notNull(),
	signalOrigin: text("signal_origin").default('replay').notNull(),
	d1: numeric(),
	d2: numeric(),
	d3: numeric(),
	composite: numeric(),
	judgeRationale: text("judge_rationale"),
	rubricHash: text("rubric_hash"),
	divergence: jsonb(),
	costUsd: numeric("cost_usd").default('0').notNull(),
	error: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	elapsedMs: bigint("elapsed_ms", { mode: "number" }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("replay_runs_ws_battery_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.batteryId.asc().nullsLast().op("text_ops"), table.createdAt.asc().nullsLast().op("text_ops")),
	index("replay_runs_ws_created_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("text_ops")),
	primaryKey({ columns: [table.workspaceId, table.runId], name: "replay_runs_pkey"}),
	pgPolicy("replay_runs_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("replay_runs_status_check", sql`status = ANY (ARRAY['started'::text, 'scored'::text, 'rate_limited'::text, 'errored'::text])`),
	check("replay_runs_signal_origin_check", sql`signal_origin = ANY (ARRAY['organic'::text, 'drill'::text, 'replay'::text, 'shadow'::text])`),
]);

export const harnessIssuesConsolidatedInHarnessShared = harnessShared.table("harness_issues_consolidated", {
	harnessSlug: text("harness_slug").notNull(),
	issueId: text("issue_id").notNull(),
	title: text().notNull(),
	severity: text().notNull(),
	source: text().notNull(),
	status: text().notNull(),
	foundAt: timestamp("found_at", { withTimezone: true, mode: 'string' }).notNull(),
	foundDuring: text("found_during"),
	repro: text(),
	evidence: text(),
	suggestedFix: text("suggested_fix"),
	codePointer: text("code_pointer"),
	linkedFeatureId: text("linked_feature_id"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	attempts: bigint({ mode: "number" }).default(0).notNull(),
	notes: jsonb().default([]).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdTs: bigint("created_ts", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedTs: bigint("updated_ts", { mode: "number" }).notNull(),
	authorPubkey: text("author_pubkey"),
	origin: text().default('local').notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	fedHlc: text("fed_hlc"),
}, (table) => [
	index("hic_found_during_idx").using("btree", table.foundDuring.asc().nullsLast().op("text_ops")),
	index("hic_linked_idx").using("btree", table.linkedFeatureId.asc().nullsLast().op("text_ops")),
	index("hic_origin_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.origin.asc().nullsLast().op("text_ops")).where(sql`(origin = 'remote'::text)`),
	index("hic_severity_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.severity.asc().nullsLast().op("text_ops")),
	index("hic_status_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")),
	index("hic_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.harnessSlug, table.issueId], name: "harness_issues_consolidated_pkey"}),
	check("harness_issues_consolidated_severity_check", sql`severity = ANY (ARRAY['critical'::text, 'major'::text, 'minor'::text, 'nit'::text])`),
	check("harness_issues_consolidated_status_check", sql`status = ANY (ARRAY['open'::text, 'acknowledged'::text, 'fixing'::text, 'closed'::text, 'wontfix'::text])`),
	check("harness_issues_consolidated_source_check", sql`source = ANY (ARRAY['validator'::text, 'worker'::text, 'human'::text, 'system'::text])`),
]);

export const workItemReplicasInHarnessShared = harnessShared.table("work_item_replicas", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	workItemId: text("work_item_id").notNull(),
	replicaIndex: integer("replica_index").notNull(),
	redundancy: integer().notNull(),
	claimId: uuid("claim_id").defaultRandom().notNull(),
	owner: text().notNull(),
	ownerLabel: text("owner_label"),
	holderPubkey: text("holder_pubkey"),
	ttlSec: integer("ttl_sec").default(1800).notNull(),
	acquiredTs: timestamp("acquired_ts", { withTimezone: true, mode: 'string' }).default(sql`clock_timestamp()`).notNull(),
	expiresTs: timestamp("expires_ts", { withTimezone: true, mode: 'string' }).notNull(),
	lastActivityTs: timestamp("last_activity_ts", { withTimezone: true, mode: 'string' }).default(sql`clock_timestamp()`).notNull(),
	status: text().default('claimed').notNull(),
	result: jsonb(),
	judgeComposite: doublePrecision("judge_composite"),
	judgeRationale: text("judge_rationale"),
	judgeModel: text("judge_model"),
	rubricHash: text("rubric_hash"),
	judgeCostUsd: doublePrecision("judge_cost_usd"),
	judgedTs: timestamp("judged_ts", { withTimezone: true, mode: 'string' }),
	createdTs: timestamp("created_ts", { withTimezone: true, mode: 'string' }).default(sql`clock_timestamp()`).notNull(),
	updatedTs: timestamp("updated_ts", { withTimezone: true, mode: 'string' }).default(sql`clock_timestamp()`).notNull(),
}, (table) => [
	index("work_item_replicas_expires_idx").using("btree", table.expiresTs.asc().nullsLast().op("timestamptz_ops")),
	index("work_item_replicas_item_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.workItemId.asc().nullsLast().op("text_ops")),
	index("work_item_replicas_owner_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.owner.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.workspaceId, table.harnessSlug, table.workItemId, table.replicaIndex], name: "work_item_replicas_pkey"}),
	check("work_item_replicas_status_check", sql`status = ANY (ARRAY['claimed'::text, 'complete'::text, 'winner'::text, 'loser'::text])`),
	check("work_item_replicas_workspace_nonempty", sql`workspace_id <> ''::text`),
	check("work_item_replicas_owner_nonempty", sql`owner <> ''::text`),
	check("work_item_replicas_index_nonneg", sql`replica_index >= 0`),
	check("work_item_replicas_redundancy_positive", sql`redundancy >= 1`),
]);

export const harnessPlansInHarnessShared = harnessShared.table("harness_plans", {
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	planSlug: text("plan_slug").notNull(),
	title: text(),
	status: text(),
	created: text(),
	updated: text(),
	owner: text(),
	supersedes: text().array().default([""]).notNull(),
	supersededBy: text("superseded_by"),
	content: text().default('').notNull(),
	contentHash: text("content_hash").default('').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	version: bigint({ mode: "number" }).default(0).notNull(),
	opStatus: text("op_status"),
	opStartedAt: timestamp("op_started_at", { withTimezone: true, mode: 'string' }),
	opUpdatedAt: timestamp("op_updated_at", { withTimezone: true, mode: 'string' }),
	currentWave: text("current_wave"),
	opPriority: integer("op_priority"),
	archived: boolean().default(false).notNull(),
	isLegacy: boolean("is_legacy").default(false).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	authorPubkey: text("author_pubkey"),
	origin: text().default('local').notNull(),
	search: tsvectorCustom("_search").generatedAlwaysAs(sql`(setweight(to_tsvector('english'::regconfig, COALESCE(title, ''::text)), 'A'::"char") || setweight(to_tsvector('english'::regconfig, COALESCE(content, ''::text)), 'B'::"char"))`),
	items: jsonb(),
	decisions: jsonb(),
	nowState: text("now_state"),
	nowNext: text("now_next"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	initiative: text(),
	schedule: jsonb(),
	scheduleActive: boolean("schedule_active").default(false).notNull(),
	scheduledAt: timestamp("scheduled_at", { withTimezone: true, mode: 'string' }),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }),
	tzid: text(),
	templateSlug: text("template_slug"),
	runSeq: integer("run_seq"),
	fedHlc: text("fed_hlc"),
	promotePolicy: jsonb("promote_policy"),
	template: text(),
	templateData: jsonb("template_data"),
	ownerAuthorPubkey: text("owner_author_pubkey"),
}, (table) => [
	index("harness_plans_schedule_active_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops")).where(sql`(schedule_active = true)`),
	index("harness_plans_search_idx").using("gin", table.search.asc().nullsLast().op("tsvector_ops")),
	index("harness_plans_search_idx_ccnew").using("gin", table.search.asc().nullsLast().op("tsvector_ops")),
	index("harness_plans_started_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.opStatus.asc().nullsLast().op("text_ops")).where(sql`(op_status = 'started'::text)`),
	index("harness_plans_template_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.templateSlug.asc().nullsLast().op("text_ops")).where(sql`(template_slug IS NOT NULL)`),
	primaryKey({ columns: [table.workspaceId, table.harnessSlug, table.planSlug], name: "harness_plans_pkey"}),
	pgPolicy("harness_plans_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("harness_plans_status_check", sql`(status IS NULL) OR (status = ANY (ARRAY['draft'::text, 'ready'::text, 'active'::text, 'shipped'::text, 'superseded'::text]))`),
	check("harness_plans_op_status_check", sql`(op_status IS NULL) OR (op_status = ANY (ARRAY['started'::text, 'paused'::text, 'done'::text]))`),
	check("harness_plans_workspace_nonempty", sql`workspace_id <> ''::text`),
]);

export const workItemsInHarnessShared = harnessShared.table("work_items", {
	harnessSlug: text("harness_slug").notNull(),
	featureId: text("feature_id").notNull(),
	title: text(),
	summary: text(),
	status: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	attempts: bigint({ mode: "number" }),
	claims: text(),
	notes: text(),
	metadata: jsonb(),
	kind: text(),
	projectId: text("project_id"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	expectedCostCents: bigint("expected_cost_cents", { mode: "number" }),
	tags: jsonb(),
	needsHumanReview: boolean("needs_human_review"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdTs: bigint("created_ts", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedTs: bigint("updated_ts", { mode: "number" }),
	parentId: text("parent_id"),
	goalId: text("goal_id"),
	takenBy: text("taken_by"),
	takenAt: timestamp("taken_at", { withTimezone: true, mode: 'string' }),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }),
	workspaceId: text("workspace_id").notNull(),
	search: tsvectorCustom("_search").generatedAlwaysAs(sql`((setweight(to_tsvector('english'::regconfig, COALESCE(title, ''::text)), 'A'::"char") || setweight(to_tsvector('english'::regconfig, COALESCE(summary, ''::text)), 'B'::"char")) || setweight(to_tsvector('english'::regconfig, COALESCE(notes, ''::text)), 'C'::"char"))`),
	deprecationReason: text("deprecation_reason"),
	seeAlso: text("see_also").array().default([""]).notNull(),
	needsDesign: boolean("needs_design").default(false).notNull(),
	designStatus: text("design_status"),
	designSpecId: text("design_spec_id"),
	discardedDesignWork: boolean("discarded_design_work").default(false).notNull(),
	completionRef: jsonb("completion_ref"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdByGithubUserId: bigint("created_by_github_user_id", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	workingUsers: bigint("working_users", { mode: "number" }).array().default([]).notNull(),
	workedByHistory: jsonb("worked_by_history").default([]).notNull(),
	wave: text(),
	verifiedDoneAtRemoteTs: timestamp("verified_done_at_remote_ts", { withTimezone: true, mode: 'string' }),
	verifierLastError: text("verifier_last_error"),
	verifierLastCheckedAt: timestamp("verifier_last_checked_at", { withTimezone: true, mode: 'string' }),
	sourcePlanSlug: text("source_plan_slug"),
	sourcePlanItemIds: text("source_plan_item_ids").array(),
	featureOrder: integer("feature_order"),
	authorPubkey: text("author_pubkey"),
	origin: text().default('local').notNull(),
	auditVerdict: text("audit_verdict"),
	auditReasons: text("audit_reasons"),
	auditedAt: timestamp("audited_at", { withTimezone: true, mode: 'string' }),
	itemKind: text("item_kind").default('feature').notNull(),
	payload: jsonb(),
	assigneeRank: integer("assignee_rank"),
	rankWriter: text("rank_writer"),
	rankUpdatedAt: timestamp("rank_updated_at", { withTimezone: true, mode: 'string' }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	redundancy: integer(),
	swarmAffinity: text("swarm_affinity"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	verifiedAuthorGithubUserId: bigint("verified_author_github_user_id", { mode: "number" }),
	schedule: jsonb(),
	scheduleActive: boolean("schedule_active").default(false),
	scheduledAt: timestamp("scheduled_at", { withTimezone: true, mode: 'string' }),
	tzid: text(),
	templateSlug: text("template_slug"),
	runSeq: integer("run_seq"),
	requeueCount: integer("requeue_count").default(0).notNull(),
	fedHlc: text("fed_hlc"),
	lastProgressAt: timestamp("last_progress_at", { withTimezone: true, mode: 'string' }),
	terminalOwner: text("terminal_owner"),
	terminalCompletionRef: text("terminal_completion_ref"),
	lastReleasedBy: text("last_released_by"),
	lastReleasedAt: timestamp("last_released_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("harness_features_consolidated_claimed_progress_idx").using("btree", table.harnessSlug.asc().nullsLast().op("timestamptz_ops"), table.lastProgressAt.asc().nullsLast().op("timestamptz_ops")).where(sql`((taken_by IS NOT NULL) AND (taken_by <> ''::text))`),
	index("hfc_assignee_rank_idx").using("btree", table.workspaceId.asc().nullsLast().op("int4_ops"), table.takenBy.asc().nullsLast().op("text_ops"), table.assigneeRank.asc().nullsLast().op("int4_ops")).where(sql`((taken_by IS NOT NULL) AND (assignee_rank IS NOT NULL))`),
	index("hfc_audit_pending_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops")).where(sql`((origin = 'remote'::text) AND ((audit_verdict IS NULL) OR (audit_verdict = 'pending'::text)))`),
	index("hfc_created_by_idx").using("btree", table.harnessSlug.asc().nullsLast().op("int8_ops"), table.createdByGithubUserId.asc().nullsLast().op("text_ops")).where(sql`(created_by_github_user_id IS NOT NULL)`),
	index("hfc_design_status_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.designStatus.asc().nullsLast().op("text_ops")).where(sql`(design_status IS NOT NULL)`),
	index("hfc_item_kind_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.itemKind.asc().nullsLast().op("text_ops")),
	index("hfc_needs_design_idx").using("btree", table.harnessSlug.asc().nullsLast().op("bool_ops"), table.needsDesign.asc().nullsLast().op("bool_ops")).where(sql`(needs_design = true)`),
	index("hfc_origin_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.origin.asc().nullsLast().op("text_ops")).where(sql`(origin = 'remote'::text)`),
	index("hfc_pending_done_idx").using("btree", table.status.asc().nullsLast().op("text_ops")).where(sql`((status = 'pending_done'::text) AND (completion_ref IS NOT NULL))`),
	index("hfc_plan_wave_idx").using("btree", table.sourcePlanSlug.asc().nullsLast().op("text_ops"), table.wave.asc().nullsLast().op("text_ops")).where(sql`(source_plan_slug IS NOT NULL)`),
	index("hfc_review_idx").using("btree", table.needsHumanReview.asc().nullsLast().op("bool_ops")),
	index("hfc_search_idx").using("gin", table.search.asc().nullsLast().op("tsvector_ops")),
	index("hfc_see_also_gin").using("gin", table.seeAlso.asc().nullsLast().op("array_ops")),
	index("hfc_slug_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops")),
	index("hfc_source_plan_run_idx").using("btree", sql`(((payload -> 'plan_run'::text) ->> 'runId'::text))`).where(sql`(((payload -> 'plan_run'::text) ->> 'runId'::text) IS NOT NULL)`),
	index("hfc_source_plan_slug_idx").using("btree", table.sourcePlanSlug.asc().nullsLast().op("text_ops")).where(sql`(source_plan_slug IS NOT NULL)`),
	index("hfc_status_idx").using("btree", table.status.asc().nullsLast().op("text_ops")),
	index("hfc_taken_by_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.takenBy.asc().nullsLast().op("text_ops")).where(sql`(taken_by IS NOT NULL)`),
	index("hfc_updated_idx").using("btree", table.updatedTs.desc().nullsFirst().op("int8_ops")),
	index("hfc_verifier_divergence_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.featureId.asc().nullsLast().op("text_ops")).where(sql`(verifier_last_error IS NOT NULL)`),
	index("hfc_verifier_pending_idx").using("btree", table.harnessSlug.asc().nullsLast().op("timestamptz_ops"), table.verifierLastCheckedAt.asc().nullsFirst().op("text_ops")).where(sql`((completion_ref IS NOT NULL) AND (verified_done_at_remote_ts IS NULL))`),
	index("hfc_working_users_active_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")).where(sql`(array_length(working_users, 1) IS NOT NULL)`),
	index("hfc_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.harnessSlug, table.featureId], name: "work_items_pkey"}),
	pgPolicy("work_items_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("hfc_design_status_chk", sql`(design_status IS NULL) OR (design_status = ANY (ARRAY['pending'::text, 'accepted'::text, 'ignored'::text]))`),
	check("hfc_rank_writer_chk", sql`(rank_writer IS NULL) OR (rank_writer = ANY (ARRAY['cup'::text, 'mug'::text]))`),
	check("work_items_signal_origin_chk", sql`(((payload -> '_ei'::text) ->> 'signal_origin'::text) IS NULL) OR (((payload -> '_ei'::text) ->> 'signal_origin'::text) = ANY (ARRAY['organic'::text, 'drill'::text, 'replay'::text, 'shadow'::text])))) NOT VALID`),
	check("hfc_workspace_nonempty", sql`workspace_id <> ''::text`),
]);
export const fleetAssignmentInHarnessShared = harnessShared.view("fleet_assignment", {	source: text(),
	workspaceId: text("workspace_id"),
	agentId: text("agent_id"),
	agentLabel: text("agent_label"),
	agentName: text("agent_name"),
	harnessSlug: text("harness_slug"),
	planSlug: text("plan_slug"),
	itemId: text("item_id"),
	workItemId: text("work_item_id"),
	itemKind: text("item_kind"),
	detail: text(),
	status: text(),
	claimAcquiredTs: timestamp("claim_acquired_ts", { withTimezone: true, mode: 'string' }),
	claimExpiresTs: timestamp("claim_expires_ts", { withTimezone: true, mode: 'string' }),
	claimActive: boolean("claim_active"),
	livenessMode: text("liveness_mode"),
	lastActivityTs: timestamp("last_activity_ts", { withTimezone: true, mode: 'string' }),
	holderPresent: boolean("holder_present"),
	holderAlive: boolean("holder_alive"),
	holderHeartbeatAt: timestamp("holder_heartbeat_at", { withTimezone: true, mode: 'string' }),
	holderIntent: text("holder_intent"),
	holderPlanSlug: text("holder_plan_slug"),
	orphaned: boolean(),
	declaredPlanMatches: boolean("declared_plan_matches"),
	assigneeRank: integer("assignee_rank"),
	rankWriter: text("rank_writer"),
	lastProgressAt: timestamp("last_progress_at", { withTimezone: true, mode: 'string' }),
	stalled: boolean(),
	fleetSlug: text("fleet_slug"),
	fleetRole: text("fleet_role"),
}).as(sql`WITH presence AS ( SELECT coord_presence.owner_id, coord_presence.owner_label, coord_presence.workspace_id, coord_presence.source, coord_presence.intent, coord_presence.current_plan_slug, coord_presence.heartbeat_at, (now() - coord_presence.heartbeat_at) < '00:10:00'::interval AS alive FROM harness_shared.coord_presence ), holder AS ( SELECT presence.owner_id AS alias, presence.owner_label, presence.intent, presence.current_plan_slug, presence.heartbeat_at, presence.alive FROM presence UNION ALL SELECT DISTINCT ON (a.alias) a.alias, 'bee · '::text || "left"(n.spawn_id, 10) AS owner_label, NULL::text AS intent, NULL::text AS current_plan_slug, n.heartbeat_at, n.heartbeat_at IS NOT NULL AND (now() - n.heartbeat_at) < '00:10:00'::interval AS alive FROM harness_shared.spawned_agents n CROSS JOIN LATERAL ( VALUES (n.spawn_id), (n.session_owner), (n.run_id)) a(alias) WHERE n.status = 'running'::text AND a.alias IS NOT NULL AND a.alias <> ''::text AND NOT (EXISTS ( SELECT 1 FROM presence p WHERE p.owner_id = a.alias)) ), membership AS ( SELECT DISTINCT ON (fleet_membership_events.workspace_id, fleet_membership_events.owner_id) fleet_membership_events.workspace_id, fleet_membership_events.owner_id, fleet_membership_events.fleet_slug, fleet_membership_events.fleet_role FROM harness_shared.fleet_membership_events ORDER BY fleet_membership_events.workspace_id, fleet_membership_events.owner_id, fleet_membership_events.id DESC ) SELECT 'plan_item_claim'::text AS source, c.workspace_id, c.owner AS agent_id, COALESCE(NULLIF(c.owner_label, ''::text), p.owner_label) AS agent_label, c.owner_name AS agent_name, c.harness_slug, c.plan_slug, c.item_id, NULL::text AS work_item_id, NULL::text AS item_kind, c.intent AS detail, NULL::text AS status, c.acquired_ts AS claim_acquired_ts, c.expires_ts AS claim_expires_ts, c.expires_ts > now() AS claim_active, c.liveness_mode, c.last_activity_ts, p.alias IS NOT NULL AS holder_present, COALESCE(p.alive, false) AS holder_alive, p.heartbeat_at AS holder_heartbeat_at, p.intent AS holder_intent, p.current_plan_slug AS holder_plan_slug, c.expires_ts > now() AND NOT COALESCE(p.alive, false) AND c.owner <> 'improvement-runner'::text AS orphaned, NOT p.current_plan_slug IS DISTINCT FROM c.plan_slug AS declared_plan_matches, NULL::integer AS assignee_rank, NULL::text AS rank_writer, NULL::timestamp with time zone AS last_progress_at, NULL::boolean AS stalled, m.fleet_slug, m.fleet_role FROM harness_shared.plan_item_claims c LEFT JOIN holder p ON p.alias = c.owner LEFT JOIN membership m ON m.workspace_id = c.workspace_id AND m.owner_id = c.owner UNION ALL SELECT 'plan_item_assignment'::text AS source, a.workspace_id, a.assignee_name AS agent_id, NULL::text AS agent_label, a.assignee_name AS agent_name, a.harness_slug, a.plan_slug, a.item_id, NULL::text AS work_item_id, NULL::text AS item_kind, COALESCE(a.note, ''::text) AS detail, NULL::text AS status, a.assigned_ts AS claim_acquired_ts, NULL::timestamp with time zone AS claim_expires_ts, true AS claim_active, NULL::text AS liveness_mode, a.updated_at AS last_activity_ts, false AS holder_present, false AS holder_alive, NULL::timestamp with time zone AS holder_heartbeat_at, NULL::text AS holder_intent, NULL::text AS holder_plan_slug, false AS orphaned, NULL::boolean AS declared_plan_matches, NULL::integer AS assignee_rank, NULL::text AS rank_writer, NULL::timestamp with time zone AS last_progress_at, NULL::boolean AS stalled, m.fleet_slug, m.fleet_role FROM harness_shared.plan_item_assignments a LEFT JOIN membership m ON m.workspace_id = a.workspace_id AND m.owner_id = a.assignee_name WHERE a.assignee_name IS NOT NULL AND a.released_ts IS NULL UNION ALL SELECT 'work_item_claim'::text AS source, w.workspace_id, w.taken_by AS agent_id, p.owner_label AS agent_label, NULL::text AS agent_name, w.harness_slug, w.source_plan_slug AS plan_slug, NULL::text AS item_id, w.feature_id AS work_item_id, w.item_kind, COALESCE(w.title, ''::text) AS detail, w.status, w.taken_at AS claim_acquired_ts, NULL::timestamp with time zone AS claim_expires_ts, true AS claim_active, NULL::text AS liveness_mode, w.taken_at AS last_activity_ts, p.alias IS NOT NULL AS holder_present, COALESCE(p.alive, false) AS holder_alive, p.heartbeat_at AS holder_heartbeat_at, p.intent AS holder_intent, p.current_plan_slug AS holder_plan_slug, NOT COALESCE(p.alive, false) AND w.taken_by <> 'improvement-runner'::text AS orphaned, CASE WHEN w.source_plan_slug IS NULL THEN NULL::boolean ELSE NOT p.current_plan_slug IS DISTINCT FROM w.source_plan_slug END AS declared_plan_matches, w.assignee_rank, w.rank_writer, w.last_progress_at, COALESCE(p.alive, false) AND w.taken_by <> 'improvement-runner'::text AND (now() - COALESCE(w.last_progress_at, w.taken_at)) > '00:10:00'::interval AS stalled, m.fleet_slug, m.fleet_role FROM harness_shared.work_items w LEFT JOIN holder p ON p.alias = w.taken_by LEFT JOIN membership m ON m.workspace_id = w.workspace_id AND m.owner_id = w.taken_by WHERE w.taken_by IS NOT NULL AND w.taken_by <> ''::text AND (COALESCE(w.status, ''::text) <> ALL (ARRAY['done'::text, 'passed'::text, 'deprecated'::text, 'resolved'::text, 'closed'::text, 'dropped'::text])) UNION ALL SELECT 'presence'::text AS source, p.workspace_id, p.owner_id AS agent_id, p.owner_label AS agent_label, NULL::text AS agent_name, NULL::text AS harness_slug, p.current_plan_slug AS plan_slug, NULL::text AS item_id, NULL::text AS work_item_id, NULL::text AS item_kind, p.intent AS detail, NULL::text AS status, NULL::timestamp with time zone AS claim_acquired_ts, NULL::timestamp with time zone AS claim_expires_ts, NULL::boolean AS claim_active, NULL::text AS liveness_mode, p.heartbeat_at AS last_activity_ts, true AS holder_present, p.alive AS holder_alive, p.heartbeat_at AS holder_heartbeat_at, p.intent AS holder_intent, p.current_plan_slug AS holder_plan_slug, false AS orphaned, NULL::boolean AS declared_plan_matches, NULL::integer AS assignee_rank, NULL::text AS rank_writer, NULL::timestamp with time zone AS last_progress_at, NULL::boolean AS stalled, m.fleet_slug, m.fleet_role FROM presence p LEFT JOIN membership m ON m.workspace_id = p.workspace_id AND m.owner_id = p.owner_id`);

export const llmTestMatrixResultsInHarnessShared = harnessShared.view("llm_test_matrix_results", {	matrixGroupId: uuid("matrix_group_id"),
	scenarioId: text("scenario_id"),
	scenarioVersion: integer("scenario_version"),
	identityHash: text("identity_hash"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	nRuns: bigint("n_runs", { mode: "number" }),
	majorityStatus: text("majority_status"),
	stddevByAxis: jsonb("stddev_by_axis"),
}).as(sql`SELECT matrix_group_id, scenario_id, scenario_version, identity_hash, count(*) AS n_runs, mode() WITHIN GROUP (ORDER BY status) AS majority_status, jsonb_object_agg(axis, stddev_score) AS stddev_by_axis FROM ( SELECT r.matrix_group_id, r.scenario_id, r.scenario_version, r.identity_hash, r.status, k.key AS axis, stddev_pop(k.value::numeric) OVER (PARTITION BY r.matrix_group_id, k.key) AS stddev_score FROM harness_shared.llm_test_runs r, LATERAL jsonb_each_text(r.scores_json) k(key, value) WHERE r.matrix_group_id IS NOT NULL AND r.scores_json IS NOT NULL) s GROUP BY matrix_group_id, scenario_id, scenario_version, identity_hash`);

export const toolInvocationsArtifactsInHarnessShared = harnessShared.view("tool_invocations_artifacts", {	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }),
	workspaceId: text("workspace_id"),
	harnessSlug: text("harness_slug"),
	pluginName: text("plugin_name"),
	toolName: text("tool_name"),
	role: text(),
	featureId: text("feature_id"),
	chunkId: text("chunk_id"),
	runId: text("run_id"),
	spawnId: text("spawn_id"),
	invokedAt: timestamp("invoked_at", { withTimezone: true, mode: 'string' }),
	durationMs: integer("duration_ms"),
	status: text(),
	outputRef: text("output_ref"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	outputSize: bigint("output_size", { mode: "number" }),
}).as(sql`SELECT id, workspace_id, harness_slug, plugin_name, tool_name, role, feature_id, chunk_id, run_id, spawn_id, invoked_at, duration_ms, status, output_ref, output_size FROM harness_shared.tool_invocations WHERE output_ref IS NOT NULL AND output_ref <> ''::text AND status = 'ok'::text`);

export const toolInvocationsSpawnTreeInHarnessShared = harnessShared.view("tool_invocations_spawn_tree", {	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }),
	workspaceId: text("workspace_id"),
	harnessSlug: text("harness_slug"),
	pluginName: text("plugin_name"),
	toolName: text("tool_name"),
	role: text(),
	featureId: text("feature_id"),
	chunkId: text("chunk_id"),
	runId: text("run_id"),
	spawnId: text("spawn_id"),
	parentSpawnId: text("parent_spawn_id"),
	windowKey: text("window_key"),
	invokedAt: timestamp("invoked_at", { withTimezone: true, mode: 'string' }),
	durationMs: integer("duration_ms"),
	status: text(),
	outputRef: text("output_ref"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	outputSize: bigint("output_size", { mode: "number" }),
	errorMessage: text("error_message"),
	depth: integer(),
	rootSpawnId: text("root_spawn_id"),
}).as(sql`WITH RECURSIVE chain AS ( SELECT tool_invocations.id, tool_invocations.workspace_id, tool_invocations.harness_slug, tool_invocations.plugin_name, tool_invocations.tool_name, tool_invocations.role, tool_invocations.feature_id, tool_invocations.chunk_id, tool_invocations.run_id, tool_invocations.spawn_id, tool_invocations.parent_spawn_id, tool_invocations.window_key, tool_invocations.invoked_at, tool_invocations.duration_ms, tool_invocations.status, tool_invocations.output_ref, tool_invocations.output_size, tool_invocations.error_message, 0 AS depth, tool_invocations.spawn_id AS root_spawn_id FROM harness_shared.tool_invocations WHERE tool_invocations.parent_spawn_id IS NULL OR tool_invocations.parent_spawn_id = ''::text UNION ALL SELECT t.id, t.workspace_id, t.harness_slug, t.plugin_name, t.tool_name, t.role, t.feature_id, t.chunk_id, t.run_id, t.spawn_id, t.parent_spawn_id, t.window_key, t.invoked_at, t.duration_ms, t.status, t.output_ref, t.output_size, t.error_message, c.depth + 1, c.root_spawn_id FROM harness_shared.tool_invocations t JOIN chain c ON t.parent_spawn_id = c.spawn_id AND t.workspace_id = c.workspace_id AND c.depth < 16 ) SELECT id, workspace_id, harness_slug, plugin_name, tool_name, role, feature_id, chunk_id, run_id, spawn_id, parent_spawn_id, window_key, invoked_at, duration_ms, status, output_ref, output_size, error_message, depth, root_spawn_id FROM chain`);

export const harnessFeaturesInHarnessShared = harnessShared.view("harness_features", {	harnessSlug: text("harness_slug"),
	featureId: text("feature_id"),
	title: text(),
	summary: text(),
	status: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	attempts: bigint({ mode: "number" }),
	claims: text(),
	notes: text(),
	metadata: jsonb(),
	kind: text(),
	projectId: text("project_id"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	expectedCostCents: bigint("expected_cost_cents", { mode: "number" }),
	tags: jsonb(),
	needsHumanReview: boolean("needs_human_review"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdTs: bigint("created_ts", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedTs: bigint("updated_ts", { mode: "number" }),
	parentId: text("parent_id"),
	goalId: text("goal_id"),
	takenBy: text("taken_by"),
	takenAt: timestamp("taken_at", { withTimezone: true, mode: 'string' }),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }),
	workspaceId: text("workspace_id"),
	search: tsvectorCustom("_search"),
	deprecationReason: text("deprecation_reason"),
	seeAlso: text("see_also"),
	needsDesign: boolean("needs_design"),
	designStatus: text("design_status"),
	designSpecId: text("design_spec_id"),
	discardedDesignWork: boolean("discarded_design_work"),
	completionRef: jsonb("completion_ref"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdByGithubUserId: bigint("created_by_github_user_id", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	workingUsers: bigint("working_users", { mode: "number" }),
	workedByHistory: jsonb("worked_by_history"),
	wave: text(),
	verifiedDoneAtRemoteTs: timestamp("verified_done_at_remote_ts", { withTimezone: true, mode: 'string' }),
	verifierLastError: text("verifier_last_error"),
	verifierLastCheckedAt: timestamp("verifier_last_checked_at", { withTimezone: true, mode: 'string' }),
	sourcePlanSlug: text("source_plan_slug"),
	sourcePlanItemIds: text("source_plan_item_ids"),
	featureOrder: integer("feature_order"),
	authorPubkey: text("author_pubkey"),
	origin: text(),
	auditVerdict: text("audit_verdict"),
	auditReasons: text("audit_reasons"),
	auditedAt: timestamp("audited_at", { withTimezone: true, mode: 'string' }),
	itemKind: text("item_kind"),
	payload: jsonb(),
	assigneeRank: integer("assignee_rank"),
	rankWriter: text("rank_writer"),
	rankUpdatedAt: timestamp("rank_updated_at", { withTimezone: true, mode: 'string' }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	redundancy: integer(),
	swarmAffinity: text("swarm_affinity"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	verifiedAuthorGithubUserId: bigint("verified_author_github_user_id", { mode: "number" }),
	schedule: jsonb(),
	scheduleActive: boolean("schedule_active"),
	scheduledAt: timestamp("scheduled_at", { withTimezone: true, mode: 'string' }),
	tzid: text(),
	templateSlug: text("template_slug"),
	runSeq: integer("run_seq"),
	requeueCount: integer("requeue_count"),
	fedHlc: text("fed_hlc"),
	lastProgressAt: timestamp("last_progress_at", { withTimezone: true, mode: 'string' }),
	terminalOwner: text("terminal_owner"),
	terminalCompletionRef: text("terminal_completion_ref"),
	lastReleasedBy: text("last_released_by"),
	lastReleasedAt: timestamp("last_released_at", { withTimezone: true, mode: 'string' }),
}).as(sql`SELECT harness_slug, feature_id, title, summary, status, attempts, claims, notes, metadata, kind, project_id, expected_cost_cents, tags, needs_human_review, ts, created_ts, updated_ts, parent_id, goal_id, taken_by, taken_at, expires_at, workspace_id, _search, deprecation_reason, see_also, needs_design, design_status, design_spec_id, discarded_design_work, completion_ref, created_by_github_user_id, working_users, worked_by_history, wave, verified_done_at_remote_ts, verifier_last_error, verifier_last_checked_at, source_plan_slug, source_plan_item_ids, feature_order, author_pubkey, origin, audit_verdict, audit_reasons, audited_at, item_kind, payload, assignee_rank, rank_writer, rank_updated_at, fed_ts, redundancy, swarm_affinity, verified_author_github_user_id, schedule, schedule_active, scheduled_at, tzid, template_slug, run_seq, requeue_count, fed_hlc, last_progress_at, terminal_owner, terminal_completion_ref, last_released_by, last_released_at FROM harness_shared.harness_features_consolidated`);

export const harnessFeaturesConsolidatedInHarnessShared = harnessShared.view("harness_features_consolidated", {	harnessSlug: text("harness_slug"),
	featureId: text("feature_id"),
	title: text(),
	summary: text(),
	status: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	attempts: bigint({ mode: "number" }),
	claims: text(),
	notes: text(),
	metadata: jsonb(),
	kind: text(),
	projectId: text("project_id"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	expectedCostCents: bigint("expected_cost_cents", { mode: "number" }),
	tags: jsonb(),
	needsHumanReview: boolean("needs_human_review"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdTs: bigint("created_ts", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedTs: bigint("updated_ts", { mode: "number" }),
	parentId: text("parent_id"),
	goalId: text("goal_id"),
	takenBy: text("taken_by"),
	takenAt: timestamp("taken_at", { withTimezone: true, mode: 'string' }),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }),
	workspaceId: text("workspace_id"),
	search: tsvectorCustom("_search"),
	deprecationReason: text("deprecation_reason"),
	seeAlso: text("see_also"),
	needsDesign: boolean("needs_design"),
	designStatus: text("design_status"),
	designSpecId: text("design_spec_id"),
	discardedDesignWork: boolean("discarded_design_work"),
	completionRef: jsonb("completion_ref"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdByGithubUserId: bigint("created_by_github_user_id", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	workingUsers: bigint("working_users", { mode: "number" }),
	workedByHistory: jsonb("worked_by_history"),
	wave: text(),
	verifiedDoneAtRemoteTs: timestamp("verified_done_at_remote_ts", { withTimezone: true, mode: 'string' }),
	verifierLastError: text("verifier_last_error"),
	verifierLastCheckedAt: timestamp("verifier_last_checked_at", { withTimezone: true, mode: 'string' }),
	sourcePlanSlug: text("source_plan_slug"),
	sourcePlanItemIds: text("source_plan_item_ids"),
	featureOrder: integer("feature_order"),
	authorPubkey: text("author_pubkey"),
	origin: text(),
	auditVerdict: text("audit_verdict"),
	auditReasons: text("audit_reasons"),
	auditedAt: timestamp("audited_at", { withTimezone: true, mode: 'string' }),
	itemKind: text("item_kind"),
	payload: jsonb(),
	assigneeRank: integer("assignee_rank"),
	rankWriter: text("rank_writer"),
	rankUpdatedAt: timestamp("rank_updated_at", { withTimezone: true, mode: 'string' }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	redundancy: integer(),
	swarmAffinity: text("swarm_affinity"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	verifiedAuthorGithubUserId: bigint("verified_author_github_user_id", { mode: "number" }),
	schedule: jsonb(),
	scheduleActive: boolean("schedule_active"),
	scheduledAt: timestamp("scheduled_at", { withTimezone: true, mode: 'string' }),
	tzid: text(),
	templateSlug: text("template_slug"),
	runSeq: integer("run_seq"),
	requeueCount: integer("requeue_count"),
	fedHlc: text("fed_hlc"),
	lastProgressAt: timestamp("last_progress_at", { withTimezone: true, mode: 'string' }),
	terminalOwner: text("terminal_owner"),
	terminalCompletionRef: text("terminal_completion_ref"),
	lastReleasedBy: text("last_released_by"),
	lastReleasedAt: timestamp("last_released_at", { withTimezone: true, mode: 'string' }),
}).with({"checkOption":"cascaded"}).as(sql`SELECT harness_slug, feature_id, title, summary, status, attempts, claims, notes, metadata, kind, project_id, expected_cost_cents, tags, needs_human_review, ts, created_ts, updated_ts, parent_id, goal_id, taken_by, taken_at, expires_at, workspace_id, _search, deprecation_reason, see_also, needs_design, design_status, design_spec_id, discarded_design_work, completion_ref, created_by_github_user_id, working_users, worked_by_history, wave, verified_done_at_remote_ts, verifier_last_error, verifier_last_checked_at, source_plan_slug, source_plan_item_ids, feature_order, author_pubkey, origin, audit_verdict, audit_reasons, audited_at, item_kind, payload, assignee_rank, rank_writer, rank_updated_at, fed_ts, redundancy, swarm_affinity, verified_author_github_user_id, schedule, schedule_active, scheduled_at, tzid, template_slug, run_seq, requeue_count, fed_hlc, last_progress_at, terminal_owner, terminal_completion_ref, last_released_by, last_released_at FROM harness_shared.work_items WHERE item_kind <> ALL (ARRAY['bug'::text, 'change'::text, 'task'::text])`);

export const engineerIssuesInHarnessShared = harnessShared.view("engineer_issues", {	workspaceId: text("workspace_id"),
	issueId: text("issue_id"),
	scope: text(),
	title: text(),
	body: text(),
	severity: text(),
	source: text(),
	state: text(),
	assignee: text(),
	foundDuring: text("found_during"),
	linkedFeatureId: text("linked_feature_id"),
	createdBy: text("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }),
	authorPubkey: text("author_pubkey"),
	origin: text(),
	search: tsvectorCustom("_search"),
	kind: text(),
	payload: jsonb(),
	assignedBy: text("assigned_by"),
	assignedAt: timestamp("assigned_at", { withTimezone: true, mode: 'string' }),
	assigneeRank: integer("assignee_rank"),
	rankWriter: text("rank_writer"),
	rankUpdatedAt: timestamp("rank_updated_at", { withTimezone: true, mode: 'string' }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fedTs: bigint("fed_ts", { mode: "number" }),
	signalOrigin: text("signal_origin"),
	fedHlc: text("fed_hlc"),
	terminalOwner: text("terminal_owner"),
	terminalCompletionRef: text("terminal_completion_ref"),
	lastProgressAt: timestamp("last_progress_at", { withTimezone: true, mode: 'string' }),
	baseHarnessSlug: text("base_harness_slug"),
	baseOrigin: text("base_origin"),
}).as(sql`SELECT workspace_id, feature_id AS issue_id, CASE WHEN harness_slug ~~ 'operator:%'::text OR harness_slug = ''::text THEN 'operator'::text ELSE 'harness:'::text || harness_slug END AS scope, title, COALESCE(summary, ''::text) AS body, COALESCE((payload -> '_ei'::text) ->> 'severity'::text, 'minor'::text) AS severity, COALESCE((payload -> '_ei'::text) ->> 'source'::text, 'engineer'::text) AS source, status AS state, taken_by AS assignee, (payload -> '_ei'::text) ->> 'found_during'::text AS found_during, (payload -> '_ei'::text) ->> 'linked_feature_id'::text AS linked_feature_id, (payload -> '_ei'::text) ->> 'created_by'::text AS created_by, to_timestamp((created_ts::numeric / 1000.0)::double precision) AS created_at, to_timestamp((updated_ts::numeric / 1000.0)::double precision) AS updated_at, author_pubkey, origin, _search, item_kind AS kind, payload - '_ei'::text AS payload, (payload -> '_ei'::text) ->> 'assigned_by'::text AS assigned_by, taken_at AS assigned_at, assignee_rank, rank_writer, rank_updated_at, fed_ts, COALESCE((payload -> '_ei'::text) ->> 'signal_origin'::text, 'organic'::text) AS signal_origin, fed_hlc, terminal_owner, terminal_completion_ref, last_progress_at, harness_slug AS base_harness_slug, origin AS base_origin FROM harness_shared.work_items WHERE item_kind = ANY (ARRAY['bug'::text, 'change'::text, 'task'::text])`);

export const operatorDecisionsInHarnessShared = harnessShared.view("operator_decisions", {	id: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }),
	actor: text(),
	action: text(),
	target: text(),
	details: jsonb(),
	workspaceId: text("workspace_id"),
}).as(sql`SELECT id, ts, actor, action, subject AS target, details, workspace_id FROM harness_shared.audit_log WHERE actor = 'system:operator'::text`);

export const systemPrincipalActivityInHarnessShared = harnessShared.view("system_principal_activity", {	id: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }),
	actor: text(),
	action: text(),
	target: text(),
	details: jsonb(),
	workspaceId: text("workspace_id"),
}).as(sql`SELECT id, ts, actor, action, subject AS target, details, workspace_id FROM harness_shared.audit_log WHERE actor ~~ 'system:%'::text OR actor ~~ 'pi:%'::text`);