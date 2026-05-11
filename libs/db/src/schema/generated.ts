import { pgTable, pgSchema, text, jsonb, bigint, index, timestamp, bigserial, boolean, integer, foreignKey, check, numeric, pgPolicy, unique, uuid, uniqueIndex, doublePrecision, primaryKey } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

export const harnessShared = pgSchema("harness_shared");
export const papercupShared = pgSchema("papercup_shared");


export const operatorPausedInHarnessShared = harnessShared.table("operator_paused", {
	workspaceId: text("workspace_id").notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspaceId], name: "operator_paused_pkey"}),
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
	primaryKey({ columns: [table.clientId], name: "ui_clients_pkey"}),

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
}, (table) => [
	index("ui_intents_completed_idx").using("btree", table.completedAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(completed_at IS NOT NULL)`),
	index("ui_intents_pending_idx").using("btree", table.clientId.asc().nullsLast().op("int8_ops"), table.id.asc().nullsLast().op("int8_ops")).where(sql`(status = 'pending'::text)`),
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
	primaryKey({ columns: [table.workspaceId], name: "workspace_backup_settings_pkey"}),
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
]);

export const backupEventsInHarnessShared = harnessShared.table("backup_events", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	snapshotId: bigint("snapshot_id", { mode: "number" }),
	kind: text().notNull(),
	payloadJson: jsonb("payload_json"),
	at: timestamp({ withTimezone: true, mode: 'number' }).defaultNow().notNull(),
}, (table) => [
	index("backup_events_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.at.desc().nullsFirst().op("text_ops")),
	foreignKey({
			columns: [table.snapshotId],
			foreignColumns: [backupSnapshotsInHarnessShared.id],
			name: "backup_events_snapshot_id_fkey"
		}).onDelete("cascade"),
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
]);

export const oauthNoncesInHarnessShared = harnessShared.table("oauth_nonces", {
	nonce: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	expMs: bigint("exp_ms", { mode: "number" }).notNull(),
	consumed: boolean().default(false).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdAt: bigint("created_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	index("oauth_nonces_exp_idx").using("btree", table.expMs.asc().nullsLast().op("int8_ops")),
	primaryKey({ columns: [table.nonce], name: "oauth_nonces_pkey"}),

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

]);

export const mobilePairTokensInHarnessShared = harnessShared.table("mobile_pair_tokens", {
	pairToken: text("pair_token").notNull(),
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
	primaryKey({ columns: [table.pairToken], name: "mobile_pair_tokens_pkey"}),

]);

export const operatorRateLimitInHarnessShared = harnessShared.table("operator_rate_limit", {
	workspaceId: text("workspace_id").notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspaceId], name: "operator_rate_limit_pkey"}),
]);

export const messagesInPapercupShared = papercupShared.table("messages", {
	id: text().notNull(),
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
	primaryKey({ columns: [table.id], name: "messages_pkey"}),

]);

export const cooldownMarksInHarnessShared = harnessShared.table("cooldown_marks", {
	key: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	markedAtMs: bigint("marked_at_ms", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	index("cooldown_marks_marked_at_idx").using("btree", table.markedAtMs.asc().nullsLast().op("int8_ops")),
	primaryKey({ columns: [table.key], name: "cooldown_marks_pkey"}),

]);

export const voiceLeaseInHarnessShared = harnessShared.table("voice_lease", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	ownerId: text("owner_id").notNull(),
	ownerKind: text("owner_kind").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	expiresAtMs: bigint("expires_at_ms", { mode: "number" }).notNull(),
}, (table) => [
	index("voice_lease_expires_idx").using("btree", table.expiresAtMs.asc().nullsLast().op("int8_ops")),
	check("voice_lease_owner_kind_check", sql`owner_kind = ANY (ARRAY['desktop'::text, 'mobile'::text])`),
	primaryKey({ columns: [table.workspaceId], name: "voice_lease_pkey"}),

]);

export const operatorBudgetTiersInHarnessShared = harnessShared.table("operator_budget_tiers", {
	ord: integer().primaryKey().notNull(),
	label: text().notNull(),
	capUsd: numeric("cap_usd", { precision: 10, scale:  2 }).notNull(),
	blurb: text().notNull(),
});

export const operatorSettingsInHarnessShared = harnessShared.table("operator_settings", {
	key: text().primaryKey().notNull(),
	value: text().notNull(),
	description: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
});

export const orchestratorSettingsInHarnessShared = harnessShared.table("orchestrator_settings", {
	id: integer().default(1).primaryKey().notNull(),
	tiers: jsonb().default([1,2,4]).notNull(),
	labels: jsonb().default(["trivial","normal","hard"]).notNull(),
	rubric: text().default('').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedTs: bigint("updated_ts", { mode: "number" }).default(0).notNull(),
}, (table) => [
	check("orchestrator_settings_id_check", sql`id = 1`),
	primaryKey({ columns: [table.id], name: "orchestrator_settings_pkey"}),

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
	pgPolicy("plugin_enables_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("plugin_enables_workspace_nonempty", sql`workspace_id <> ''::text`),
	primaryKey({ columns: [table.harnessSlug, table.pluginSlug], name: "plugin_enables_pkey"}),

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
}, (table) => [
	index("hfp_harness_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.workspaceId, table.harnessSlug, table.featureId], name: "harness_feature_prs_pkey"}),

]);

export const featureAuditConsolidatedInHarnessShared = harnessShared.table("feature_audit_consolidated", {
	id: bigserial({ mode: "bigint" }).notNull(),
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
	primaryKey({ columns: [table.id], name: "feature_audit_consolidated_pkey"}),

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

]);

export const harnessExpertsInHarnessShared = harnessShared.table("harness_experts", {
	workspaceId: text("workspace_id").default('').notNull(),
	harnessSlug: text("harness_slug").notNull(),
	expertId: text("expert_id").notNull(),
	title: text().default('').notNull(),
	status: text().default('unknown').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	budgetCents: bigint("budget_cents", { mode: "number" }).default(0).notNull(),
	featureSize: text("feature_size"),
	highLevelSpec: text("high_level_spec").default('').notNull(),
	agentCount: integer("agent_count").default(0).notNull(),
	roundCount: integer("round_count").default(0).notNull(),
	personasUsed: jsonb("personas_used").default([]).notNull(),
	userEngaged: boolean("user_engaged").default(false).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdAt: bigint("created_at", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
	terminationReason: text("termination_reason"),
	specContent: text("spec_content").default('').notNull(),
	assertionsContent: text("assertions_content").default('').notNull(),
}, (table) => [
	index("he_recent_idx").using("btree", table.workspaceId.asc().nullsLast().op("int8_ops"), table.harnessSlug.asc().nullsLast().op("int8_ops"), table.updatedAt.desc().nullsFirst().op("int8_ops")),
	primaryKey({ columns: [table.workspaceId, table.harnessSlug, table.expertId], name: "harness_experts_pkey"}),

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
}, (table) => [
	index("tool_invocations_quota_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.toolName.asc().nullsLast().op("text_ops"), table.role.asc().nullsLast().op("text_ops"), table.windowKey.asc().nullsLast().op("text_ops")).where(sql`(status = 'ok'::text)`),
	index("tool_invocations_telemetry_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.invokedAt.desc().nullsFirst().op("text_ops")),
	pgPolicy("tool_invocations_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
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
}, (table) => [
	index("operator_turns_conv_seq_idx").using("btree", table.conversationId.asc().nullsLast().op("uuid_ops"), table.seq.asc().nullsLast().op("int4_ops")),
	foreignKey({
			columns: [table.conversationId],
			foreignColumns: [operatorConversationsInHarnessShared.id],
			name: "operator_turns_conversation_id_fkey"
		}).onDelete("cascade"),
	unique("operator_turns_conversation_id_seq_key").on(table.conversationId, table.seq),
	check("operator_turns_role_check", sql`role = ANY (ARRAY['user'::text, 'assistant'::text, 'system'::text])`),
	primaryKey({ columns: [table.id], name: "operator_turns_pkey"}),

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
}, (table) => [
	index("spawned_agents_parent_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.parentSpawnId.asc().nullsLast().op("text_ops")),
	index("spawned_agents_recent_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.startedAt.desc().nullsFirst().op("text_ops")),
	index("spawned_agents_running_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")).where(sql`(status = 'running'::text)`),
	pgPolicy("spawned_agents_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.spawnId], name: "spawned_agents_pkey"}),

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
}, (table) => [
	index("operator_conversations_active_idx").using("btree", sql`workspace_id`, sql`COALESCE(harness_slug, ''::text)`).where(sql`(status = 'active'::text)`),
	index("operator_conversations_started_idx").using("btree", table.workspaceId.asc().nullsLast().op("int8_ops"), table.startedAt.desc().nullsFirst().op("int8_ops")),
	primaryKey({ columns: [table.id], name: "operator_conversations_pkey"}),

]);

export const operatorSearchProviderCredentialsInHarnessShared = harnessShared.table("operator_search_provider_credentials", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().default({}).notNull(),
	// TODO: failed to parse database type 'bytea'
	payloadCt: text("payload_ct"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(sql`(EXTRACT(epoch FROM now()) * 1000)::bigint`).notNull(),
}, (table) => [
	pgPolicy("osc_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_search_provider_credentials_pkey"}),

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
}, (table) => [
	index("harness_project_files_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.harnessSlug], name: "harness_project_files_pkey"}),

]);

export const operatorScansInHarnessShared = harnessShared.table("operator_scans", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	endedAt: timestamp("ended_at", { withTimezone: true, mode: 'string' }),
	agentSessionId: text("agent_session_id"),
	requestText: text("request_text"),
	summary: text(),
	suggestions: jsonb().default([]).notNull(),
	suggestionCount: integer("suggestion_count").default(0).notNull(),
	costUsd: numeric("cost_usd", { precision: 10, scale:  4 }).default('0').notNull(),
	cached: boolean().default(false).notNull(),
	error: text(),
}, (table) => [
	index("operator_scans_session_idx").using("btree", table.agentSessionId.asc().nullsLast().op("text_ops")).where(sql`(agent_session_id IS NOT NULL)`),
	index("operator_scans_ws_started_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.startedAt.desc().nullsFirst().op("text_ops")),
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

export const delegateInboxInHarnessShared = harnessShared.table("delegate_inbox", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	deliveredAt: timestamp("delivered_at", { withTimezone: true, mode: 'string' }),
	kind: text().default('delegate-complete').notNull(),
	headline: text().notNull(),
	agentSessionId: text("agent_session_id"),
}, (table) => [
	index("delegate_inbox_ws_pending_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.createdAt.asc().nullsLast().op("text_ops")).where(sql`(delivered_at IS NULL)`),
]);

export const operatorSecretsInHarnessShared = harnessShared.table("operator_secrets", {
	name: text().primaryKey().notNull(),
	valueB64: text("value_b64").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	rotatedAt: timestamp("rotated_at", { withTimezone: true, mode: 'string' }),
});

export const spawnSigVerificationFailuresInHarnessShared = harnessShared.table("spawn_sig_verification_failures", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	ts: timestamp({ withTimezone: true, mode: 'number' }).defaultNow().notNull(),
	reason: text().notNull(),
	claimedRole: text("claimed_role"),
	claimedHarness: text("claimed_harness"),
	claimedWorkspace: text("claimed_workspace"),
	claimedSpawn: text("claimed_spawn"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	expClaim: bigint("exp_claim", { mode: "number" }),
	remoteAddr: text("remote_addr"),
	userAgent: text("user_agent"),
}, (table) => [
	index("spawn_sig_failures_reason_idx").using("btree", table.reason.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("text_ops")),
	index("spawn_sig_failures_ts_idx").using("btree", table.ts.desc().nullsFirst().op("timestamptz_ops")),
]);

export const briefingsInPapercupShared = papercupShared.table("briefings", {
	id: text().notNull(),
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
	primaryKey({ columns: [table.id], name: "briefings_pkey"}),
]);

export const directiveSummariesInPapercupShared = papercupShared.table("directive_summaries", {
	id: text().notNull(),
	directiveId: text("directive_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).notNull(),
	author: text().default('ceo').notNull(),
	body: text().notNull(),
}, (table) => [
	index("summaries_directive_idx").using("btree", table.directiveId.asc().nullsLast().op("text_ops")),
	index("summaries_ts_idx").using("btree", table.ts.asc().nullsLast().op("int8_ops")),
	primaryKey({ columns: [table.id], name: "directive_summaries_pkey"}),

]);

export const messageCommentsInPapercupShared = papercupShared.table("message_comments", {
	id: text().notNull(),
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
			foreignColumns: [messagesInPapercupShared.id],
			name: "message_comments_message_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.id], name: "message_comments_pkey"}),

]);

export const pluginConfigsInHarnessShared = harnessShared.table("plugin_configs", {
	harnessSlug: text("harness_slug").notNull(),
	pluginSlug: text("plugin_slug").notNull(),
	config: jsonb().default({}).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	workspaceId: text("workspace_id").notNull(),
	// TODO: failed to parse database type 'bytea'
	configCt: text("config_ct"),
}, (table) => [
	index("plugin_configs_plugin_idx").using("btree", table.pluginSlug.asc().nullsLast().op("text_ops")),
	index("plugin_configs_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	pgPolicy("plugin_configs_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("plugin_configs_workspace_nonempty", sql`workspace_id <> ''::text`),
	primaryKey({ columns: [table.harnessSlug, table.pluginSlug], name: "plugin_configs_pkey"}),

]);

export const directivesInPapercupShared = papercupShared.table("directives", {
	id: text().notNull(),
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
	primaryKey({ columns: [table.id], name: "directives_pkey"}),

]);

export const messageRecipientsInPapercupShared = papercupShared.table("message_recipients", {
	messageId: text("message_id").notNull(),
	deptSlug: text("dept_slug").notNull(),
}, (table) => [
	index("recipients_dept_idx").using("btree", table.deptSlug.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.messageId],
			foreignColumns: [messagesInPapercupShared.id],
			name: "message_recipients_message_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.messageId, table.deptSlug], name: "message_recipients_pkey"}),

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
]);

export const delegatesInHarnessShared = harnessShared.table("delegates", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	workspace: text().notNull(),
	agentSessionId: text("agent_session_id").notNull(),
	title: text(),
	summary: text(),
	status: text().default('open').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lastActiveAt: timestamp("last_active_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	turnCount: integer("turn_count").default(0).notNull(),
	origin: text().notNull(),
	initiatorMsg: text("initiator_msg"),
	transcript: jsonb().default([]).notNull(),
}, (table) => [
	index("delegates_open_ws_idx").using("btree", table.workspace.asc().nullsLast().op("text_ops"), table.lastActiveAt.desc().nullsFirst().op("timestamptz_ops")).where(sql`(status = 'open'::text)`),
	index("delegates_status_idx").using("btree", table.status.asc().nullsLast().op("text_ops"), table.lastActiveAt.desc().nullsFirst().op("text_ops")),
	unique("claude_sessions_agent_session_id_key").on(table.agentSessionId),
]);

export const elConvCallsInHarnessShared = harnessShared.table("el_conv_calls", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	ts: timestamp({ withTimezone: true, mode: 'number' }).defaultNow().notNull(),
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
	ts: timestamp({ withTimezone: true, mode: 'number' }).defaultNow().notNull(),
	agent: text().notNull(),
	commandId: text("command_id").notNull(),
	args: jsonb().default({}).notNull(),
	status: text().notNull(),
	errorCode: text("error_code"),
	durationMs: integer("duration_ms"),
	workspace: text(),
	sessionId: text("session_id"),
	requestId: text("request_id"),
}, (table) => [
	index("agent_actions_agent_ts_idx").using("btree", table.agent.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("text_ops")),
	index("agent_actions_id_ts_idx").using("btree", table.commandId.asc().nullsLast().op("timestamptz_ops"), table.ts.desc().nullsFirst().op("text_ops")),
	index("agent_actions_ts_idx").using("btree", table.ts.desc().nullsFirst().op("timestamptz_ops")),
	index("agent_actions_ws_ts_idx").using("btree", table.workspace.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("text_ops")),
]);

export const agentQueriesInHarnessShared = harnessShared.table("agent_queries", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	ts: timestamp({ withTimezone: true, mode: 'number' }).defaultNow().notNull(),
	agent: text().notNull(),
	queryId: text("query_id").notNull(),
	argsCompact: jsonb("args_compact"),
	workspace: text(),
	requestId: text("request_id"),
}, (table) => [
	index("agent_queries_agent_id_ts").using("btree", table.agent.asc().nullsLast().op("text_ops"), table.queryId.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("timestamptz_ops")),
	index("agent_queries_ts_idx").using("btree", table.ts.desc().nullsFirst().op("timestamptz_ops")),
]);

export const goalsInHarnessShared = harnessShared.table("goals", {
	id: text().notNull(),
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
	// TODO: failed to parse database type 'tsvector'
	search: text("_search").generatedAlwaysAs(sql`(setweight(to_tsvector('english'::regconfig, COALESCE(title, ''::text)), 'A'::"char") || setweight(to_tsvector('english'::regconfig, COALESCE(body, ''::text)), 'B'::"char"))`),
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
	primaryKey({ columns: [table.id], name: "goals_pkey"}),

]);

export const pendingEventsInHarnessShared = harnessShared.table("pending_events", {
	id: text().notNull(),
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
	primaryKey({ columns: [table.id], name: "pending_events_pkey"}),

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

export const routinesInHarnessShared = harnessShared.table("routines", {
	id: text().notNull(),
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
}, (table) => [
	index("routines_active_due_idx").using("btree", table.active.asc().nullsLast().op("timestamptz_ops"), table.nextFireAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(active = true)`),
	index("routines_install_idx").using("btree", table.installSlug.asc().nullsLast().op("text_ops")),
	index("routines_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	pgPolicy("routines_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("routines_workspace_nonempty", sql`workspace_id <> ''::text`),
	primaryKey({ columns: [table.id], name: "routines_pkey"}),

]);

