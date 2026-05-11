import { pgTable, pgSchema, text, jsonb, bigint, index, timestamp, bigserial, boolean, integer, foreignKey, check, numeric, pgPolicy, unique, uuid, uniqueIndex, doublePrecision, primaryKey } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

export const harness_shared = pgSchema("harness_shared");
export const papercup_shared = pgSchema("papercup_shared");


export const operator_pausedInHarness_shared = harness_shared.table("operator_paused", {
	workspace_id: text().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updated_at: bigint({ mode: "number" }).default(0).notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspace_id], name: "operator_paused_pkey"}),
]);

export const ui_clientsInHarness_shared = harness_shared.table("ui_clients", {
	client_id: text().primaryKey().notNull(),
	workspace_id: text(),
	url: text().notNull(),
	title: text(),
	viewport: jsonb(),
	opened_at: timestamp({ withTimezone: true, mode: 'number' }).defaultNow().notNull(),
	last_seen_at: timestamp({ withTimezone: true, mode: 'number' }).defaultNow().notNull(),
}, (table) => [
	index("ui_clients_last_seen_idx").using("btree", table.last_seen_at.desc().nullsFirst().op("timestamptz_ops")),
]);

export const ui_intentsInHarness_shared = harness_shared.table("ui_intents", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	client_id: text().notNull(),
	intent: text().notNull(),
	args: jsonb().default({}).notNull(),
	status: text().default('pending').notNull(),
	result: jsonb(),
	error_message: text(),
	requested_by: text(),
	created_at: timestamp({ withTimezone: true, mode: 'number' }).defaultNow().notNull(),
	completed_at: timestamp({ withTimezone: true, mode: 'number' }),
}, (table) => [
	index("ui_intents_completed_idx").using("btree", table.completed_at.asc().nullsLast().op("timestamptz_ops")).where(sql`(completed_at IS NOT NULL)`),
	index("ui_intents_pending_idx").using("btree", table.client_id.asc().nullsLast().op("int8_ops"), table.id.asc().nullsLast().op("int8_ops")).where(sql`(status = 'pending'::text)`),
]);

export const workspace_backup_settingsInHarness_shared = harness_shared.table("workspace_backup_settings", {
	workspace_id: text().primaryKey().notNull(),
	enabled: boolean().default(true).notNull(),
	cadence_mode: text().default('both').notNull(),
	cadence_minutes: integer().default(5).notNull(),
	retention_preset: text().default('default').notNull(),
	retention_custom_json: jsonb(),
	event_triggers_json: jsonb().default(["pre_destructive","post_run","plugin_install","secret_change"]).notNull(),
	excluded_paths_json: jsonb().default([]).notNull(),
	destination_type: text().default('local').notNull(),
	destination_config_encrypted: text(),
	created_at: timestamp({ withTimezone: true, mode: 'number' }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'number' }).defaultNow().notNull(),
});

export const backup_snapshotsInHarness_shared = harness_shared.table("backup_snapshots", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	workspace_id: text().notNull(),
	kopia_snapshot_id: text(),
	started_at: timestamp({ withTimezone: true, mode: 'number' }).defaultNow().notNull(),
	finished_at: timestamp({ withTimezone: true, mode: 'number' }),
	status: text().default('running').notNull(),
	trigger_reason: text().notNull(),
	trigger_context: jsonb(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	bytes_added: bigint({ mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	bytes_total: bigint({ mode: "number" }),
	sources_json: jsonb().default([]).notNull(),
	error_text: text(),
}, (table) => [
	index("backup_snapshots_workspace_idx").using("btree", table.workspace_id.asc().nullsLast().op("text_ops"), table.started_at.desc().nullsFirst().op("text_ops")),
]);

export const backup_eventsInHarness_shared = harness_shared.table("backup_events", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	workspace_id: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	snapshot_id: bigint({ mode: "number" }),
	kind: text().notNull(),
	payload_json: jsonb(),
	at: timestamp({ withTimezone: true, mode: 'number' }).defaultNow().notNull(),
}, (table) => [
	index("backup_events_workspace_idx").using("btree", table.workspace_id.asc().nullsLast().op("text_ops"), table.at.desc().nullsFirst().op("text_ops")),
	foreignKey({
			columns: [table.snapshot_id],
			foreignColumns: [backup_snapshotsInHarness_shared.id],
			name: "backup_events_snapshot_id_fkey"
		}).onDelete("cascade"),
]);

export const identity_filesInHarness_shared = harness_shared.table("identity_files", {
	role: text().primaryKey().notNull(),
	content: text().default('').notNull(),
	bytes: integer().default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	mtime_ms: bigint({ mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updated_at: bigint({ mode: "number" }).default(0).notNull(),
	workspace_id: text().default('').notNull(),
}, (table) => [
	index("identity_files_workspace_idx").using("btree", table.workspace_id.asc().nullsLast().op("text_ops")),
]);

export const oauth_noncesInHarness_shared = harness_shared.table("oauth_nonces", {
	nonce: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	exp_ms: bigint({ mode: "number" }).notNull(),
	consumed: boolean().default(false).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	created_at: bigint({ mode: "number" }).default(0).notNull(),
}, (table) => [
	index("oauth_nonces_exp_idx").using("btree", table.exp_ms.asc().nullsLast().op("int8_ops")),
	primaryKey({ columns: [table.nonce], name: "oauth_nonces_pkey"}),

]);

export const harness_skillsInHarness_shared = harness_shared.table("harness_skills", {
	workspace_id: text().default('').notNull(),
	harness_slug: text().notNull(),
	name: text().notNull(),
	content: text().default('').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	mtime_ms: bigint({ mode: "number" }).default(0).notNull(),
}, (table) => [
	index("harness_skills_lookup_idx").using("btree", table.workspace_id.asc().nullsLast().op("text_ops"), table.harness_slug.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.workspace_id, table.harness_slug, table.name], name: "harness_skills_pkey"}),

]);

export const mobile_pair_tokensInHarness_shared = harness_shared.table("mobile_pair_tokens", {
	pair_token: text().notNull(),
	workspace_id: text().notNull(),
	user_email: text(),
	desktop_host: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	expires_at_ms: bigint({ mode: "number" }).notNull(),
	consumed: boolean().default(false).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	created_at_ms: bigint({ mode: "number" }).default(0).notNull(),
}, (table) => [
	index("mobile_pair_tokens_exp_idx").using("btree", table.expires_at_ms.asc().nullsLast().op("int8_ops")),
	primaryKey({ columns: [table.pair_token], name: "mobile_pair_tokens_pkey"}),

]);

export const operator_rate_limitInHarness_shared = harness_shared.table("operator_rate_limit", {
	workspace_id: text().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updated_at: bigint({ mode: "number" }).default(0).notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspace_id], name: "operator_rate_limit_pkey"}),
]);

export const messagesInPapercup_shared = papercup_shared.table("messages", {
	id: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).notNull(),
	from_dept: text().notNull(),
	kind: text().notNull(),
	subject: text().notNull(),
	body: text().notNull(),
	ref_id: text(),
	project_id: text(),
	directive_id: text(),
	status: text().default('pending').notNull(),
	metadata: jsonb(),
}, (table) => [
	index("messages_directive_idx").using("btree", table.directive_id.asc().nullsLast().op("text_ops")),
	index("messages_from_idx").using("btree", table.from_dept.asc().nullsLast().op("text_ops")),
	index("messages_kind_idx").using("btree", table.kind.asc().nullsLast().op("text_ops")),
	index("messages_project_idx").using("btree", table.project_id.asc().nullsLast().op("text_ops")),
	index("messages_status_idx").using("btree", table.status.asc().nullsLast().op("text_ops")),
	index("messages_ts_idx").using("btree", table.ts.asc().nullsLast().op("int8_ops")),
	primaryKey({ columns: [table.id], name: "messages_pkey"}),

]);

export const cooldown_marksInHarness_shared = harness_shared.table("cooldown_marks", {
	key: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	marked_at_ms: bigint({ mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updated_at: bigint({ mode: "number" }).default(0).notNull(),
}, (table) => [
	index("cooldown_marks_marked_at_idx").using("btree", table.marked_at_ms.asc().nullsLast().op("int8_ops")),
	primaryKey({ columns: [table.key], name: "cooldown_marks_pkey"}),

]);

export const voice_leaseInHarness_shared = harness_shared.table("voice_lease", {
	workspace_id: text().primaryKey().notNull(),
	owner_id: text().notNull(),
	owner_kind: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	expires_at_ms: bigint({ mode: "number" }).notNull(),
}, (table) => [
	index("voice_lease_expires_idx").using("btree", table.expires_at_ms.asc().nullsLast().op("int8_ops")),
	check("voice_lease_owner_kind_check", sql`owner_kind = ANY (ARRAY['desktop'::text, 'mobile'::text])`),
]);

export const operator_budget_tiersInHarness_shared = harness_shared.table("operator_budget_tiers", {
	ord: integer().primaryKey().notNull(),
	label: text().notNull(),
	cap_usd: numeric({ precision: 10, scale:  2 }).notNull(),
	blurb: text().notNull(),
});

export const operator_settingsInHarness_shared = harness_shared.table("operator_settings", {
	key: text().primaryKey().notNull(),
	value: text().notNull(),
	description: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updated_at: bigint({ mode: "number" }).default(0).notNull(),
});

export const orchestrator_settingsInHarness_shared = harness_shared.table("orchestrator_settings", {
	id: integer().default(1).primaryKey().notNull(),
	tiers: jsonb().default([1,2,4]).notNull(),
	labels: jsonb().default(["trivial","normal","hard"]).notNull(),
	rubric: text().default('').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updated_ts: bigint({ mode: "number" }).default(0).notNull(),
}, (table) => [
	check("orchestrator_settings_id_check", sql`id = 1`),
	primaryKey({ columns: [table.id], name: "orchestrator_settings_pkey"}),

]);

export const harness_feature_debug_notesInHarness_shared = harness_shared.table("harness_feature_debug_notes", {
	workspace_id: text().default('').notNull(),
	harness_slug: text().notNull(),
	feature_id: text().notNull(),
	content: text().default('').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	mtime_ms: bigint({ mode: "number" }).default(0).notNull(),
}, (table) => [
	index("hfdn_harness_idx").using("btree", table.workspace_id.asc().nullsLast().op("text_ops"), table.harness_slug.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.workspace_id, table.harness_slug, table.feature_id], name: "harness_feature_debug_notes_pkey"}),

]);

export const plugin_enablesInHarness_shared = harness_shared.table("plugin_enables", {
	harness_slug: text().notNull(),
	plugin_slug: text().notNull(),
	version: text().notNull(),
	config_hash: text().default('').notNull(),
	enabled_at: timestamp({ withTimezone: true, mode: 'number' }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'number' }).defaultNow().notNull(),
	workspace_id: text().notNull(),
}, (table) => [
	index("plugin_enables_plugin_idx").using("btree", table.plugin_slug.asc().nullsLast().op("text_ops")),
	index("plugin_enables_workspace_idx").using("btree", table.workspace_id.asc().nullsLast().op("text_ops")),
	pgPolicy("plugin_enables_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("plugin_enables_workspace_nonempty", sql`workspace_id <> ''::text`),
	primaryKey({ columns: [table.harness_slug, table.plugin_slug], name: "plugin_enables_pkey"}),

]);

export const adaptive_telemetryInHarness_shared = harness_shared.table("adaptive_telemetry", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	harness_slug: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).notNull(),
	feature_id: text().notNull(),
	requested_n: integer().notNull(),
	actual_n: integer().notNull(),
	tier_label: text(),
	available_at_decision: integer(),
	max_slots: integer(),
	outcome: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	outcome_ts: bigint({ mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	duration_ms: bigint({ mode: "number" }),
	workspace_id: text().default('').notNull(),
}, (table) => [
	index("adaptive_telemetry_harness_idx").using("btree", table.harness_slug.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("int8_ops")),
	index("adaptive_telemetry_pending_idx").using("btree", table.harness_slug.asc().nullsLast().op("text_ops"), table.feature_id.asc().nullsLast().op("text_ops")).where(sql`(outcome IS NULL)`),
]);

export const prompt_compositionsInHarness_shared = harness_shared.table("prompt_compositions", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	workspace_id: text().notNull(),
	harness_slug: text().notNull(),
	feature_id: text(),
	role: text().notNull(),
	run_id: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts_ms: bigint({ mode: "number" }).notNull(),
	total_chars: integer().default(0).notNull(),
	substrate_chars: integer().default(0).notNull(),
	history_chars: integer().default(0).notNull(),
	role_prompt_chars: integer(),
	memory_chars: integer(),
	identity_chars: integer(),
	runtime_chars: integer(),
}, (table) => [
	index("prompt_compositions_by_feature").using("btree", table.workspace_id.asc().nullsLast().op("int8_ops"), table.harness_slug.asc().nullsLast().op("text_ops"), table.feature_id.asc().nullsLast().op("text_ops"), table.ts_ms.desc().nullsFirst().op("text_ops")).where(sql`(feature_id IS NOT NULL)`),
	index("prompt_compositions_by_harness").using("btree", table.workspace_id.asc().nullsLast().op("text_ops"), table.harness_slug.asc().nullsLast().op("int8_ops"), table.ts_ms.desc().nullsFirst().op("int8_ops")),
	pgPolicy("prompt_compositions_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const harness_feature_prsInHarness_shared = harness_shared.table("harness_feature_prs", {
	workspace_id: text().default('').notNull(),
	harness_slug: text().notNull(),
	feature_id: text().notNull(),
	pr_url: text().notNull(),
	pr_state: text().default('unknown').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	opened_ts: bigint({ mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updated_ts: bigint({ mode: "number" }).default(0).notNull(),
}, (table) => [
	index("hfp_harness_idx").using("btree", table.workspace_id.asc().nullsLast().op("text_ops"), table.harness_slug.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.workspace_id, table.harness_slug, table.feature_id], name: "harness_feature_prs_pkey"}),

]);

export const feature_audit_consolidatedInHarness_shared = harness_shared.table("feature_audit_consolidated", {
	id: bigserial({ mode: "bigint" }).notNull(),
	workspace_id: text().default('').notNull(),
	harness_slug: text().notNull(),
	feature_id: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).notNull(),
	field: text().notNull(),
	old_value: text(),
	new_value: text(),
	actor: text(),
}, (table) => [
	index("feature_audit_consolidated_lookup_idx").using("btree", table.workspace_id.asc().nullsLast().op("int8_ops"), table.harness_slug.asc().nullsLast().op("int8_ops"), table.feature_id.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("text_ops")),
	primaryKey({ columns: [table.id], name: "feature_audit_consolidated_pkey"}),

]);