export const tokenIndexInHarnessShared = harnessShared.table("token_index", {
	token: text().notNull(),
	harnessSlug: text("harness_slug").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	workspaceId: text("workspace_id").notNull(),
	kind: text().default('harness').notNull(),
}, (table) => [
	index("token_index_kind_idx").using("btree", table.kind.asc().nullsLast().op("text_ops")),
	index("token_index_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	pgPolicy("token_index_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("token_index_workspace_nonempty", sql`workspace_id <> ''::text`),
	primaryKey({ columns: [table.token], name: "token_index_pkey"}),

]);

export const auditLogInHarnessShared = harnessShared.table("audit_log", {
	id: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).notNull(),
	actor: text().default('user').notNull(),
	action: text().notNull(),
	subject: text().notNull(),
	details: jsonb(),
	workspaceId: text("workspace_id").notNull(),
	// TODO: failed to parse database type 'tsvector'
	search: text("_search").generatedAlwaysAs(sql`((setweight(to_tsvector('simple'::regconfig, COALESCE(subject, ''::text)), 'A'::"char") || setweight(to_tsvector('simple'::regconfig, COALESCE(action, ''::text)), 'B'::"char")) || setweight(to_tsvector('simple'::regconfig, COALESCE(actor, ''::text)), 'C'::"char"))`),
}, (table) => [
	index("audit_action_idx").using("btree", table.action.asc().nullsLast().op("text_ops")),
	index("audit_actor_action_ts_idx").using("btree", table.actor.asc().nullsLast().op("int8_ops"), table.action.asc().nullsLast().op("int8_ops"), table.ts.desc().nullsFirst().op("int8_ops")),
	index("audit_search_idx").using("gin", table.search.asc().nullsLast().op("tsvector_ops")),
	index("audit_subject_ts_idx").using("btree", table.subject.asc().nullsLast().op("int8_ops"), table.ts.desc().nullsFirst().op("text_ops")),
	index("audit_ts_idx").using("btree", table.ts.asc().nullsLast().op("int8_ops")),
	index("audit_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	pgPolicy("audit_log_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("audit_workspace_nonempty", sql`workspace_id <> ''::text`),
	primaryKey({ columns: [table.id], name: "audit_log_pkey"}),

]);

export const projectSpecRevisionsInHarnessShared = harnessShared.table("project_spec_revisions", {
	id: bigserial({ mode: "bigint" }).notNull(),
	projectId: text("project_id").notNull(),
	spec: text().notNull(),
	summary: text(),
	authorRole: text("author_role").notNull(),
	author: text(),
	ts: timestamp({ withTimezone: true, mode: 'number' }).defaultNow().notNull(),
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
	primaryKey({ columns: [table.id], name: "project_spec_revisions_pkey"}),

]);

export const projectsInHarnessShared = harnessShared.table("projects", {
	id: text().notNull(),
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
	// TODO: failed to parse database type 'tsvector'
	search: text("_search").generatedAlwaysAs(sql`(setweight(to_tsvector('english'::regconfig, COALESCE(name, ''::text)), 'A'::"char") || setweight(to_tsvector('english'::regconfig, COALESCE(slug, ''::text)), 'B'::"char"))`),
}, (table) => [
	index("projects_parent_idx").using("btree", table.parentSlug.asc().nullsLast().op("text_ops")),
	index("projects_search_idx").using("gin", table.search.asc().nullsLast().op("tsvector_ops")),
	uniqueIndex("projects_slug_idx").using("btree", table.slug.asc().nullsLast().op("text_ops")),
	index("projects_status_idx").using("btree", table.status.asc().nullsLast().op("text_ops")),
	index("projects_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	pgPolicy("projects_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("projects_workspace_nonempty", sql`workspace_id <> ''::text`),
	primaryKey({ columns: [table.id], name: "projects_pkey"}),

]);

export const voiceUtterancesInHarnessShared = harnessShared.table("voice_utterances", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	ts: timestamp({ withTimezone: true, mode: 'number' }).defaultNow().notNull(),
	workspace: text(),
	source: text().notNull(),
	mode: text(),
	lengthChars: integer("length_chars"),
	nameUsed: boolean("name_used").default(false).notNull(),
	hadBackstory: boolean("had_backstory").default(false).notNull(),
	modifications: jsonb(),
}, (table) => [
	index("voice_utterances_mode_idx").using("btree", table.mode.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("text_ops")),
	index("voice_utterances_ts_idx").using("btree", table.ts.desc().nullsFirst().op("timestamptz_ops")),
]);

export const operatorScanLocksInHarnessShared = harnessShared.table("operator_scan_locks", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	holderId: text("holder_id").notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table) => [
	index("operator_scan_locks_expires_idx").using("btree", table.expiresAt.asc().nullsLast().op("timestamptz_ops")),
	pgPolicy("operator_scan_locks_workspace_iso", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	primaryKey({ columns: [table.workspaceId], name: "operator_scan_locks_pkey"}),

]);

export const orgCharterInHarnessShared = harnessShared.table("org_charter", {
	orgId: text("org_id").notNull(),
	content: text().default('').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	mtimeMs: bigint("mtime_ms", { mode: "number" }).default(0).notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
}, (table) => [
	primaryKey({ columns: [table.orgId], name: "org_charter_pkey"}),
]);

export const orgNotesInHarnessShared = harnessShared.table("org_notes", {
	orgId: text("org_id").notNull(),
	deptSlug: text("dept_slug").notNull(),
	content: text().default('').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	mtimeMs: bigint("mtime_ms", { mode: "number" }).default(0).notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
}, (table) => [
	primaryKey({ columns: [table.orgId, table.deptSlug], name: "org_notes_pkey"}),
]);

export const operatorCredentialsInHarnessShared = harnessShared.table("operator_credentials", {
	workspaceId: text("workspace_id").notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
	// TODO: failed to parse database type 'bytea'
	payloadCt: text("payload_ct"),
}, (table) => [
	primaryKey({ columns: [table.workspaceId], name: "operator_credentials_pkey"}),
]);

export const orgDecisionsInHarnessShared = harnessShared.table("org_decisions", {
	orgId: text("org_id").notNull(),
	deptSlug: text("dept_slug").notNull(),
	content: text().default('').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	mtimeMs: bigint("mtime_ms", { mode: "number" }).default(0).notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
}, (table) => [
	primaryKey({ columns: [table.orgId, table.deptSlug], name: "org_decisions_pkey"}),
]);

export const operatorBudgetInHarnessShared = harnessShared.table("operator_budget", {
	workspaceId: text("workspace_id").notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspaceId], name: "operator_budget_pkey"}),
]);