export const agent_chats_consolidatedInHarness_shared = harness_shared.table("agent_chats_consolidated", {
	workspace_id: text().default('').notNull(),
	harness_slug: text().notNull(),
	id: text().notNull(),
	role: text().notNull(),
	feature_id: text(),
	title: text(),
	transcript: jsonb().default([]).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	total_input_tokens: bigint({ mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	total_output_tokens: bigint({ mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	total_cost_usd_cents: bigint({ mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	created_at: bigint({ mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updated_at: bigint({ mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	archived_at: bigint({ mode: "number" }),
}, (table) => [
	index("agent_chats_consolidated_recent_idx").using("btree", table.workspace_id.asc().nullsLast().op("int8_ops"), table.harness_slug.asc().nullsLast().op("int8_ops"), table.updated_at.desc().nullsFirst().op("int8_ops")),
	primaryKey({ columns: [table.workspace_id, table.harness_slug, table.id], name: "agent_chats_consolidated_pkey"}),

]);

export const harness_expertsInHarness_shared = harness_shared.table("harness_experts", {
	workspace_id: text().default('').notNull(),
	harness_slug: text().notNull(),
	expert_id: text().notNull(),
	title: text().default('').notNull(),
	status: text().default('unknown').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	budget_cents: bigint({ mode: "number" }).default(0).notNull(),
	feature_size: text(),
	high_level_spec: text().default('').notNull(),
	agent_count: integer().default(0).notNull(),
	round_count: integer().default(0).notNull(),
	personas_used: jsonb().default([]).notNull(),
	user_engaged: boolean().default(false).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	created_at: bigint({ mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updated_at: bigint({ mode: "number" }).default(0).notNull(),
	termination_reason: text(),
	spec_content: text().default('').notNull(),
}, (table) => [
	index("he_recent_idx").using("btree", table.workspace_id.asc().nullsLast().op("int8_ops"), table.harness_slug.asc().nullsLast().op("int8_ops"), table.updated_at.desc().nullsFirst().op("int8_ops")),
	primaryKey({ columns: [table.workspace_id, table.harness_slug, table.expert_id], name: "harness_experts_pkey"}),

]);

export const tool_invocationsInHarness_shared = harness_shared.table("tool_invocations", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	workspace_id: text().notNull(),
	harness_slug: text().notNull(),
	plugin_name: text().notNull(),
	tool_name: text().notNull(),
	role: text().notNull(),
	feature_id: text(),
	chunk_id: text(),
	run_id: text(),
	spawn_id: text().notNull(),
	parent_spawn_id: text(),
	window_key: text().notNull(),
	invoked_at: timestamp({ withTimezone: true, mode: 'number' }).defaultNow().notNull(),
	duration_ms: integer(),
	status: text().notNull(),
	output_ref: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	output_size: bigint({ mode: "number" }),
	error_message: text(),
	args_json: jsonb(),
}, (table) => [
	index("tool_invocations_quota_idx").using("btree", table.workspace_id.asc().nullsLast().op("text_ops"), table.tool_name.asc().nullsLast().op("text_ops"), table.role.asc().nullsLast().op("text_ops"), table.window_key.asc().nullsLast().op("text_ops")).where(sql`(status = 'ok'::text)`),
	index("tool_invocations_telemetry_idx").using("btree", table.workspace_id.asc().nullsLast().op("text_ops"), table.harness_slug.asc().nullsLast().op("text_ops"), table.invoked_at.desc().nullsFirst().op("text_ops")),
	pgPolicy("tool_invocations_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const operator_turnsInHarness_shared = harness_shared.table("operator_turns", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	conversation_id: uuid().notNull(),
	seq: integer().notNull(),
	role: text().notNull(),
	text: text().notNull(),
	source: text().default('text_typed').notNull(),
	el_conv_id: text(),
	audio_url: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	created_at: bigint({ mode: "number" }).notNull(),
	tools: jsonb(),
}, (table) => [
	index("operator_turns_conv_seq_idx").using("btree", table.conversation_id.asc().nullsLast().op("uuid_ops"), table.seq.asc().nullsLast().op("int4_ops")),
	foreignKey({
			columns: [table.conversation_id],
			foreignColumns: [operator_conversationsInHarness_shared.id],
			name: "operator_turns_conversation_id_fkey"
		}).onDelete("cascade"),
	unique("operator_turns_conversation_id_seq_key").on(table.conversation_id, table.seq),
	check("operator_turns_role_check", sql`role = ANY (ARRAY['user'::text, 'assistant'::text, 'system'::text])`),
	primaryKey({ columns: [table.id], name: "operator_turns_pkey"}),

]);

export const spawned_agentsInHarness_shared = harness_shared.table("spawned_agents", {
	spawn_id: text().primaryKey().notNull(),
	workspace_id: text().notNull(),
	harness_slug: text().notNull(),
	parent_spawn_id: text(),
	parent_role: text().notNull(),
	child_role: text().notNull(),
	feature_id: text(),
	chunk_id: text(),
	run_id: text().notNull(),
	status: text().notNull(),
	started_at: timestamp({ withTimezone: true, mode: 'number' }).defaultNow().notNull(),
	finished_at: timestamp({ withTimezone: true, mode: 'number' }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	duration_ms: bigint({ mode: "number" }),
	exit_code: integer(),
	output_tail: text(),
	error_message: text(),
	cancel_requested: boolean().default(false).notNull(),
}, (table) => [
	index("spawned_agents_parent_idx").using("btree", table.workspace_id.asc().nullsLast().op("text_ops"), table.parent_spawn_id.asc().nullsLast().op("text_ops")),
	index("spawned_agents_recent_idx").using("btree", table.workspace_id.asc().nullsLast().op("text_ops"), table.harness_slug.asc().nullsLast().op("text_ops"), table.started_at.desc().nullsFirst().op("text_ops")),
	index("spawned_agents_running_idx").using("btree", table.workspace_id.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")).where(sql`(status = 'running'::text)`),
	pgPolicy("spawned_agents_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const operator_conversationsInHarness_shared = harness_shared.table("operator_conversations", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	workspace_id: text().default('').notNull(),
	harness_slug: text(),
	title: text(),
	status: text().default('active').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	started_at: bigint({ mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ended_at: bigint({ mode: "number" }),
	el_conversation_ids: text().array().default([""]).notNull(),
	has_audio: boolean().default(false).notNull(),
}, (table) => [
	index("operator_conversations_active_idx").using("btree", sql`workspace_id`, sql`COALESCE(harness_slug, ''::text)`).where(sql`(status = 'active'::text)`),
	index("operator_conversations_started_idx").using("btree", table.workspace_id.asc().nullsLast().op("int8_ops"), table.started_at.desc().nullsFirst().op("int8_ops")),
	primaryKey({ columns: [table.id], name: "operator_conversations_pkey"}),

]);

export const operator_search_provider_credentialsInHarness_shared = harness_shared.table("operator_search_provider_credentials", {
	workspace_id: text().primaryKey().notNull(),
	payload: jsonb().default({}).notNull(),
	// TODO: failed to parse database type 'bytea'
	payload_ct: text("payload_ct"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updated_at: bigint({ mode: "number" }).default(sql`(EXTRACT(epoch FROM now()) * 1000)::bigint`).notNull(),
}, (table) => [
	pgPolicy("osc_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const operator_scansInHarness_shared = harness_shared.table("operator_scans", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	workspace_id: text().notNull(),
	started_at: timestamp({ withTimezone: true, mode: 'number' }).defaultNow().notNull(),
	ended_at: timestamp({ withTimezone: true, mode: 'number' }),
	agent_session_id: text(),
	request_text: text(),
	summary: text(),
	suggestions: jsonb().default([]).notNull(),
	suggestion_count: integer().default(0).notNull(),
	cost_usd: numeric({ precision: 10, scale:  4 }).default('0').notNull(),
	cached: boolean().default(false).notNull(),
	error: text(),
}, (table) => [
	index("operator_scans_session_idx").using("btree", table.agent_session_id.asc().nullsLast().op("text_ops")).where(sql`(agent_session_id IS NOT NULL)`),
	index("operator_scans_ws_started_idx").using("btree", table.workspace_id.asc().nullsLast().op("text_ops"), table.started_at.desc().nullsFirst().op("text_ops")),
]);

export const delegate_inboxInHarness_shared = harness_shared.table("delegate_inbox", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	workspace_id: text().notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'number' }).defaultNow().notNull(),
	delivered_at: timestamp({ withTimezone: true, mode: 'number' }),
	kind: text().default('delegate-complete').notNull(),
	headline: text().notNull(),
	agent_session_id: text(),
}, (table) => [
	index("delegate_inbox_ws_pending_idx").using("btree", table.workspace_id.asc().nullsLast().op("text_ops"), table.created_at.asc().nullsLast().op("text_ops")).where(sql`(delivered_at IS NULL)`),
]);

export const mobile_devicesInHarness_shared = harness_shared.table("mobile_devices", {
	device_id: text().primaryKey().notNull(),
	user_email: text().notNull(),
	workspace_id: text().notNull(),
	device_kind: text().default('mobile').notNull(),
	device_label: text(),
	paired_at: timestamp({ withTimezone: true, mode: 'number' }).defaultNow().notNull(),
	last_seen: timestamp({ withTimezone: true, mode: 'number' }),
	revoked_at: timestamp({ withTimezone: true, mode: 'number' }),
}, (table) => [
	index("mobile_devices_user_idx").using("btree", table.user_email.asc().nullsLast().op("text_ops")),
	index("mobile_devices_workspace_idx").using("btree", table.workspace_id.asc().nullsLast().op("text_ops")).where(sql`(revoked_at IS NULL)`),
	pgPolicy("mobile_devices_workspace_policy", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("mobile_devices_device_kind_check", sql`device_kind = 'mobile'::text`),
]);

export const harness_project_filesInHarness_shared = harness_shared.table("harness_project_files", {
	harness_slug: text().primaryKey().notNull(),
	spec: text(),
	agents: text(),
	contract: text(),
	config: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updated_at: bigint({ mode: "number" }).default(0).notNull(),
	workspace_id: text().default('').notNull(),
}, (table) => [
	index("harness_project_files_workspace_idx").using("btree", table.workspace_id.asc().nullsLast().op("text_ops")),
]);

export const operator_secretsInHarness_shared = harness_shared.table("operator_secrets", {
	name: text().primaryKey().notNull(),
	value_b64: text().notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'number' }).defaultNow().notNull(),
	rotated_at: timestamp({ withTimezone: true, mode: 'number' }),
});

export const spawn_sig_verification_failuresInHarness_shared = harness_shared.table("spawn_sig_verification_failures", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	ts: timestamp({ withTimezone: true, mode: 'number' }).defaultNow().notNull(),
	reason: text().notNull(),
	claimed_role: text(),
	claimed_harness: text(),
	claimed_workspace: text(),
	claimed_spawn: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	exp_claim: bigint({ mode: "number" }),
	remote_addr: text(),
	user_agent: text(),
}, (table) => [
	index("spawn_sig_failures_reason_idx").using("btree", table.reason.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("text_ops")),
	index("spawn_sig_failures_ts_idx").using("btree", table.ts.desc().nullsFirst().op("timestamptz_ops")),
]);

export const briefingsInPapercup_shared = papercup_shared.table("briefings", {
	id: text().notNull(),
	title: text().notNull(),
	quarter: text().default('').notNull(),
	status: text().notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'number' }).defaultNow().notNull(),
	script_path: text(),
	duration_seconds: integer(),
	youtube_url: text(),
	youtube_video_id: text(),
	thumbnail_url: text(),
	render_log: text(),
	error: text(),
	summary: text(),
}, (table) => [
	primaryKey({ columns: [table.id], name: "briefings_pkey"}),
]);

export const directive_summariesInPapercup_shared = papercup_shared.table("directive_summaries", {
	id: text().notNull(),
	directive_id: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).notNull(),
	author: text().default('ceo').notNull(),
	body: text().notNull(),
}, (table) => [
	index("summaries_directive_idx").using("btree", table.directive_id.asc().nullsLast().op("text_ops")),
	index("summaries_ts_idx").using("btree", table.ts.asc().nullsLast().op("int8_ops")),
	primaryKey({ columns: [table.id], name: "directive_summaries_pkey"}),

]);

export const message_commentsInPapercup_shared = papercup_shared.table("message_comments", {
	id: text().notNull(),
	message_id: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).notNull(),
	author: text().notNull(),
	body: text().notNull(),
}, (table) => [
	index("comments_msg_idx").using("btree", table.message_id.asc().nullsLast().op("text_ops")),
	index("comments_ts_idx").using("btree", table.ts.asc().nullsLast().op("int8_ops")),
	foreignKey({
			columns: [table.message_id],
			foreignColumns: [messagesInPapercup_shared.id],
			name: "message_comments_message_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.id], name: "message_comments_pkey"}),

]);

export const plugin_configsInHarness_shared = harness_shared.table("plugin_configs", {
	harness_slug: text().notNull(),
	plugin_slug: text().notNull(),
	config: jsonb().default({}).notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'number' }).defaultNow().notNull(),
	workspace_id: text().notNull(),
	// TODO: failed to parse database type 'bytea'
	config_ct: text("config_ct"),
}, (table) => [
	index("plugin_configs_plugin_idx").using("btree", table.plugin_slug.asc().nullsLast().op("text_ops")),
	index("plugin_configs_workspace_idx").using("btree", table.workspace_id.asc().nullsLast().op("text_ops")),
	pgPolicy("plugin_configs_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("plugin_configs_workspace_nonempty", sql`workspace_id <> ''::text`),
	primaryKey({ columns: [table.harness_slug, table.plugin_slug], name: "plugin_configs_pkey"}),

]);

export const directivesInPapercup_shared = papercup_shared.table("directives", {
	id: text().notNull(),
	title: text().notNull(),
	body: text().notNull(),
	status: text().notNull(),
	created_by: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	created_ts: bigint({ mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	deadline_ts: bigint({ mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	budget_cents: bigint({ mode: "number" }),
	priority: text(),
	assigned_departments: jsonb().default([]).notNull(),
	linked_project_ids: jsonb().default([]).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updated_ts: bigint({ mode: "number" }).notNull(),
}, (table) => [
	index("directives_created_idx").using("btree", table.created_ts.desc().nullsFirst().op("int8_ops")),
	index("directives_status_idx").using("btree", table.status.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.id], name: "directives_pkey"}),

]);

export const message_recipientsInPapercup_shared = papercup_shared.table("message_recipients", {
	message_id: text().notNull(),
	dept_slug: text().notNull(),
}, (table) => [
	index("recipients_dept_idx").using("btree", table.dept_slug.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.message_id],
			foreignColumns: [messagesInPapercup_shared.id],
			name: "message_recipients_message_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.message_id, table.dept_slug], name: "message_recipients_pkey"}),

]);

export const user_actionsInHarness_shared = harness_shared.table("user_actions", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	harness_slug: text().notNull(),
	kind: text().notNull(),
	status: text().notNull(),
	summary: text(),
	detail_url: text(),
	error_text: text(),
	invocation_id: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	started_at: bigint({ mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	finished_at: bigint({ mode: "number" }),
	actor: text(),
	workspace_id: text().default('').notNull(),
}, (table) => [
	index("user_actions_running_idx").using("btree", table.harness_slug.asc().nullsLast().op("text_ops")).where(sql`(status = 'running'::text)`),
	index("user_actions_slug_started_idx").using("btree", table.harness_slug.asc().nullsLast().op("int8_ops"), table.started_at.desc().nullsFirst().op("int8_ops")),
	index("user_actions_workspace_idx").using("btree", table.workspace_id.asc().nullsLast().op("text_ops")),
]);

export const delegatesInHarness_shared = harness_shared.table("delegates", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	workspace: text().notNull(),
	agent_session_id: text().notNull(),
	title: text(),
	summary: text(),
	status: text().default('open').notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'number' }).defaultNow().notNull(),
	last_active_at: timestamp({ withTimezone: true, mode: 'number' }).defaultNow().notNull(),
	turn_count: integer().default(0).notNull(),
	origin: text().notNull(),
	initiator_msg: text(),
	transcript: jsonb().default([]).notNull(),
}, (table) => [
	index("delegates_open_ws_idx").using("btree", table.workspace.asc().nullsLast().op("text_ops"), table.last_active_at.desc().nullsFirst().op("timestamptz_ops")).where(sql`(status = 'open'::text)`),
	index("delegates_status_idx").using("btree", table.status.asc().nullsLast().op("text_ops"), table.last_active_at.desc().nullsFirst().op("text_ops")),
	unique("claude_sessions_agent_session_id_key").on(table.agent_session_id),
]);

export const el_conv_callsInHarness_shared = harness_shared.table("el_conv_calls", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	ts: timestamp({ withTimezone: true, mode: 'number' }).defaultNow().notNull(),
	conversation_id: text().notNull(),
	agent_id: text(),
	workspace: text(),
	duration_secs: integer().default(0).notNull(),
	ym: text().default(sql`to_char(now(), 'YYYY-MM'::text)`).notNull(),
}, (table) => [
	index("el_conv_calls_ym_idx").using("btree", table.ym.asc().nullsLast().op("text_ops")),
	unique("el_conv_calls_conversation_id_key").on(table.conversation_id),
]);

export const agent_actionsInHarness_shared = harness_shared.table("agent_actions", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	ts: timestamp({ withTimezone: true, mode: 'number' }).defaultNow().notNull(),
	agent: text().notNull(),
	command_id: text().notNull(),
	args: jsonb().default({}).notNull(),
	status: text().notNull(),
	error_code: text(),
	duration_ms: integer(),
	workspace: text(),
	session_id: text(),
	request_id: text(),
}, (table) => [
	index("agent_actions_agent_ts_idx").using("btree", table.agent.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("text_ops")),
	index("agent_actions_id_ts_idx").using("btree", table.command_id.asc().nullsLast().op("timestamptz_ops"), table.ts.desc().nullsFirst().op("text_ops")),
	index("agent_actions_ts_idx").using("btree", table.ts.desc().nullsFirst().op("timestamptz_ops")),
	index("agent_actions_ws_ts_idx").using("btree", table.workspace.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("text_ops")),
]);

export const agent_queriesInHarness_shared = harness_shared.table("agent_queries", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	ts: timestamp({ withTimezone: true, mode: 'number' }).defaultNow().notNull(),
	agent: text().notNull(),
	query_id: text().notNull(),
	args_compact: jsonb(),
	workspace: text(),
	request_id: text(),
}, (table) => [
	index("agent_queries_agent_id_ts").using("btree", table.agent.asc().nullsLast().op("text_ops"), table.query_id.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("timestamptz_ops")),
	index("agent_queries_ts_idx").using("btree", table.ts.desc().nullsFirst().op("timestamptz_ops")),
]);

export const goalsInHarness_shared = harness_shared.table("goals", {
	id: text().notNull(),
	install_slug: text().notNull(),
	title: text().notNull(),
	body: text(),
	parent_id: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	budget_cents: bigint({ mode: "number" }),
	status: text().default('active').notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'number' }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'number' }).defaultNow().notNull(),
	metadata: jsonb(),
	workspace_id: text().notNull(),
	// TODO: failed to parse database type 'tsvector'
	_search: text("_search").generatedAlwaysAs(sql`(setweight(to_tsvector('english'::regconfig, COALESCE(title, ''::text)), 'A'::"char") || setweight(to_tsvector('english'::regconfig, COALESCE(body, ''::text)), 'B'::"char"))`),
}, (table) => [
	index("goals_install_idx").using("btree", table.install_slug.asc().nullsLast().op("text_ops")),
	index("goals_parent_idx").using("btree", table.parent_id.asc().nullsLast().op("text_ops")),
	index("goals_search_idx").using("gin", table._search.asc().nullsLast().op("tsvector_ops")),
	index("goals_status_idx").using("btree", table.status.asc().nullsLast().op("text_ops")),
	index("goals_workspace_idx").using("btree", table.workspace_id.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.parent_id],
			foreignColumns: [table.id],
			name: "goals_parent_id_fkey"
		}).onDelete("set null"),
	pgPolicy("goals_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("goals_workspace_nonempty", sql`workspace_id <> ''::text`),
	primaryKey({ columns: [table.id], name: "goals_pkey"}),

]);

export const pending_eventsInHarness_shared = harness_shared.table("pending_events", {
	id: text().notNull(),
	install_slug: text().notNull(),
	kind: text().notNull(),
	target_role: text().notNull(),
	payload: jsonb(),
	due_at: timestamp({ withTimezone: true, mode: 'number' }),
	created_at: timestamp({ withTimezone: true, mode: 'number' }).defaultNow().notNull(),
	consumed_at: timestamp({ withTimezone: true, mode: 'number' }),
	consumed_by: text(),
	source_id: text(),
	workspace_id: text().notNull(),
}, (table) => [
	index("pending_events_source_idx").using("btree", table.source_id.asc().nullsLast().op("text_ops")),
	index("pending_events_unconsumed_idx").using("btree", table.install_slug.asc().nullsLast().op("text_ops"), table.due_at.asc().nullsLast().op("text_ops")).where(sql`(consumed_at IS NULL)`),
	index("pending_events_workspace_idx").using("btree", table.workspace_id.asc().nullsLast().op("text_ops")),
	pgPolicy("pending_events_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("pending_events_workspace_nonempty", sql`workspace_id <> ''::text`),
	primaryKey({ columns: [table.id], name: "pending_events_pkey"}),

]);

export const toast_logInHarness_shared = harness_shared.table("toast_log", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	level: text().notNull(),
	message: text().notNull(),
	description: text(),
	harness_slug: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	created_at: bigint({ mode: "number" }).notNull(),
	action_label: text(),
	action_href: text(),
}, (table) => [
	index("toast_log_created_idx").using("btree", table.created_at.desc().nullsFirst().op("int8_ops")),
	index("toast_log_slug_created_idx").using("btree", table.harness_slug.asc().nullsLast().op("int8_ops"), table.created_at.desc().nullsFirst().op("int8_ops")).where(sql`(harness_slug IS NOT NULL)`),
]);

export const routinesInHarness_shared = harness_shared.table("routines", {
	id: text().notNull(),
	install_slug: text().notNull(),
	name: text().notNull(),
	trigger_kind: text().notNull(),
	trigger_config: jsonb().notNull(),
	target_role: text().notNull(),
	payload_template: jsonb(),
	concurrency: text().default('queue').notNull(),
	catchup: text().default('skip-old').notNull(),
	active: boolean().default(true).notNull(),
	last_fired_at: timestamp({ withTimezone: true, mode: 'number' }),
	next_fire_at: timestamp({ withTimezone: true, mode: 'number' }),
	created_at: timestamp({ withTimezone: true, mode: 'number' }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'number' }).defaultNow().notNull(),
	metadata: jsonb(),
	workspace_id: text().notNull(),
}, (table) => [
	index("routines_active_due_idx").using("btree", table.active.asc().nullsLast().op("timestamptz_ops"), table.next_fire_at.asc().nullsLast().op("timestamptz_ops")).where(sql`(active = true)`),
	index("routines_install_idx").using("btree", table.install_slug.asc().nullsLast().op("text_ops")),
	index("routines_workspace_idx").using("btree", table.workspace_id.asc().nullsLast().op("text_ops")),
	pgPolicy("routines_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("routines_workspace_nonempty", sql`workspace_id <> ''::text`),
	primaryKey({ columns: [table.id], name: "routines_pkey"}),

]);

export const token_indexInHarness_shared = harness_shared.table("token_index", {
	token: text().notNull(),
	harness_slug: text().notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'number' }).defaultNow().notNull(),
	workspace_id: text().notNull(),
	kind: text().default('harness').notNull(),
}, (table) => [
	index("token_index_kind_idx").using("btree", table.kind.asc().nullsLast().op("text_ops")),
	index("token_index_workspace_idx").using("btree", table.workspace_id.asc().nullsLast().op("text_ops")),
	pgPolicy("token_index_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("token_index_workspace_nonempty", sql`workspace_id <> ''::text`),
	primaryKey({ columns: [table.token], name: "token_index_pkey"}),

]);

export const audit_logInHarness_shared = harness_shared.table("audit_log", {
	id: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).notNull(),
	actor: text().default('user').notNull(),
	action: text().notNull(),
	subject: text().notNull(),
	details: jsonb(),
	workspace_id: text().notNull(),
	// TODO: failed to parse database type 'tsvector'
	_search: text("_search").generatedAlwaysAs(sql`((setweight(to_tsvector('simple'::regconfig, COALESCE(subject, ''::text)), 'A'::"char") || setweight(to_tsvector('simple'::regconfig, COALESCE(action, ''::text)), 'B'::"char")) || setweight(to_tsvector('simple'::regconfig, COALESCE(actor, ''::text)), 'C'::"char"))`),
}, (table) => [
	index("audit_action_idx").using("btree", table.action.asc().nullsLast().op("text_ops")),
	index("audit_actor_action_ts_idx").using("btree", table.actor.asc().nullsLast().op("int8_ops"), table.action.asc().nullsLast().op("int8_ops"), table.ts.desc().nullsFirst().op("int8_ops")),
	index("audit_search_idx").using("gin", table._search.asc().nullsLast().op("tsvector_ops")),
	index("audit_subject_ts_idx").using("btree", table.subject.asc().nullsLast().op("int8_ops"), table.ts.desc().nullsFirst().op("text_ops")),
	index("audit_ts_idx").using("btree", table.ts.asc().nullsLast().op("int8_ops")),
	index("audit_workspace_idx").using("btree", table.workspace_id.asc().nullsLast().op("text_ops")),
	pgPolicy("audit_log_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("audit_workspace_nonempty", sql`workspace_id <> ''::text`),
	primaryKey({ columns: [table.id], name: "audit_log_pkey"}),

]);

export const project_spec_revisionsInHarness_shared = harness_shared.table("project_spec_revisions", {
	id: bigserial({ mode: "bigint" }).notNull(),
	project_id: text().notNull(),
	spec: text().notNull(),
	summary: text(),
	author_role: text().notNull(),
	author: text(),
	ts: timestamp({ withTimezone: true, mode: 'number' }).defaultNow().notNull(),
	include_decisions: jsonb(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	tokens_in: bigint({ mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	tokens_out: bigint({ mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	cost_usd_cents: bigint({ mode: "number" }).default(0).notNull(),
	workspace_id: text().notNull(),
}, (table) => [
	index("project_spec_revisions_workspace_idx").using("btree", table.workspace_id.asc().nullsLast().op("text_ops")),
	index("psr_author_role_idx").using("btree", table.author_role.asc().nullsLast().op("text_ops")),
	index("psr_project_idx").using("btree", table.project_id.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("text_ops")),
	index("psr_ts_idx").using("btree", table.ts.desc().nullsFirst().op("timestamptz_ops")),
	foreignKey({
			columns: [table.project_id],
			foreignColumns: [projectsInHarness_shared.id],
			name: "project_spec_revisions_project_id_fkey"
		}).onDelete("cascade"),
	pgPolicy("project_spec_revisions_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("psr_workspace_nonempty", sql`workspace_id <> ''::text`),
	primaryKey({ columns: [table.id], name: "project_spec_revisions_pkey"}),

]);

export const projectsInHarness_shared = harness_shared.table("projects", {
	id: text().notNull(),
	name: text().notNull(),
	status: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	budget_cents: bigint({ mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	spent_cents: bigint({ mode: "number" }).default(0).notNull(),
	owning_dept: text(),
	vertical: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	created_ts: bigint({ mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updated_ts: bigint({ mode: "number" }).notNull(),
	metadata: jsonb(),
	spec: text(),
	spec_updated_at: timestamp({ withTimezone: true, mode: 'number' }),
	spec_manually_edited_at: timestamp({ withTimezone: true, mode: 'number' }),
	slug: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	cost_cap_cents: bigint({ mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	earned_cents: bigint({ mode: "number" }).default(0).notNull(),
	parent_slug: text(),
	workspace_id: text().notNull(),
	// TODO: failed to parse database type 'tsvector'
	_search: text("_search").generatedAlwaysAs(sql`(setweight(to_tsvector('english'::regconfig, COALESCE(name, ''::text)), 'A'::"char") || setweight(to_tsvector('english'::regconfig, COALESCE(slug, ''::text)), 'B'::"char"))`),
}, (table) => [
	index("projects_parent_idx").using("btree", table.parent_slug.asc().nullsLast().op("text_ops")),
	index("projects_search_idx").using("gin", table._search.asc().nullsLast().op("tsvector_ops")),
	uniqueIndex("projects_slug_idx").using("btree", table.slug.asc().nullsLast().op("text_ops")),
	index("projects_status_idx").using("btree", table.status.asc().nullsLast().op("text_ops")),
	index("projects_workspace_idx").using("btree", table.workspace_id.asc().nullsLast().op("text_ops")),
	pgPolicy("projects_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("projects_workspace_nonempty", sql`workspace_id <> ''::text`),
	primaryKey({ columns: [table.id], name: "projects_pkey"}),

]);

export const voice_utterancesInHarness_shared = harness_shared.table("voice_utterances", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	ts: timestamp({ withTimezone: true, mode: 'number' }).defaultNow().notNull(),
	workspace: text(),
	source: text().notNull(),
	mode: text(),
	length_chars: integer(),
	name_used: boolean().default(false).notNull(),
	had_backstory: boolean().default(false).notNull(),
	modifications: jsonb(),
}, (table) => [
	index("voice_utterances_mode_idx").using("btree", table.mode.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("text_ops")),
	index("voice_utterances_ts_idx").using("btree", table.ts.desc().nullsFirst().op("timestamptz_ops")),
]);

export const operator_scan_locksInHarness_shared = harness_shared.table("operator_scan_locks", {
	workspace_id: text().primaryKey().notNull(),
	started_at: timestamp({ withTimezone: true, mode: 'number' }).defaultNow().notNull(),
	holder_id: text().notNull(),
	expires_at: timestamp({ withTimezone: true, mode: 'number' }).notNull(),
}, (table) => [
	index("operator_scan_locks_expires_idx").using("btree", table.expires_at.asc().nullsLast().op("timestamptz_ops")),
	pgPolicy("operator_scan_locks_workspace_iso", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const org_charterInHarness_shared = harness_shared.table("org_charter", {
	org_id: text().notNull(),
	content: text().default('').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	mtime_ms: bigint({ mode: "number" }).default(0).notNull(),
	workspace_id: text().default('').notNull(),
}, (table) => [
	primaryKey({ columns: [table.org_id], name: "org_charter_pkey"}),
]);

export const org_notesInHarness_shared = harness_shared.table("org_notes", {
	org_id: text().notNull(),
	dept_slug: text().notNull(),
	content: text().default('').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	mtime_ms: bigint({ mode: "number" }).default(0).notNull(),
	workspace_id: text().default('').notNull(),
}, (table) => [
	primaryKey({ columns: [table.org_id, table.dept_slug], name: "org_notes_pkey"}),
]);

export const operator_credentialsInHarness_shared = harness_shared.table("operator_credentials", {
	workspace_id: text().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updated_at: bigint({ mode: "number" }).default(0).notNull(),
	// TODO: failed to parse database type 'bytea'
	payload_ct: text("payload_ct"),
}, (table) => [
	primaryKey({ columns: [table.workspace_id], name: "operator_credentials_pkey"}),
]);

export const org_decisionsInHarness_shared = harness_shared.table("org_decisions", {
	org_id: text().notNull(),
	dept_slug: text().notNull(),
	content: text().default('').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	mtime_ms: bigint({ mode: "number" }).default(0).notNull(),
	workspace_id: text().default('').notNull(),
}, (table) => [
	primaryKey({ columns: [table.org_id, table.dept_slug], name: "org_decisions_pkey"}),
]);

export const operator_budgetInHarness_shared = harness_shared.table("operator_budget", {
	workspace_id: text().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updated_at: bigint({ mode: "number" }).default(0).notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspace_id], name: "operator_budget_pkey"}),
]);

export const operator_publish_credentialsInHarness_shared = harness_shared.table("operator_publish_credentials", {
	workspace_id: text().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updated_at: bigint({ mode: "number" }).default(0).notNull(),
	// TODO: failed to parse database type 'bytea'
	payload_ct: text("payload_ct"),
}, (table) => [
	primaryKey({ columns: [table.workspace_id], name: "operator_publish_credentials_pkey"}),
]);

export const operator_voice_credentialsInHarness_shared = harness_shared.table("operator_voice_credentials", {
	workspace_id: text().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updated_at: bigint({ mode: "number" }).default(0).notNull(),
	// TODO: failed to parse database type 'bytea'
	payload_ct: text("payload_ct"),
}, (table) => [
	primaryKey({ columns: [table.workspace_id], name: "operator_voice_credentials_pkey"}),
]);

export const operator_marketplace_tokenInHarness_shared = harness_shared.table("operator_marketplace_token", {
	workspace_id: text().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updated_at: bigint({ mode: "number" }).default(0).notNull(),
	// TODO: failed to parse database type 'bytea'
	payload_ct: text("payload_ct"),
}, (table) => [
	primaryKey({ columns: [table.workspace_id], name: "operator_marketplace_token_pkey"}),
]);

export const harness_escalationsInHarness_shared = harness_shared.table("harness_escalations", {
	harness_slug: text().notNull(),
	phase: text().default('staging').notNull(),
	escalation: text(),
	supervisor_notes: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	mtime_ms: bigint({ mode: "number" }).default(0).notNull(),
	workspace_id: text().default('').notNull(),
}, (table) => [
	primaryKey({ columns: [table.harness_slug, table.phase], name: "harness_escalations_pkey"}),
]);

export const harness_pending_issuesInHarness_shared = harness_shared.table("harness_pending_issues", {
	harness_slug: text().notNull(),
	phase: text().default('staging').notNull(),
	issue_id: text().notNull(),
	feature_id: text(),
	title: text().default('').notNull(),
	severity: text().default('normal').notNull(),
	source: text().default('').notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	mtime_ms: bigint({ mode: "number" }).default(0).notNull(),
	workspace_id: text().default('').notNull(),
}, (table) => [
	primaryKey({ columns: [table.harness_slug, table.phase, table.issue_id], name: "harness_pending_issues_pkey"}),
]);

export const harness_phasesInHarness_shared = harness_shared.table("harness_phases", {
	harness_slug: text().notNull(),
	phase: text().notNull(),
	phase_path: text().default('').notNull(),
	branch: text(),
	port: integer(),
	public_url: text(),
	exists_on_disk: boolean().default(false).notNull(),
	alive: boolean().default(false).notNull(),
	passed_count: integer().default(0).notNull(),
	total_count: integer().default(0).notNull(),
	cost_usd: doublePrecision().default(0).notNull(),
	iteration: integer().default(0).notNull(),
	promotion_in_flight: boolean().default(false).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	mtime_ms: bigint({ mode: "number" }).default(0).notNull(),
	workspace_id: text().default('').notNull(),
}, (table) => [
	primaryKey({ columns: [table.harness_slug, table.phase], name: "harness_phases_pkey"}),
]);

export const harness_testsInHarness_shared = harness_shared.table("harness_tests", {
	harness_slug: text().notNull(),
	phase: text().default('staging').notNull(),
	test_id: text().notNull(),
	name: text().default('').notNull(),
	status: text().default('pending').notNull(),
	duration_ms: integer().default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	last_run_ts: bigint({ mode: "number" }),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	mtime_ms: bigint({ mode: "number" }).default(0).notNull(),
	workspace_id: text().default('').notNull(),
}, (table) => [
	primaryKey({ columns: [table.harness_slug, table.phase, table.test_id], name: "harness_tests_pkey"}),
]);

export const org_departmentsInHarness_shared = harness_shared.table("org_departments", {
	org_id: text().notNull(),
	dept_slug: text().notNull(),
	harness_slug: text().default('').notNull(),
	name: text().default('').notNull(),
	mandate: text().default('').notNull(),
	inbox_kinds: jsonb().default([]).notNull(),
	outbox_kinds: jsonb().default([]).notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	mtime_ms: bigint({ mode: "number" }).default(0).notNull(),
	workspace_id: text().default('').notNull(),
}, (table) => [
	primaryKey({ columns: [table.org_id, table.dept_slug], name: "org_departments_pkey"}),
]);

export const org_projectsInHarness_shared = harness_shared.table("org_projects", {
	org_id: text().notNull(),
	project_id: text().notNull(),
	slug: text().default('').notNull(),
	name: text().default('').notNull(),
	vertical: text().default('').notNull(),
	status: text().default('').notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	mtime_ms: bigint({ mode: "number" }).default(0).notNull(),
	workspace_id: text().default('').notNull(),
}, (table) => [
	primaryKey({ columns: [table.org_id, table.project_id], name: "org_projects_pkey"}),
]);

export const org_inboxInHarness_shared = harness_shared.table("org_inbox", {
	org_id: text().notNull(),
	dept_slug: text().notNull(),
	message_id: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).default(0).notNull(),
	msg_from: text().default('').notNull(),
	msg_to: jsonb().default([]).notNull(),
	kind: text().default('').notNull(),
	subject: text().default('').notNull(),
	body: text().default('').notNull(),
	ref_id: text(),
	project_id: text(),
	directive_id: text(),
	status: text().default('pending').notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	mtime_ms: bigint({ mode: "number" }).default(0).notNull(),
	workspace_id: text().default('').notNull(),
}, (table) => [
	primaryKey({ columns: [table.org_id, table.dept_slug, table.message_id], name: "org_inbox_pkey"}),
]);

export const org_outboxInHarness_shared = harness_shared.table("org_outbox", {
	org_id: text().notNull(),
	dept_slug: text().notNull(),
	message_id: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).default(0).notNull(),
	msg_from: text().default('').notNull(),
	msg_to: jsonb().default([]).notNull(),
	kind: text().default('').notNull(),
	subject: text().default('').notNull(),
	body: text().default('').notNull(),
	ref_id: text(),
	project_id: text(),
	directive_id: text(),
	status: text().default('pending').notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	mtime_ms: bigint({ mode: "number" }).default(0).notNull(),
	workspace_id: text().default('').notNull(),
}, (table) => [
	primaryKey({ columns: [table.org_id, table.dept_slug, table.message_id], name: "org_outbox_pkey"}),
]);

export const operator_last_scanInHarness_shared = harness_shared.table("operator_last_scan", {
	workspace_id: text().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updated_at: bigint({ mode: "number" }).default(0).notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspace_id], name: "operator_last_scan_pkey"}),
]);

export const operator_standing_candidatesInHarness_shared = harness_shared.table("operator_standing_candidates", {
	workspace_id: text().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updated_at: bigint({ mode: "number" }).default(0).notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspace_id], name: "operator_standing_candidates_pkey"}),
]);

export const operator_idle_snapshotInHarness_shared = harness_shared.table("operator_idle_snapshot", {
	workspace_id: text().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updated_at: bigint({ mode: "number" }).default(0).notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspace_id], name: "operator_idle_snapshot_pkey"}),
]);

export const operator_tts_spendInHarness_shared = harness_shared.table("operator_tts_spend", {
	workspace_id: text().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updated_at: bigint({ mode: "number" }).default(0).notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspace_id], name: "operator_tts_spend_pkey"}),
]);

export const operator_stt_spendInHarness_shared = harness_shared.table("operator_stt_spend", {
	workspace_id: text().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updated_at: bigint({ mode: "number" }).default(0).notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspace_id], name: "operator_stt_spend_pkey"}),
]);