export const operatorPublishCredentialsInHarnessShared = harnessShared.table("operator_publish_credentials", {
	workspaceId: text("workspace_id").notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
	// TODO: failed to parse database type 'bytea'
	payloadCt: text("payload_ct"),
}, (table) => [
	primaryKey({ columns: [table.workspaceId], name: "operator_publish_credentials_pkey"}),
]);

export const operatorVoiceCredentialsInHarnessShared = harnessShared.table("operator_voice_credentials", {
	workspaceId: text("workspace_id").notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
	// TODO: failed to parse database type 'bytea'
	payloadCt: text("payload_ct"),
}, (table) => [
	primaryKey({ columns: [table.workspaceId], name: "operator_voice_credentials_pkey"}),
]);

export const operatorMarketplaceTokenInHarnessShared = harnessShared.table("operator_marketplace_token", {
	workspaceId: text("workspace_id").notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
	// TODO: failed to parse database type 'bytea'
	payloadCt: text("payload_ct"),
}, (table) => [
	primaryKey({ columns: [table.workspaceId], name: "operator_marketplace_token_pkey"}),
]);

export const harnessEscalationsInHarnessShared = harnessShared.table("harness_escalations", {
	harnessSlug: text("harness_slug").notNull(),
	phase: text().default('staging').notNull(),
	escalation: text(),
	supervisorNotes: text("supervisor_notes"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	mtimeMs: bigint("mtime_ms", { mode: "number" }).default(0).notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
}, (table) => [
	primaryKey({ columns: [table.harnessSlug, table.phase], name: "harness_escalations_pkey"}),
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
]);

export const harnessPhasesInHarnessShared = harnessShared.table("harness_phases", {
	harnessSlug: text("harness_slug").notNull(),
	phase: text().notNull(),
	phasePath: text("phase_path").default('').notNull(),
	branch: text(),
	port: integer(),
	publicUrl: text("public_url"),
	existsOnDisk: boolean("exists_on_disk").default(false).notNull(),
	alive: boolean().default(false).notNull(),
	passedCount: integer("passed_count").default(0).notNull(),
	totalCount: integer("total_count").default(0).notNull(),
	costUsd: doublePrecision("cost_usd").default(0).notNull(),
	iteration: integer().default(0).notNull(),
	promotionInFlight: boolean("promotion_in_flight").default(false).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	mtimeMs: bigint("mtime_ms", { mode: "number" }).default(0).notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
}, (table) => [
	primaryKey({ columns: [table.harnessSlug, table.phase], name: "harness_phases_pkey"}),
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
]);

export const orgDepartmentsInHarnessShared = harnessShared.table("org_departments", {
	orgId: text("org_id").notNull(),
	deptSlug: text("dept_slug").notNull(),
	harnessSlug: text("harness_slug").default('').notNull(),
	name: text().default('').notNull(),
	mandate: text().default('').notNull(),
	inboxKinds: jsonb("inbox_kinds").default([]).notNull(),
	outboxKinds: jsonb("outbox_kinds").default([]).notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	mtimeMs: bigint("mtime_ms", { mode: "number" }).default(0).notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
}, (table) => [
	primaryKey({ columns: [table.orgId, table.deptSlug], name: "org_departments_pkey"}),
]);

export const orgProjectsInHarnessShared = harnessShared.table("org_projects", {
	orgId: text("org_id").notNull(),
	projectId: text("project_id").notNull(),
	slug: text().default('').notNull(),
	name: text().default('').notNull(),
	vertical: text().default('').notNull(),
	status: text().default('').notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	mtimeMs: bigint("mtime_ms", { mode: "number" }).default(0).notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
}, (table) => [
	primaryKey({ columns: [table.orgId, table.projectId], name: "org_projects_pkey"}),
]);

export const orgInboxInHarnessShared = harnessShared.table("org_inbox", {
	orgId: text("org_id").notNull(),
	deptSlug: text("dept_slug").notNull(),
	messageId: text("message_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).default(0).notNull(),
	msgFrom: text("msg_from").default('').notNull(),
	msgTo: jsonb("msg_to").default([]).notNull(),
	kind: text().default('').notNull(),
	subject: text().default('').notNull(),
	body: text().default('').notNull(),
	refId: text("ref_id"),
	projectId: text("project_id"),
	directiveId: text("directive_id"),
	status: text().default('pending').notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	mtimeMs: bigint("mtime_ms", { mode: "number" }).default(0).notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
}, (table) => [
	primaryKey({ columns: [table.orgId, table.deptSlug, table.messageId], name: "org_inbox_pkey"}),
]);

export const orgOutboxInHarnessShared = harnessShared.table("org_outbox", {
	orgId: text("org_id").notNull(),
	deptSlug: text("dept_slug").notNull(),
	messageId: text("message_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).default(0).notNull(),
	msgFrom: text("msg_from").default('').notNull(),
	msgTo: jsonb("msg_to").default([]).notNull(),
	kind: text().default('').notNull(),
	subject: text().default('').notNull(),
	body: text().default('').notNull(),
	refId: text("ref_id"),
	projectId: text("project_id"),
	directiveId: text("directive_id"),
	status: text().default('pending').notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	mtimeMs: bigint("mtime_ms", { mode: "number" }).default(0).notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
}, (table) => [
	primaryKey({ columns: [table.orgId, table.deptSlug, table.messageId], name: "org_outbox_pkey"}),
]);

export const operatorLastScanInHarnessShared = harnessShared.table("operator_last_scan", {
	workspaceId: text("workspace_id").notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspaceId], name: "operator_last_scan_pkey"}),
]);

export const operatorStandingCandidatesInHarnessShared = harnessShared.table("operator_standing_candidates", {
	workspaceId: text("workspace_id").notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspaceId], name: "operator_standing_candidates_pkey"}),
]);

export const operatorIdleSnapshotInHarnessShared = harnessShared.table("operator_idle_snapshot", {
	workspaceId: text("workspace_id").notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspaceId], name: "operator_idle_snapshot_pkey"}),
]);

export const operatorTtsSpendInHarnessShared = harnessShared.table("operator_tts_spend", {
	workspaceId: text("workspace_id").notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspaceId], name: "operator_tts_spend_pkey"}),
]);

export const operatorSttSpendInHarnessShared = harnessShared.table("operator_stt_spend", {
	workspaceId: text("workspace_id").notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspaceId], name: "operator_stt_spend_pkey"}),
]);

export const operatorVoicePrefsInHarnessShared = harnessShared.table("operator_voice_prefs", {
	workspaceId: text("workspace_id").notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspaceId], name: "operator_voice_prefs_pkey"}),
]);

export const operatorAgentConfigInHarnessShared = harnessShared.table("operator_agent_config", {
	workspaceId: text("workspace_id").notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspaceId], name: "operator_agent_config_pkey"}),
]);

export const operatorScannerSessionInHarnessShared = harnessShared.table("operator_scanner_session", {
	workspaceId: text("workspace_id").notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspaceId], name: "operator_scanner_session_pkey"}),
]);