export const operator_voice_prefsInHarness_shared = harness_shared.table("operator_voice_prefs", {
	workspace_id: text().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updated_at: bigint({ mode: "number" }).default(0).notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspace_id], name: "operator_voice_prefs_pkey"}),
]);

export const operator_agent_configInHarness_shared = harness_shared.table("operator_agent_config", {
	workspace_id: text().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updated_at: bigint({ mode: "number" }).default(0).notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspace_id], name: "operator_agent_config_pkey"}),
]);

export const operator_scanner_sessionInHarness_shared = harness_shared.table("operator_scanner_session", {
	workspace_id: text().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updated_at: bigint({ mode: "number" }).default(0).notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspace_id], name: "operator_scanner_session_pkey"}),
]);

export const operator_first_runInHarness_shared = harness_shared.table("operator_first_run", {
	workspace_id: text().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updated_at: bigint({ mode: "number" }).default(0).notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspace_id], name: "operator_first_run_pkey"}),
]);

export const operator_user_profileInHarness_shared = harness_shared.table("operator_user_profile", {
	workspace_id: text().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updated_at: bigint({ mode: "number" }).default(0).notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspace_id], name: "operator_user_profile_pkey"}),
]);

export const operator_prompt_userInHarness_shared = harness_shared.table("operator_prompt_user", {
	workspace_id: text().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updated_at: bigint({ mode: "number" }).default(0).notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspace_id], name: "operator_prompt_user_pkey"}),
]);