export const operatorFirstRunInHarnessShared = harnessShared.table("operator_first_run", {
	workspaceId: text("workspace_id").notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspaceId], name: "operator_first_run_pkey"}),
]);

export const operatorUserProfileInHarnessShared = harnessShared.table("operator_user_profile", {
	workspaceId: text("workspace_id").notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspaceId], name: "operator_user_profile_pkey"}),
]);

export const operatorPromptUserInHarnessShared = harnessShared.table("operator_prompt_user", {
	workspaceId: text("workspace_id").notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspaceId], name: "operator_prompt_user_pkey"}),
]);

export const operatorPreferencesInHarnessShared = harnessShared.table("operator_preferences", {
	workspaceId: text("workspace_id").notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspaceId], name: "operator_preferences_pkey"}),
]);

export const operatorOraclePromptInHarnessShared = harnessShared.table("operator_oracle_prompt", {
	workspaceId: text("workspace_id").notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspaceId], name: "operator_oracle_prompt_pkey"}),
]);

export const operatorOracleMemoryInHarnessShared = harnessShared.table("operator_oracle_memory", {
	workspaceId: text("workspace_id").notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspaceId], name: "operator_oracle_memory_pkey"}),
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
	primaryKey({ columns: [table.harnessSlug], name: "harness_smoke_test_pkey"}),
]);

export const harnessPlanReviewInHarnessShared = harnessShared.table("harness_plan_review", {
	harnessSlug: text("harness_slug").primaryKey().notNull(),
	content: text().default('').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	mtimeMs: bigint("mtime_ms", { mode: "number" }).default(0).notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
}, (table) => [
	primaryKey({ columns: [table.harnessSlug], name: "harness_plan_review_pkey"}),
]);

export const harnessHealthInHarnessShared = harnessShared.table("harness_health", {
	harnessSlug: text("harness_slug").primaryKey().notNull(),
	specPresent: boolean("spec_present").default(false).notNull(),
	contractPresent: boolean("contract_present").default(false).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	lastCheckMs: bigint("last_check_ms", { mode: "number" }).default(0).notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
}, (table) => [
	primaryKey({ columns: [table.harnessSlug], name: "harness_health_pkey"}),
]);

export const provisionAuditLogInHarnessShared = harnessShared.table("provision_audit_log", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	workspaceId: text("workspace_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	pluginSlug: text("plugin_slug").notNull(),
	ts: timestamp({ withTimezone: true, mode: 'number' }).defaultNow().notNull(),
	kind: text().notNull(),
	runId: text("run_id"),
	data: jsonb(),
}, (table) => [
	index("provision_audit_log_target_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.pluginSlug.asc().nullsLast().op("text_ops"), table.ts.asc().nullsLast().op("text_ops")),
]);

export const harnessRegistryInHarnessShared = harnessShared.table("harness_registry", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspaceId], name: "harness_registry_pkey"}),
]);