export const operator_preferencesInHarness_shared = harness_shared.table("operator_preferences", {
	workspace_id: text().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updated_at: bigint({ mode: "number" }).default(0).notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspace_id], name: "operator_preferences_pkey"}),
]);

export const operator_oracle_promptInHarness_shared = harness_shared.table("operator_oracle_prompt", {
	workspace_id: text().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updated_at: bigint({ mode: "number" }).default(0).notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspace_id], name: "operator_oracle_prompt_pkey"}),
]);

export const operator_oracle_memoryInHarness_shared = harness_shared.table("operator_oracle_memory", {
	workspace_id: text().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updated_at: bigint({ mode: "number" }).default(0).notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspace_id], name: "operator_oracle_memory_pkey"}),
]);

export const harness_smoke_testInHarness_shared = harness_shared.table("harness_smoke_test", {
	harness_slug: text().primaryKey().notNull(),
	status: text().default('unknown').notNull(),
	pass_content: text(),
	failure_content: text(),
	results: jsonb(),
	startup_log: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	mtime_ms: bigint({ mode: "number" }).default(0).notNull(),
	workspace_id: text().default('').notNull(),
});

export const harness_plan_reviewInHarness_shared = harness_shared.table("harness_plan_review", {
	harness_slug: text().primaryKey().notNull(),
	content: text().default('').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	mtime_ms: bigint({ mode: "number" }).default(0).notNull(),
	workspace_id: text().default('').notNull(),
});

export const harness_healthInHarness_shared = harness_shared.table("harness_health", {
	harness_slug: text().primaryKey().notNull(),
	spec_present: boolean().default(false).notNull(),
	contract_present: boolean().default(false).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	last_check_ms: bigint({ mode: "number" }).default(0).notNull(),
	workspace_id: text().default('').notNull(),
});

export const provision_audit_logInHarness_shared = harness_shared.table("provision_audit_log", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	workspace_id: text().notNull(),
	harness_slug: text().notNull(),
	plugin_slug: text().notNull(),
	ts: timestamp({ withTimezone: true, mode: 'number' }).defaultNow().notNull(),
	kind: text().notNull(),
	run_id: text(),
	data: jsonb(),
}, (table) => [
	index("provision_audit_log_target_idx").using("btree", table.workspace_id.asc().nullsLast().op("text_ops"), table.harness_slug.asc().nullsLast().op("text_ops"), table.plugin_slug.asc().nullsLast().op("text_ops"), table.ts.asc().nullsLast().op("text_ops")),
]);

export const harness_registryInHarness_shared = harness_shared.table("harness_registry", {
	workspace_id: text().primaryKey().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updated_at: bigint({ mode: "number" }).default(0).notNull(),
});

export const operator_trust_storeInHarness_shared = harness_shared.table("operator_trust_store", {
	workspace_id: text().primaryKey().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updated_at: bigint({ mode: "number" }).default(0).notNull(),
	// TODO: failed to parse database type 'bytea'
	payload_ct: text("payload_ct"),
});

export const operator_dismissed_cardsInHarness_shared = harness_shared.table("operator_dismissed_cards", {
	workspace_id: text().notNull(),
	card_id: text().notNull(),
	dismissed_at: timestamp({ withTimezone: true, mode: 'number' }).defaultNow().notNull(),
}, (table) => [
	index("operator_dismissed_cards_dismissed_at_idx").using("btree", table.dismissed_at.asc().nullsLast().op("timestamptz_ops")),
	primaryKey({ columns: [table.workspace_id, table.card_id], name: "operator_dismissed_cards_pkey"}),
	pgPolicy("operator_dismissed_cards_workspace_iso", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const mobile_push_tokensInHarness_shared = harness_shared.table("mobile_push_tokens", {
	device_id: text().notNull(),
	platform: text().notNull(),
	token: text().notNull(),
	registered_at: timestamp({ withTimezone: true, mode: 'number' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.device_id],
			foreignColumns: [mobile_devicesInHarness_shared.device_id],
			name: "mobile_push_tokens_device_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.device_id, table.platform], name: "mobile_push_tokens_pkey"}),
	pgPolicy("mobile_push_tokens_workspace_policy", { as: "permissive", for: "all", to: ["public"], using: sql`(EXISTS ( SELECT 1
   FROM harness_shared.mobile_devices d
  WHERE ((d.device_id = mobile_push_tokens.device_id) AND (d.workspace_id = current_setting('app.workspace_id'::text, true)))))` }),
	check("mobile_push_tokens_platform_check", sql`platform = ANY (ARRAY['apns'::text, 'fcm'::text])`),
]);

export const plugin_reload_stateInHarness_shared = harness_shared.table("plugin_reload_state", {
	plugin_id: text().notNull(),
	harness_slug: text().notNull(),
	state: jsonb().notNull(),
	byte_size: integer().notNull(),
	saved_at: timestamp({ withTimezone: true, mode: 'number' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.plugin_id, table.harness_slug], name: "plugin_reload_state_pkey"}),
]);

export const hidden_pluginsInHarness_shared = harness_shared.table("hidden_plugins", {
	basename: text().notNull(),
	reason: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	hidden_at: bigint({ mode: "number" }).default(0).notNull(),
	hidden_by: text(),
	workspace_id: text().default('').notNull(),
}, (table) => [
	index("hidden_plugins_basename_idx").using("btree", table.basename.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.basename, table.workspace_id], name: "hidden_plugins_pkey"}),
]);

export const harness_text_artifactsInHarness_shared = harness_shared.table("harness_text_artifacts", {
	harness_slug: text().notNull(),
	rel_path: text().notNull(),
	content: text().default('').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updated_at: bigint({ mode: "number" }).default(0).notNull(),
	workspace_id: text().default('').notNull(),
}, (table) => [
	index("hta_updated_idx").using("btree", table.harness_slug.asc().nullsLast().op("int8_ops"), table.updated_at.desc().nullsFirst().op("text_ops")),
	index("hta_workspace_idx").using("btree", table.workspace_id.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.harness_slug, table.rel_path], name: "harness_text_artifacts_pkey"}),
]);

export const system_principalsInHarness_shared = harness_shared.table("system_principals", {
	workspace_id: text().notNull(),
	name: text().notNull(),
	bearer_hash: text().notNull(),
	capabilities: jsonb().default([]).notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'number' }).defaultNow().notNull(),
}, (table) => [
	index("system_principals_workspace_idx").using("btree", table.workspace_id.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.workspace_id, table.name], name: "system_principals_pkey"}),
	pgPolicy("system_principals_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("system_principals_workspace_nonempty", sql`workspace_id <> ''::text`),
]);

export const harness_branch_actionsInHarness_shared = harness_shared.table("harness_branch_actions", {
	harness_slug: text().notNull(),
	branch: text().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	last_check_ms: bigint({ mode: "number" }).default(0).notNull(),
	workspace_id: text().default('').notNull(),
}, (table) => [
	primaryKey({ columns: [table.harness_slug, table.branch], name: "harness_branch_actions_pkey"}),
]);

export const harness_feature_notesInHarness_shared = harness_shared.table("harness_feature_notes", {
	workspace_id: text().notNull(),
	harness_slug: text().notNull(),
	feature_id: text().notNull(),
	content: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updated_at: bigint({ mode: "number" }).default(0).notNull(),
}, (table) => [
	index("harness_feature_notes_harness_idx").using("btree", table.workspace_id.asc().nullsLast().op("text_ops"), table.harness_slug.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.workspace_id, table.harness_slug, table.feature_id], name: "harness_feature_notes_pkey"}),
]);

export const provision_stateInHarness_shared = harness_shared.table("provision_state", {
	workspace_id: text().notNull(),
	harness_slug: text().notNull(),
	plugin_slug: text().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updated_at: bigint({ mode: "number" }).default(0).notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspace_id, table.harness_slug, table.plugin_slug], name: "provision_state_pkey"}),
]);

export const plugin_kvInHarness_shared = harness_shared.table("plugin_kv", {
	plugin_id: text().notNull(),
	harness_slug: text().notNull(),
	key: text().notNull(),
	value: jsonb().notNull(),
	byte_size: integer().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'number' }).defaultNow().notNull(),
}, (table) => [
	index("idx_plugin_kv_prefix").using("btree", table.plugin_id.asc().nullsLast().op("text_ops"), table.harness_slug.asc().nullsLast().op("text_pattern_ops"), table.key.asc().nullsLast().op("text_pattern_ops")),
	index("idx_plugin_kv_quota").using("btree", table.plugin_id.asc().nullsLast().op("text_ops"), table.harness_slug.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.plugin_id, table.harness_slug, table.key], name: "plugin_kv_pkey"}),
]);

export const harness_mission_stateInHarness_shared = harness_shared.table("harness_mission_state", {
	workspace_id: text().default('default').notNull(),
	harness_slug: text().notNull(),
	cost_warn_fired: boolean().default(false).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ready_for_prod_at: bigint({ mode: "number" }),
	lanes: jsonb().default([]).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updated_at: bigint({ mode: "number" }).notNull(),
}, (table) => [
	primaryKey({ columns: [table.workspace_id, table.harness_slug], name: "harness_mission_state_pkey"}),
]);

export const harness_dispatchesInHarness_shared = harness_shared.table("harness_dispatches", {
	workspace_id: text().default('default').notNull(),
	parent_slug: text().notNull(),
	child_slug: text().notNull(),
	child_role: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	dispatch_at: bigint({ mode: "number" }).notNull(),
	result_body: jsonb(),
}, (table) => [
	index("harness_dispatches_parent_idx").using("btree", table.workspace_id.asc().nullsLast().op("text_ops"), table.parent_slug.asc().nullsLast().op("text_ops"), table.dispatch_at.desc().nullsFirst().op("text_ops")),
	primaryKey({ columns: [table.workspace_id, table.parent_slug, table.child_slug, table.dispatch_at], name: "harness_dispatches_pkey"}),
]);

export const harness_run_chunksInHarness_shared = harness_shared.table("harness_run_chunks", {
	workspace_id: text().default('default').notNull(),
	harness_slug: text().notNull(),
	run_id: text().notNull(),
	seq: integer().notNull(),
	chunk_data: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).notNull(),
}, (table) => [
	index("harness_run_chunks_run_idx").using("btree", table.workspace_id.asc().nullsLast().op("int4_ops"), table.harness_slug.asc().nullsLast().op("int4_ops"), table.run_id.asc().nullsLast().op("int4_ops"), table.seq.asc().nullsLast().op("int4_ops")),
	primaryKey({ columns: [table.workspace_id, table.harness_slug, table.run_id, table.seq], name: "harness_run_chunks_pkey"}),
]);

export const autoloop_stateInHarness_shared = harness_shared.table("autoloop_state", {
	harness_slug: text().notNull(),
	role: text().default('director').notNull(),
	last_fired_at: timestamp({ withTimezone: true, mode: 'number' }).defaultNow().notNull(),
	last_status: text(),
	consecutive_errors: integer().default(0).notNull(),
	workspace_id: text().default('').notNull(),
}, (table) => [
	primaryKey({ columns: [table.harness_slug, table.role], name: "autoloop_state_pkey"}),
]);

export const pi_sessionsInHarness_shared = harness_shared.table("pi_sessions", {
	workspace_id: text().notNull(),
	session_id: text().notNull(),
	bearer_hash: text().notNull(),
	capabilities: jsonb().default([]).notNull(),
	started_at: timestamp({ withTimezone: true, mode: 'number' }).defaultNow().notNull(),
	ended_at: timestamp({ withTimezone: true, mode: 'number' }),
}, (table) => [
	index("pi_sessions_active_idx").using("btree", table.workspace_id.asc().nullsLast().op("text_ops"), table.session_id.asc().nullsLast().op("text_ops")).where(sql`(ended_at IS NULL)`),
	index("pi_sessions_workspace_idx").using("btree", table.workspace_id.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.workspace_id, table.session_id], name: "pi_sessions_pkey"}),
	pgPolicy("pi_sessions_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("pi_sessions_workspace_nonempty", sql`workspace_id <> ''::text`),
]);

export const harness_summariesInHarness_shared = harness_shared.table("harness_summaries", {
	harness_slug: text().notNull(),
	content: text().default('').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	mtime_ms: bigint({ mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updated_at: bigint({ mode: "number" }).default(0).notNull(),
	workspace_id: text().default('').notNull(),
	phase: text().default('staging').notNull(),
}, (table) => [
	index("harness_summaries_workspace_idx").using("btree", table.workspace_id.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.harness_slug, table.phase], name: "harness_summaries_pkey"}),
]);

export const harness_archivesInHarness_shared = harness_shared.table("harness_archives", {
	harness_slug: text().notNull(),
	phase: text().default('staging').notNull(),
	id: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	size_bytes: bigint({ mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).default(0).notNull(),
	workspace_id: text().default('').notNull(),
}, (table) => [
	index("harness_archives_slug_phase_ts_idx").using("btree", table.harness_slug.asc().nullsLast().op("int8_ops"), table.phase.asc().nullsLast().op("int8_ops"), table.ts.desc().nullsFirst().op("int8_ops")),
	primaryKey({ columns: [table.harness_slug, table.phase, table.id], name: "harness_archives_pkey"}),
]);

export const harness_screenshotsInHarness_shared = harness_shared.table("harness_screenshots", {
	harness_slug: text().notNull(),
	phase: text().default('staging').notNull(),
	id: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	size_bytes: bigint({ mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).default(0).notNull(),
	workspace_id: text().default('').notNull(),
}, (table) => [
	index("harness_screenshots_slug_phase_ts_idx").using("btree", table.harness_slug.asc().nullsLast().op("int8_ops"), table.phase.asc().nullsLast().op("int8_ops"), table.ts.desc().nullsFirst().op("int8_ops")),
	primaryKey({ columns: [table.harness_slug, table.phase, table.id], name: "harness_screenshots_pkey"}),
]);

export const harness_promotionsInHarness_shared = harness_shared.table("harness_promotions", {
	workspace_id: text().default('default').notNull(),
	harness_slug: text().notNull(),
	promotion_id: text().notNull(),
	from_phase: text().notNull(),
	to_phase: text().notNull(),
	sha: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).notNull(),
}, (table) => [
	index("harness_promotions_ts_idx").using("btree", table.workspace_id.asc().nullsLast().op("int8_ops"), table.harness_slug.asc().nullsLast().op("int8_ops"), table.ts.desc().nullsFirst().op("int8_ops")),
	primaryKey({ columns: [table.workspace_id, table.harness_slug, table.promotion_id], name: "harness_promotions_pkey"}),
]);

export const plugin_capability_grantsInHarness_shared = harness_shared.table("plugin_capability_grants", {
	plugin_name: text().notNull(),
	plugin_version: text().notNull(),
	harness_slug: text().notNull(),
	capability: text().notNull(),
	granted_at: timestamp({ withTimezone: true, mode: 'number' }).defaultNow().notNull(),
	granted_by: text(),
	reason: text(),
}, (table) => [
	index("plugin_caps_by_harness").using("btree", table.harness_slug.asc().nullsLast().op("text_ops"), table.plugin_name.asc().nullsLast().op("text_ops")),
	index("plugin_caps_by_plugin").using("btree", table.plugin_name.asc().nullsLast().op("text_ops"), table.plugin_version.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.plugin_name, table.plugin_version, table.harness_slug, table.capability], name: "plugin_capability_grants_pkey"}),
]);

export const harness_design_artifactsInHarness_shared = harness_shared.table("harness_design_artifacts", {
	id: text().notNull(),
	harness_slug: text().notNull(),
	feature_id: text().notNull(),
	kind: text().notNull(),
	payload: jsonb().notNull(),
	metadata: jsonb(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	created_ts: bigint({ mode: "number" }).notNull(),
}, (table) => [
	index("hda_created_idx").using("btree", table.harness_slug.asc().nullsLast().op("int8_ops"), table.created_ts.desc().nullsFirst().op("text_ops")),
	index("hda_feature_idx").using("btree", table.harness_slug.asc().nullsLast().op("text_ops"), table.feature_id.asc().nullsLast().op("text_ops")),
	index("hda_kind_idx").using("btree", table.harness_slug.asc().nullsLast().op("text_ops"), table.feature_id.asc().nullsLast().op("text_ops"), table.kind.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.id, table.harness_slug], name: "harness_design_artifacts_pkey"}),
	check("hda_kind_chk", sql`kind = ANY (ARRAY['spec'::text, 'sketch'::text, 'screenshot'::text, 'annotation'::text, 'rejected_candidate'::text, 'review'::text])`),
]);

export const harness_brainstormInHarness_shared = harness_shared.table("harness_brainstorm", {
	harness_slug: text().notNull(),
	phase: text().default('staging').notNull(),
	content: text().default('').notNull(),
	canvas: jsonb(),
	mindmap: jsonb(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updated_at: bigint({ mode: "number" }).default(0).notNull(),
	workspace_id: text().default('').notNull(),
}, (table) => [
	index("harness_brainstorm_workspace_idx").using("btree", table.workspace_id.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.harness_slug, table.phase], name: "harness_brainstorm_pkey"}),
]);