export const operatorTrustStoreInHarnessShared = harnessShared.table("operator_trust_store", {
	workspaceId: text("workspace_id").primaryKey().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
	// TODO: failed to parse database type 'bytea'
	payloadCt: text("payload_ct"),
}, (table) => [
	primaryKey({ columns: [table.workspaceId], name: "operator_trust_store_pkey"}),
]);

export const operatorDismissedCardsInHarnessShared = harnessShared.table("operator_dismissed_cards", {
	workspaceId: text("workspace_id").notNull(),
	cardId: text("card_id").notNull(),
	dismissedAt: timestamp("dismissed_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("operator_dismissed_cards_dismissed_at_idx").using("btree", table.dismissedAt.asc().nullsLast().op("timestamptz_ops")),
	primaryKey({ columns: [table.workspaceId, table.cardId], name: "operator_dismissed_cards_pkey"}),
	pgPolicy("operator_dismissed_cards_workspace_iso", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const mobilePushTokensInHarnessShared = harnessShared.table("mobile_push_tokens", {
	deviceId: text("device_id").notNull(),
	platform: text().notNull(),
	token: text().notNull(),
	registeredAt: timestamp("registered_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
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

export const pluginReloadStateInHarnessShared = harnessShared.table("plugin_reload_state", {
	pluginId: text("plugin_id").notNull(),
	harnessSlug: text("harness_slug").notNull(),
	state: jsonb().notNull(),
	byteSize: integer("byte_size").notNull(),
	savedAt: timestamp("saved_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.pluginId, table.harnessSlug], name: "plugin_reload_state_pkey"}),
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

export const harnessBranchActionsInHarnessShared = harnessShared.table("harness_branch_actions", {
	harnessSlug: text("harness_slug").notNull(),
	branch: text().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	lastCheckMs: bigint("last_check_ms", { mode: "number" }).default(0).notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
}, (table) => [
	primaryKey({ columns: [table.harnessSlug, table.branch], name: "harness_branch_actions_pkey"}),
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
]);

export const harnessDispatchesInHarnessShared = harnessShared.table("harness_dispatches", {
	workspaceId: text("workspace_id").default('default').notNull(),
	parentSlug: text("parent_slug").notNull(),
	childSlug: text("child_slug").notNull(),
	childRole: text("child_role"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	dispatchAt: bigint("dispatch_at", { mode: "number" }).notNull(),
	resultBody: jsonb("result_body"),
}, (table) => [
	index("harness_dispatches_parent_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.parentSlug.asc().nullsLast().op("text_ops"), table.dispatchAt.desc().nullsFirst().op("text_ops")),
	primaryKey({ columns: [table.workspaceId, table.parentSlug, table.childSlug, table.dispatchAt], name: "harness_dispatches_pkey"}),
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
]);

export const autoloopStateInHarnessShared = harnessShared.table("autoloop_state", {
	harnessSlug: text("harness_slug").notNull(),
	role: text().default('director').notNull(),
	lastFiredAt: timestamp("last_fired_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lastStatus: text("last_status"),
	consecutiveErrors: integer("consecutive_errors").default(0).notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
}, (table) => [
	primaryKey({ columns: [table.harnessSlug, table.role], name: "autoloop_state_pkey"}),
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

export const harnessSummariesInHarnessShared = harnessShared.table("harness_summaries", {
	harnessSlug: text("harness_slug").notNull(),
	content: text().default('').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	mtimeMs: bigint("mtime_ms", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
	phase: text().default('staging').notNull(),
}, (table) => [
	index("harness_summaries_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.harnessSlug, table.phase], name: "harness_summaries_pkey"}),
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

export const harnessBrainstormInHarnessShared = harnessShared.table("harness_brainstorm", {
	harnessSlug: text("harness_slug").notNull(),
	phase: text().default('staging').notNull(),
	content: text().default('').notNull(),
	canvas: jsonb(),
	mindmap: jsonb(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
}, (table) => [
	index("harness_brainstorm_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.harnessSlug, table.phase], name: "harness_brainstorm_pkey"}),
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
]);

export const harnessExpertFeedbackInHarnessShared = harnessShared.table("harness_expert_feedback", {
	workspaceId: text("workspace_id").default('default').notNull(),
	harnessSlug: text("harness_slug").notNull(),
	expertId: text("expert_id").notNull(),
	feedbackId: text("feedback_id").notNull(),
	persona: text().notNull(),
	verdict: jsonb(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdAt: bigint("created_at", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	endedAt: bigint("ended_at", { mode: "number" }),
}, (table) => [
	index("harness_expert_feedback_expert_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.expertId.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.workspaceId, table.harnessSlug, table.expertId, table.feedbackId], name: "harness_expert_feedback_pkey"}),
]);

export const harnessExpertTurnsInHarnessShared = harnessShared.table("harness_expert_turns", {
	workspaceId: text("workspace_id").default('default').notNull(),
	harnessSlug: text("harness_slug").notNull(),
	expertId: text("expert_id").notNull(),
	feedbackId: text("feedback_id").notNull(),
	turnIdx: integer("turn_idx").notNull(),
	speaker: text().notNull(),
	body: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdAt: bigint("created_at", { mode: "number" }).notNull(),
}, (table) => [
	index("harness_expert_turns_fb_idx").using("btree", table.workspaceId.asc().nullsLast().op("int4_ops"), table.harnessSlug.asc().nullsLast().op("text_ops"), table.expertId.asc().nullsLast().op("text_ops"), table.feedbackId.asc().nullsLast().op("int4_ops"), table.turnIdx.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.workspaceId, table.harnessSlug, table.expertId, table.feedbackId, table.turnIdx], name: "harness_expert_turns_pkey"}),
	check("harness_expert_turns_speaker_check", sql`speaker = ANY (ARRAY['expert'::text, 'feedback'::text])`),
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

export const harnessGitLogInHarnessShared = harnessShared.table("harness_git_log", {
	harnessSlug: text("harness_slug").notNull(),
	sha: text().notNull(),
	parents: jsonb().default([]).notNull(),
	subject: text().default('').notNull(),
	author: text().default('').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).default(0).notNull(),
	refs: jsonb().default([]).notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
}, (table) => [
	index("harness_git_log_slug_ts_idx").using("btree", table.harnessSlug.asc().nullsLast().op("int8_ops"), table.ts.desc().nullsFirst().op("int8_ops")),
	primaryKey({ columns: [table.harnessSlug, table.sha], name: "harness_git_log_pkey"}),
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
]);

export const operatorClaimsInHarnessShared = harnessShared.table("operator_claims", {
	harnessSlug: text("harness_slug").notNull(),
	pluginSlug: text("plugin_slug").notNull(),
	machineId: text("machine_id").notNull(),
	pid: integer().notNull(),
	runId: text("run_id").notNull(),
	scriptHash: text("script_hash").notNull(),
	claimedAt: timestamp("claimed_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	workspaceId: text("workspace_id").default('').notNull(),
}, (table) => [
	primaryKey({ columns: [table.harnessSlug, table.pluginSlug], name: "operator_claims_pkey"}),
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
}, (table) => [
	index("harness_decisions_slug_ts_idx").using("btree", table.harnessSlug.asc().nullsLast().op("int8_ops"), table.ts.asc().nullsLast().op("int8_ops")),
	primaryKey({ columns: [table.harnessSlug, table.lineHash], name: "harness_decisions_pkey"}),
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
	check("harness_status_status_check", sql`status = ANY (ARRAY['idle'::text, 'running'::text, 'stalled'::text, 'paused'::text, 'error'::text])`),
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
}, (table) => [
	index("arc_feature_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.featureId.asc().nullsLast().op("text_ops")),
	index("arc_role_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.role.asc().nullsLast().op("text_ops")),
	index("arc_running_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.running.asc().nullsLast().op("text_ops")).where(sql`(running = true)`),
	index("arc_ts_idx").using("btree", table.harnessSlug.asc().nullsLast().op("int8_ops"), table.ts.desc().nullsFirst().op("int8_ops")),
	primaryKey({ columns: [table.harnessSlug, table.runId], name: "agent_runs_consolidated_pkey"}),
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
}, (table) => [
	index("hic_found_during_idx").using("btree", table.foundDuring.asc().nullsLast().op("text_ops")),
	index("hic_linked_idx").using("btree", table.linkedFeatureId.asc().nullsLast().op("text_ops")),
	index("hic_severity_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.severity.asc().nullsLast().op("text_ops")),
	index("hic_status_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.harnessSlug, table.issueId], name: "harness_issues_consolidated_pkey"}),
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

export const harnessFeaturesConsolidatedInHarnessShared = harnessShared.table("harness_features_consolidated", {
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
	// TODO: failed to parse database type 'tsvector'
	search: text("_search").generatedAlwaysAs(sql`((setweight(to_tsvector('english'::regconfig, COALESCE(title, ''::text)), 'A'::"char") || setweight(to_tsvector('english'::regconfig, COALESCE(summary, ''::text)), 'B'::"char")) || setweight(to_tsvector('english'::regconfig, COALESCE(notes, ''::text)), 'C'::"char"))`),
	deprecationReason: text("deprecation_reason"),
	seeAlso: text("see_also").array().default([""]).notNull(),
	needsDesign: boolean("needs_design").default(false).notNull(),
	designStatus: text("design_status"),
	designSpecId: text("design_spec_id"),
	discardedDesignWork: boolean("discarded_design_work").default(false).notNull(),
}, (table) => [
	index("hfc_design_status_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops"), table.designStatus.asc().nullsLast().op("text_ops")).where(sql`(design_status IS NOT NULL)`),
	index("hfc_needs_design_idx").using("btree", table.harnessSlug.asc().nullsLast().op("bool_ops"), table.needsDesign.asc().nullsLast().op("bool_ops")).where(sql`(needs_design = true)`),
	index("hfc_review_idx").using("btree", table.needsHumanReview.asc().nullsLast().op("bool_ops")),
	index("hfc_search_idx").using("gin", table.search.asc().nullsLast().op("tsvector_ops")),
	index("hfc_see_also_gin").using("gin", table.seeAlso.asc().nullsLast().op("array_ops")),
	index("hfc_slug_idx").using("btree", table.harnessSlug.asc().nullsLast().op("text_ops")),
	index("hfc_status_idx").using("btree", table.status.asc().nullsLast().op("text_ops")),
	index("hfc_updated_idx").using("btree", table.updatedTs.desc().nullsFirst().op("int8_ops")),
	index("hfc_workspace_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.harnessSlug, table.featureId], name: "harness_features_consolidated_pkey"}),
	pgPolicy("harness_features_consolidated_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("hfc_design_status_chk", sql`(design_status IS NULL) OR (design_status = ANY (ARRAY['pending'::text, 'accepted'::text, 'ignored'::text]))`),
	check("hfc_workspace_nonempty", sql`workspace_id <> ''::text`),
]);
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