export const harness_lanesInHarness_shared = harness_shared.table("harness_lanes", {
	harness_slug: text().notNull(),
	phase: text().default('staging').notNull(),
	role: text().notNull(),
	feature_id: text(),
	pid: integer(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	started_at: bigint({ mode: "number" }).notNull(),
	workspace_id: text().default('').notNull(),
}, (table) => [
	index("harness_lanes_started_idx").using("btree", table.started_at.asc().nullsLast().op("int8_ops")),
	index("harness_lanes_workspace_idx").using("btree", table.workspace_id.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.harness_slug, table.phase, table.role], name: "harness_lanes_pkey"}),
]);

export const harness_hook_logsInHarness_shared = harness_shared.table("harness_hook_logs", {
	harness_slug: text().notNull(),
	log_id: text().notNull(),
	name: text().default('').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	size_bytes: bigint({ mode: "number" }).default(0).notNull(),
	workspace_id: text().default('').notNull(),
	content: text().default('').notNull(),
}, (table) => [
	index("harness_hook_logs_slug_ts_idx").using("btree", table.harness_slug.asc().nullsLast().op("int8_ops"), table.ts.desc().nullsFirst().op("int8_ops")),
	primaryKey({ columns: [table.harness_slug, table.log_id], name: "harness_hook_logs_pkey"}),
]);

export const harness_checkpointsInHarness_shared = harness_shared.table("harness_checkpoints", {
	harness_slug: text().notNull(),
	name: text().notNull(),
	content: text().default('').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	waiting_since_ms: bigint({ mode: "number" }).default(0).notNull(),
	granted: boolean().default(false).notNull(),
	workspace_id: text().default('').notNull(),
	consumed: boolean().default(false).notNull(),
}, (table) => [
	index("harness_checkpoints_slug_waiting_idx").using("btree", table.harness_slug.asc().nullsLast().op("int8_ops"), table.waiting_since_ms.asc().nullsLast().op("int8_ops")),
	primaryKey({ columns: [table.harness_slug, table.name], name: "harness_checkpoints_pkey"}),
]);

export const harness_expert_feedbackInHarness_shared = harness_shared.table("harness_expert_feedback", {
	workspace_id: text().default('default').notNull(),
	harness_slug: text().notNull(),
	expert_id: text().notNull(),
	feedback_id: text().notNull(),
	persona: text().notNull(),
	verdict: jsonb(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	created_at: bigint({ mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ended_at: bigint({ mode: "number" }),
}, (table) => [
	index("harness_expert_feedback_expert_idx").using("btree", table.workspace_id.asc().nullsLast().op("text_ops"), table.harness_slug.asc().nullsLast().op("text_ops"), table.expert_id.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.workspace_id, table.harness_slug, table.expert_id, table.feedback_id], name: "harness_expert_feedback_pkey"}),
]);

export const harness_expert_turnsInHarness_shared = harness_shared.table("harness_expert_turns", {
	workspace_id: text().default('default').notNull(),
	harness_slug: text().notNull(),
	expert_id: text().notNull(),
	feedback_id: text().notNull(),
	turn_idx: integer().notNull(),
	speaker: text().notNull(),
	body: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	created_at: bigint({ mode: "number" }).notNull(),
}, (table) => [
	index("harness_expert_turns_fb_idx").using("btree", table.workspace_id.asc().nullsLast().op("int4_ops"), table.harness_slug.asc().nullsLast().op("text_ops"), table.expert_id.asc().nullsLast().op("text_ops"), table.feedback_id.asc().nullsLast().op("int4_ops"), table.turn_idx.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.workspace_id, table.harness_slug, table.expert_id, table.feedback_id, table.turn_idx], name: "harness_expert_turns_pkey"}),
	check("harness_expert_turns_speaker_check", sql`speaker = ANY (ARRAY['expert'::text, 'feedback'::text])`),
]);

export const harness_snapshots_consolidatedInHarness_shared = harness_shared.table("harness_snapshots_consolidated", {
	harness_slug: text().notNull(),
	snapshot_id: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).notNull(),
	iter_num: integer().default(0).notNull(),
	files: jsonb().default([]).notNull(),
	feature_counts: jsonb().default({}).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	created_ts: bigint({ mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updated_ts: bigint({ mode: "number" }).notNull(),
}, (table) => [
	index("hsc_iter_idx").using("btree", table.harness_slug.asc().nullsLast().op("int4_ops"), table.iter_num.desc().nullsFirst().op("text_ops")),
	index("hsc_ts_idx").using("btree", table.harness_slug.asc().nullsLast().op("text_ops"), table.ts.desc().nullsFirst().op("int8_ops")),
	primaryKey({ columns: [table.harness_slug, table.snapshot_id], name: "harness_snapshots_consolidated_pkey"}),
]);

export const harness_git_logInHarness_shared = harness_shared.table("harness_git_log", {
	harness_slug: text().notNull(),
	sha: text().notNull(),
	parents: jsonb().default([]).notNull(),
	subject: text().default('').notNull(),
	author: text().default('').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).default(0).notNull(),
	refs: jsonb().default([]).notNull(),
	workspace_id: text().default('').notNull(),
}, (table) => [
	index("harness_git_log_slug_ts_idx").using("btree", table.harness_slug.asc().nullsLast().op("int8_ops"), table.ts.desc().nullsFirst().op("int8_ops")),
	primaryKey({ columns: [table.harness_slug, table.sha], name: "harness_git_log_pkey"}),
]);

export const harness_snapshotsInHarness_shared = harness_shared.table("harness_snapshots", {
	workspace_id: text().default('default').notNull(),
	harness_slug: text().notNull(),
	snapshot_id: text().notNull(),
	iteration: integer().notNull(),
	features_json: text(),
	validation_md: text(),
	notes_md: text(),
	config_json: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	taken_at: bigint({ mode: "number" }).notNull(),
}, (table) => [
	index("harness_snapshots_recent_idx").using("btree", table.workspace_id.asc().nullsLast().op("int8_ops"), table.harness_slug.asc().nullsLast().op("int8_ops"), table.taken_at.desc().nullsFirst().op("int8_ops")),
	primaryKey({ columns: [table.workspace_id, table.harness_slug, table.snapshot_id], name: "harness_snapshots_pkey"}),
]);

export const operator_claimsInHarness_shared = harness_shared.table("operator_claims", {
	harness_slug: text().notNull(),
	plugin_slug: text().notNull(),
	machine_id: text().notNull(),
	pid: integer().notNull(),
	run_id: text().notNull(),
	script_hash: text().notNull(),
	claimed_at: timestamp({ withTimezone: true, mode: 'number' }).defaultNow().notNull(),
	expires_at: timestamp({ withTimezone: true, mode: 'number' }).notNull(),
	workspace_id: text().default('').notNull(),
}, (table) => [
	primaryKey({ columns: [table.harness_slug, table.plugin_slug], name: "operator_claims_pkey"}),
]);

export const harness_decisionsInHarness_shared = harness_shared.table("harness_decisions", {
	harness_slug: text().notNull(),
	line_hash: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).default(0).notNull(),
	iso: text().default('').notNull(),
	verb: text().notNull(),
	args: text().default('').notNull(),
	iteration: integer(),
	is_ghost: boolean().default(false).notNull(),
	workspace_id: text().default('').notNull(),
}, (table) => [
	index("harness_decisions_slug_ts_idx").using("btree", table.harness_slug.asc().nullsLast().op("int8_ops"), table.ts.asc().nullsLast().op("int8_ops")),
	primaryKey({ columns: [table.harness_slug, table.line_hash], name: "harness_decisions_pkey"}),
]);

export const pending_reviewsInHarness_shared = harness_shared.table("pending_reviews", {
	harness_slug: text().notNull(),
	review_id: text().notNull(),
	feature_id: text(),
	kind: text().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).notNull(),
	resolved: boolean().default(false).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	mtime_ms: bigint({ mode: "number" }).default(0).notNull(),
	workspace_id: text().default('').notNull(),
	phase: text().default('staging').notNull(),
}, (table) => [
	index("pending_reviews_slug_resolved_ts_idx").using("btree", table.harness_slug.asc().nullsLast().op("int8_ops"), table.resolved.asc().nullsLast().op("int8_ops"), table.ts.desc().nullsFirst().op("text_ops")),
	index("pending_reviews_workspace_idx").using("btree", table.workspace_id.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.harness_slug, table.review_id, table.phase], name: "pending_reviews_pkey"}),
]);

export const harness_run_outputInHarness_shared = harness_shared.table("harness_run_output", {
	workspace_id: text().default('default').notNull(),
	harness_slug: text().notNull(),
	run_id: text().notNull(),
	role: text(),
	prompt_body: text().default('').notNull(),
	jsonl_body: text().default('').notNull(),
	out_body: text().default('').notNull(),
	err_body: text().default('').notNull(),
	exit_code: integer(),
	duration_ms: integer(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	started_at: bigint({ mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ended_at: bigint({ mode: "number" }).notNull(),
}, (table) => [
	index("harness_run_output_recent_idx").using("btree", table.workspace_id.asc().nullsLast().op("int8_ops"), table.harness_slug.asc().nullsLast().op("int8_ops"), table.ended_at.desc().nullsFirst().op("int8_ops")),
	primaryKey({ columns: [table.workspace_id, table.harness_slug, table.run_id], name: "harness_run_output_pkey"}),
]);

export const harness_statusInHarness_shared = harness_shared.table("harness_status", {
	harness_slug: text().notNull(),
	phase: text().default('staging').notNull(),
	status: text().notNull(),
	iteration: integer().default(0).notNull(),
	total_features: integer().default(0).notNull(),
	passed_count: integer().default(0).notNull(),
	todo_count: integer().default(0).notNull(),
	blocked_count: integer().default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	last_active_ts: bigint({ mode: "number" }),
	cost_usd: numeric({ precision: 10, scale:  4 }),
	workspace_id: text().default('').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updated_at: bigint({ mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	expires_at: bigint({ mode: "number" }).default(0).notNull(),
}, (table) => [
	index("harness_status_expires_idx").using("btree", table.expires_at.asc().nullsLast().op("int8_ops")),
	index("harness_status_updated_idx").using("btree", table.updated_at.asc().nullsLast().op("int8_ops")),
	index("harness_status_workspace_idx").using("btree", table.workspace_id.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.harness_slug, table.phase], name: "harness_status_pkey"}),
	check("harness_status_status_check", sql`status = ANY (ARRAY['idle'::text, 'running'::text, 'stalled'::text, 'paused'::text, 'error'::text])`),
]);

export const harness_chunk_plansInHarness_shared = harness_shared.table("harness_chunk_plans", {
	workspace_id: text().notNull(),
	harness_slug: text().notNull(),
	feature_id: text().notNull(),
	chunk_id: text().notNull(),
	chunk_index: integer().notNull(),
	files: jsonb().notNull(),
	description: text().notNull(),
	status: text().default('pending').notNull(),
	strikes: integer().default(0).notNull(),
	last_error: text(),
	commit_sha: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	created_ts: bigint({ mode: "number" }).default(sql`(EXTRACT(epoch FROM now()) * 1000)::bigint`).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updated_ts: bigint({ mode: "number" }).default(sql`(EXTRACT(epoch FROM now()) * 1000)::bigint`).notNull(),
	spawned_by_spawn_id: text(),
}, (table) => [
	index("chunk_plans_by_spawned_by").using("btree", table.workspace_id.asc().nullsLast().op("text_ops"), table.harness_slug.asc().nullsLast().op("text_ops"), table.spawned_by_spawn_id.asc().nullsLast().op("text_ops")).where(sql`(spawned_by_spawn_id IS NOT NULL)`),
	index("idx_chunk_plans_by_feature").using("btree", table.workspace_id.asc().nullsLast().op("int4_ops"), table.harness_slug.asc().nullsLast().op("text_ops"), table.feature_id.asc().nullsLast().op("text_ops"), table.chunk_index.asc().nullsLast().op("int4_ops")),
	index("idx_chunk_plans_by_status").using("btree", table.workspace_id.asc().nullsLast().op("text_ops"), table.harness_slug.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")).where(sql`(status = ANY (ARRAY['in_progress'::text, 'failing'::text, 'escalated'::text]))`),
	primaryKey({ columns: [table.workspace_id, table.harness_slug, table.feature_id, table.chunk_id], name: "harness_chunk_plans_pkey"}),
	pgPolicy("chunk_plans_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
]);

export const harness_proposals_sharedInHarness_shared = harness_shared.table("harness_proposals_shared", {
	harness_slug: text().notNull(),
	proposal_id: text().notNull(),
	payload: jsonb().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	mtime_ms: bigint({ mode: "number" }).default(0).notNull(),
	workspace_id: text().default('').notNull(),
	phase: text().default('staging').notNull(),
	status: text().default('pending').notNull(),
	review_verdict: text(),
	review_summary: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	reviewed_at: bigint({ mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	applied_at: bigint({ mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	rejected_at: bigint({ mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	size_bytes: bigint({ mode: "number" }).default(0).notNull(),
}, (table) => [
	index("harness_proposals_shared_slug_ts_idx").using("btree", table.harness_slug.asc().nullsLast().op("int8_ops"), table.ts.desc().nullsFirst().op("text_ops")),
	index("harness_proposals_shared_status_idx").using("btree", table.harness_slug.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")),
	index("harness_proposals_shared_workspace_idx").using("btree", table.workspace_id.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.harness_slug, table.proposal_id, table.phase], name: "harness_proposals_shared_pkey"}),
]);

export const agent_runs_consolidatedInHarness_shared = harness_shared.table("agent_runs_consolidated", {
	harness_slug: text().notNull(),
	run_id: text().notNull(),
	role: text().notNull(),
	feature_id: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	size_bytes: bigint({ mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	duration_ms: bigint({ mode: "number" }).default(0).notNull(),
	cost_usd: doublePrecision().default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	input_tokens: bigint({ mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	output_tokens: bigint({ mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	cache_read_tokens: bigint({ mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	cache_creation_tokens: bigint({ mode: "number" }).default(0).notNull(),
	running: boolean().default(false).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	last_event_ts: bigint({ mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	created_ts: bigint({ mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updated_ts: bigint({ mode: "number" }).notNull(),
}, (table) => [
	index("arc_feature_idx").using("btree", table.harness_slug.asc().nullsLast().op("text_ops"), table.feature_id.asc().nullsLast().op("text_ops")),
	index("arc_role_idx").using("btree", table.harness_slug.asc().nullsLast().op("text_ops"), table.role.asc().nullsLast().op("text_ops")),
	index("arc_running_idx").using("btree", table.harness_slug.asc().nullsLast().op("text_ops"), table.running.asc().nullsLast().op("text_ops")).where(sql`(running = true)`),
	index("arc_ts_idx").using("btree", table.harness_slug.asc().nullsLast().op("int8_ops"), table.ts.desc().nullsFirst().op("int8_ops")),
	primaryKey({ columns: [table.harness_slug, table.run_id], name: "agent_runs_consolidated_pkey"}),
]);

export const harness_issues_consolidatedInHarness_shared = harness_shared.table("harness_issues_consolidated", {
	harness_slug: text().notNull(),
	issue_id: text().notNull(),
	title: text().notNull(),
	severity: text().notNull(),
	source: text().notNull(),
	status: text().notNull(),
	found_at: timestamp({ withTimezone: true, mode: 'number' }).notNull(),
	found_during: text(),
	repro: text(),
	evidence: text(),
	suggested_fix: text(),
	code_pointer: text(),
	linked_feature_id: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	attempts: bigint({ mode: "number" }).default(0).notNull(),
	notes: jsonb().default([]).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	created_ts: bigint({ mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updated_ts: bigint({ mode: "number" }).notNull(),
}, (table) => [
	index("hic_found_during_idx").using("btree", table.found_during.asc().nullsLast().op("text_ops")),
	index("hic_linked_idx").using("btree", table.linked_feature_id.asc().nullsLast().op("text_ops")),
	index("hic_severity_idx").using("btree", table.harness_slug.asc().nullsLast().op("text_ops"), table.severity.asc().nullsLast().op("text_ops")),
	index("hic_status_idx").using("btree", table.harness_slug.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.harness_slug, table.issue_id], name: "harness_issues_consolidated_pkey"}),
]);

export const snapshot_featuresInHarness_shared = harness_shared.table("snapshot_features", {
	harness_slug: text().notNull(),
	snapshot_id: text().notNull(),
	feature_id: text().notNull(),
	title: text().notNull(),
	summary: text(),
	status: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	attempts: bigint({ mode: "number" }).notNull(),
	claims: text(),
	notes: text(),
	metadata: jsonb(),
	kind: text(),
	project_id: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	expected_cost_cents: bigint({ mode: "number" }),
	tags: jsonb(),
	needs_human_review: boolean().default(false).notNull(),
	deprecation_reason: text(),
	parent_id: text(),
	goal_id: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	created_ts: bigint({ mode: "number" }).notNull(),
}, (table) => [
	index("sf_snapshot_idx").using("btree", table.harness_slug.asc().nullsLast().op("text_ops"), table.snapshot_id.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.harness_slug, table.snapshot_id, table.feature_id], name: "snapshot_features_pkey"}),
]);

export const harness_features_consolidatedInHarness_shared = harness_shared.table("harness_features_consolidated", {
	harness_slug: text().notNull(),
	feature_id: text().notNull(),
	title: text(),
	summary: text(),
	status: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	attempts: bigint({ mode: "number" }),
	claims: text(),
	notes: text(),
	metadata: jsonb(),
	kind: text(),
	project_id: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	expected_cost_cents: bigint({ mode: "number" }),
	tags: jsonb(),
	needs_human_review: boolean(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	created_ts: bigint({ mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updated_ts: bigint({ mode: "number" }),
	parent_id: text(),
	goal_id: text(),
	taken_by: text(),
	taken_at: timestamp({ withTimezone: true, mode: 'number' }),
	expires_at: timestamp({ withTimezone: true, mode: 'number' }),
	workspace_id: text().notNull(),
	// TODO: failed to parse database type 'tsvector'
	_search: text("_search").generatedAlwaysAs(sql`((setweight(to_tsvector('english'::regconfig, COALESCE(title, ''::text)), 'A'::"char") || setweight(to_tsvector('english'::regconfig, COALESCE(summary, ''::text)), 'B'::"char")) || setweight(to_tsvector('english'::regconfig, COALESCE(notes, ''::text)), 'C'::"char"))`),
	deprecation_reason: text(),
	see_also: text().array().default([""]).notNull(),
	needs_design: boolean().default(false).notNull(),
	design_status: text(),
	design_spec_id: text(),
	discarded_design_work: boolean().default(false).notNull(),
}, (table) => [
	index("hfc_design_status_idx").using("btree", table.harness_slug.asc().nullsLast().op("text_ops"), table.design_status.asc().nullsLast().op("text_ops")).where(sql`(design_status IS NOT NULL)`),
	index("hfc_needs_design_idx").using("btree", table.harness_slug.asc().nullsLast().op("bool_ops"), table.needs_design.asc().nullsLast().op("bool_ops")).where(sql`(needs_design = true)`),
	index("hfc_review_idx").using("btree", table.needs_human_review.asc().nullsLast().op("bool_ops")),
	index("hfc_search_idx").using("gin", table._search.asc().nullsLast().op("tsvector_ops")),
	index("hfc_see_also_gin").using("gin", table.see_also.asc().nullsLast().op("array_ops")),
	index("hfc_slug_idx").using("btree", table.harness_slug.asc().nullsLast().op("text_ops")),
	index("hfc_status_idx").using("btree", table.status.asc().nullsLast().op("text_ops")),
	index("hfc_updated_idx").using("btree", table.updated_ts.desc().nullsFirst().op("int8_ops")),
	index("hfc_workspace_idx").using("btree", table.workspace_id.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.harness_slug, table.feature_id], name: "harness_features_consolidated_pkey"}),
	pgPolicy("harness_features_consolidated_workspace_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`  }),
	check("hfc_design_status_chk", sql`(design_status IS NULL) OR (design_status = ANY (ARRAY['pending'::text, 'accepted'::text, 'ignored'::text]))`),
	check("hfc_workspace_nonempty", sql`workspace_id <> ''::text`),
]);
export const tool_invocations_spawn_treeInHarness_shared = harness_shared.view("tool_invocations_spawn_tree", {	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }),
	workspace_id: text(),
	harness_slug: text(),
	plugin_name: text(),
	tool_name: text(),
	role: text(),
	feature_id: text(),
	chunk_id: text(),
	run_id: text(),
	spawn_id: text(),
	parent_spawn_id: text(),
	window_key: text(),
	invoked_at: timestamp({ withTimezone: true, mode: 'number' }),
	duration_ms: integer(),
	status: text(),
	output_ref: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	output_size: bigint({ mode: "number" }),
	error_message: text(),
	depth: integer(),
	root_spawn_id: text(),
}).as(sql`WITH RECURSIVE chain AS ( SELECT tool_invocations.id, tool_invocations.workspace_id, tool_invocations.harness_slug, tool_invocations.plugin_name, tool_invocations.tool_name, tool_invocations.role, tool_invocations.feature_id, tool_invocations.chunk_id, tool_invocations.run_id, tool_invocations.spawn_id, tool_invocations.parent_spawn_id, tool_invocations.window_key, tool_invocations.invoked_at, tool_invocations.duration_ms, tool_invocations.status, tool_invocations.output_ref, tool_invocations.output_size, tool_invocations.error_message, 0 AS depth, tool_invocations.spawn_id AS root_spawn_id FROM harness_shared.tool_invocations WHERE tool_invocations.parent_spawn_id IS NULL OR tool_invocations.parent_spawn_id = ''::text UNION ALL SELECT t.id, t.workspace_id, t.harness_slug, t.plugin_name, t.tool_name, t.role, t.feature_id, t.chunk_id, t.run_id, t.spawn_id, t.parent_spawn_id, t.window_key, t.invoked_at, t.duration_ms, t.status, t.output_ref, t.output_size, t.error_message, c.depth + 1, c.root_spawn_id FROM harness_shared.tool_invocations t JOIN chain c ON t.parent_spawn_id = c.spawn_id AND t.workspace_id = c.workspace_id AND c.depth < 16 ) SELECT id, workspace_id, harness_slug, plugin_name, tool_name, role, feature_id, chunk_id, run_id, spawn_id, parent_spawn_id, window_key, invoked_at, duration_ms, status, output_ref, output_size, error_message, depth, root_spawn_id FROM chain`);

export const tool_invocations_artifactsInHarness_shared = harness_shared.view("tool_invocations_artifacts", {	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }),
	workspace_id: text(),
	harness_slug: text(),
	plugin_name: text(),
	tool_name: text(),
	role: text(),
	feature_id: text(),
	chunk_id: text(),
	run_id: text(),
	spawn_id: text(),
	invoked_at: timestamp({ withTimezone: true, mode: 'number' }),
	duration_ms: integer(),
	status: text(),
	output_ref: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	output_size: bigint({ mode: "number" }),
}).as(sql`SELECT id, workspace_id, harness_slug, plugin_name, tool_name, role, feature_id, chunk_id, run_id, spawn_id, invoked_at, duration_ms, status, output_ref, output_size FROM harness_shared.tool_invocations WHERE output_ref IS NOT NULL AND output_ref <> ''::text AND status = 'ok'::text`);

export const operator_decisionsInHarness_shared = harness_shared.view("operator_decisions", {	id: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }),
	actor: text(),
	action: text(),
	target: text(),
	details: jsonb(),
	workspace_id: text(),
}).as(sql`SELECT id, ts, actor, action, subject AS target, details, workspace_id FROM harness_shared.audit_log WHERE actor = 'system:operator'::text`);

export const system_principal_activityInHarness_shared = harness_shared.view("system_principal_activity", {	id: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ts: bigint({ mode: "number" }),
	actor: text(),
	action: text(),
	target: text(),
	details: jsonb(),
	workspace_id: text(),
}).as(sql`SELECT id, ts, actor, action, subject AS target, details, workspace_id FROM harness_shared.audit_log WHERE actor ~~ 'system:%'::text OR actor ~~ 'pi:%'::text`);