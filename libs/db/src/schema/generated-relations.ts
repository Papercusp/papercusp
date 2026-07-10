import { relations } from "drizzle-orm/relations";
import { usersInHarnessShared, userSessionsInHarnessShared, llmTestRunsInHarnessShared, llmTestFindingsInHarnessShared, llmTestFixturesInHarnessShared, memoryCanonicalInHarnessShared, memoryVecGemmaInHarnessShared, beekeeperInstancesInHarnessShared, beekeeperRunsInHarnessShared, projectsInHarnessShared, projectSpecRevisionsInHarnessShared, messagesInPapercuspShared, messageCommentsInPapercuspShared, backupSnapshotsInHarnessShared, backupEventsInHarnessShared, memoryVecOpenaiInHarnessShared, memoryVecLocalInHarnessShared, planRunsInHarnessShared, planRunTurnsInHarnessShared, operatorConversationsInHarnessShared, operatorTurnsInHarnessShared, benchmarkRolloutInHarnessShared, benchmarkRunResultInHarnessShared, potEvalInstancesInHarnessShared, potEvalRunsInHarnessShared, memoryVecHarrierInHarnessShared, benchRunsInHarnessShared, benchRunEventsInHarnessShared, goalsInHarnessShared, messageRecipientsInPapercuspShared, mobileDevicesInHarnessShared, mobilePushTokensInHarnessShared, userPreferencesInHarnessShared, memoryAnchorsInHarnessShared, potEvalScoresInHarnessShared, beekeeperScoresInHarnessShared, benchRunTasksInHarnessShared, hivesInHarnessShared, hiveMembersInHarnessShared } from "./generated";

export const userSessionsInHarnessSharedRelations = relations(userSessionsInHarnessShared, ({one}) => ({
	usersInHarnessShared: one(usersInHarnessShared, {
		fields: [userSessionsInHarnessShared.userId],
		references: [usersInHarnessShared.id]
	}),
}));

export const usersInHarnessSharedRelations = relations(usersInHarnessShared, ({many}) => ({
	userSessionsInHarnessShareds: many(userSessionsInHarnessShared),
	userPreferencesInHarnessShareds: many(userPreferencesInHarnessShared),
}));

export const llmTestFindingsInHarnessSharedRelations = relations(llmTestFindingsInHarnessShared, ({one}) => ({
	llmTestRunsInHarnessShared: one(llmTestRunsInHarnessShared, {
		fields: [llmTestFindingsInHarnessShared.runId],
		references: [llmTestRunsInHarnessShared.id]
	}),
}));

export const llmTestRunsInHarnessSharedRelations = relations(llmTestRunsInHarnessShared, ({many}) => ({
	llmTestFindingsInHarnessShareds: many(llmTestFindingsInHarnessShared),
	llmTestFixturesInHarnessShareds: many(llmTestFixturesInHarnessShared),
}));

export const llmTestFixturesInHarnessSharedRelations = relations(llmTestFixturesInHarnessShared, ({one}) => ({
	llmTestRunsInHarnessShared: one(llmTestRunsInHarnessShared, {
		fields: [llmTestFixturesInHarnessShared.recordedFromRunId],
		references: [llmTestRunsInHarnessShared.id]
	}),
}));

export const memoryVecGemmaInHarnessSharedRelations = relations(memoryVecGemmaInHarnessShared, ({one}) => ({
	memoryCanonicalInHarnessShared: one(memoryCanonicalInHarnessShared, {
		fields: [memoryVecGemmaInHarnessShared.memoryId],
		references: [memoryCanonicalInHarnessShared.id]
	}),
}));

export const memoryCanonicalInHarnessSharedRelations = relations(memoryCanonicalInHarnessShared, ({many}) => ({
	memoryVecGemmaInHarnessShareds: many(memoryVecGemmaInHarnessShared),
	memoryVecOpenaiInHarnessShareds: many(memoryVecOpenaiInHarnessShared),
	memoryVecLocalInHarnessShareds: many(memoryVecLocalInHarnessShared),
	memoryVecHarrierInHarnessShareds: many(memoryVecHarrierInHarnessShared),
	memoryAnchorsInHarnessShareds: many(memoryAnchorsInHarnessShared),
}));

export const beekeeperRunsInHarnessSharedRelations = relations(beekeeperRunsInHarnessShared, ({one, many}) => ({
	beekeeperInstancesInHarnessShared: one(beekeeperInstancesInHarnessShared, {
		fields: [beekeeperRunsInHarnessShared.instanceId],
		references: [beekeeperInstancesInHarnessShared.instanceId]
	}),
	beekeeperScoresInHarnessShareds: many(beekeeperScoresInHarnessShared),
}));

export const beekeeperInstancesInHarnessSharedRelations = relations(beekeeperInstancesInHarnessShared, ({many}) => ({
	beekeeperRunsInHarnessShareds: many(beekeeperRunsInHarnessShared),
}));

export const projectSpecRevisionsInHarnessSharedRelations = relations(projectSpecRevisionsInHarnessShared, ({one}) => ({
	projectsInHarnessShared: one(projectsInHarnessShared, {
		fields: [projectSpecRevisionsInHarnessShared.projectId],
		references: [projectsInHarnessShared.id]
	}),
}));

export const projectsInHarnessSharedRelations = relations(projectsInHarnessShared, ({many}) => ({
	projectSpecRevisionsInHarnessShareds: many(projectSpecRevisionsInHarnessShared),
}));

export const messageCommentsInPapercuspSharedRelations = relations(messageCommentsInPapercuspShared, ({one}) => ({
	messagesInPapercuspShared: one(messagesInPapercuspShared, {
		fields: [messageCommentsInPapercuspShared.messageId],
		references: [messagesInPapercuspShared.id]
	}),
}));

export const messagesInPapercuspSharedRelations = relations(messagesInPapercuspShared, ({many}) => ({
	messageCommentsInPapercuspShareds: many(messageCommentsInPapercuspShared),
	messageRecipientsInPapercuspShareds: many(messageRecipientsInPapercuspShared),
}));

export const backupEventsInHarnessSharedRelations = relations(backupEventsInHarnessShared, ({one}) => ({
	backupSnapshotsInHarnessShared: one(backupSnapshotsInHarnessShared, {
		fields: [backupEventsInHarnessShared.snapshotId],
		references: [backupSnapshotsInHarnessShared.id]
	}),
}));

export const backupSnapshotsInHarnessSharedRelations = relations(backupSnapshotsInHarnessShared, ({many}) => ({
	backupEventsInHarnessShareds: many(backupEventsInHarnessShared),
}));

export const memoryVecOpenaiInHarnessSharedRelations = relations(memoryVecOpenaiInHarnessShared, ({one}) => ({
	memoryCanonicalInHarnessShared: one(memoryCanonicalInHarnessShared, {
		fields: [memoryVecOpenaiInHarnessShared.memoryId],
		references: [memoryCanonicalInHarnessShared.id]
	}),
}));

export const memoryVecLocalInHarnessSharedRelations = relations(memoryVecLocalInHarnessShared, ({one}) => ({
	memoryCanonicalInHarnessShared: one(memoryCanonicalInHarnessShared, {
		fields: [memoryVecLocalInHarnessShared.memoryId],
		references: [memoryCanonicalInHarnessShared.id]
	}),
}));

export const planRunTurnsInHarnessSharedRelations = relations(planRunTurnsInHarnessShared, ({one}) => ({
	planRunsInHarnessShared: one(planRunsInHarnessShared, {
		fields: [planRunTurnsInHarnessShared.planRunId],
		references: [planRunsInHarnessShared.id]
	}),
}));

export const planRunsInHarnessSharedRelations = relations(planRunsInHarnessShared, ({many}) => ({
	planRunTurnsInHarnessShareds: many(planRunTurnsInHarnessShared),
}));

export const operatorTurnsInHarnessSharedRelations = relations(operatorTurnsInHarnessShared, ({one}) => ({
	operatorConversationsInHarnessShared: one(operatorConversationsInHarnessShared, {
		fields: [operatorTurnsInHarnessShared.conversationId],
		references: [operatorConversationsInHarnessShared.id]
	}),
}));

export const operatorConversationsInHarnessSharedRelations = relations(operatorConversationsInHarnessShared, ({many}) => ({
	operatorTurnsInHarnessShareds: many(operatorTurnsInHarnessShared),
}));

export const benchmarkRunResultInHarnessSharedRelations = relations(benchmarkRunResultInHarnessShared, ({one}) => ({
	benchmarkRolloutInHarnessShared: one(benchmarkRolloutInHarnessShared, {
		fields: [benchmarkRunResultInHarnessShared.rolloutId],
		references: [benchmarkRolloutInHarnessShared.rolloutId]
	}),
}));

export const benchmarkRolloutInHarnessSharedRelations = relations(benchmarkRolloutInHarnessShared, ({many}) => ({
	benchmarkRunResultInHarnessShareds: many(benchmarkRunResultInHarnessShared),
}));

export const potEvalRunsInHarnessSharedRelations = relations(potEvalRunsInHarnessShared, ({one, many}) => ({
	potEvalInstancesInHarnessShared: one(potEvalInstancesInHarnessShared, {
		fields: [potEvalRunsInHarnessShared.instanceId],
		references: [potEvalInstancesInHarnessShared.instanceId]
	}),
	potEvalScoresInHarnessShareds: many(potEvalScoresInHarnessShared),
}));

export const potEvalInstancesInHarnessSharedRelations = relations(potEvalInstancesInHarnessShared, ({many}) => ({
	potEvalRunsInHarnessShareds: many(potEvalRunsInHarnessShared),
}));

export const memoryVecHarrierInHarnessSharedRelations = relations(memoryVecHarrierInHarnessShared, ({one}) => ({
	memoryCanonicalInHarnessShared: one(memoryCanonicalInHarnessShared, {
		fields: [memoryVecHarrierInHarnessShared.memoryId],
		references: [memoryCanonicalInHarnessShared.id]
	}),
}));

export const benchRunEventsInHarnessSharedRelations = relations(benchRunEventsInHarnessShared, ({one}) => ({
	benchRunsInHarnessShared: one(benchRunsInHarnessShared, {
		fields: [benchRunEventsInHarnessShared.runId],
		references: [benchRunsInHarnessShared.id]
	}),
}));

export const benchRunsInHarnessSharedRelations = relations(benchRunsInHarnessShared, ({many}) => ({
	benchRunEventsInHarnessShareds: many(benchRunEventsInHarnessShared),
	benchRunTasksInHarnessShareds: many(benchRunTasksInHarnessShared),
}));

export const goalsInHarnessSharedRelations = relations(goalsInHarnessShared, ({one, many}) => ({
	goalsInHarnessShared: one(goalsInHarnessShared, {
		fields: [goalsInHarnessShared.parentId],
		references: [goalsInHarnessShared.id],
		relationName: "goalsInHarnessShared_parentId_goalsInHarnessShared_id"
	}),
	goalsInHarnessShareds: many(goalsInHarnessShared, {
		relationName: "goalsInHarnessShared_parentId_goalsInHarnessShared_id"
	}),
}));

export const messageRecipientsInPapercuspSharedRelations = relations(messageRecipientsInPapercuspShared, ({one}) => ({
	messagesInPapercuspShared: one(messagesInPapercuspShared, {
		fields: [messageRecipientsInPapercuspShared.messageId],
		references: [messagesInPapercuspShared.id]
	}),
}));

export const mobilePushTokensInHarnessSharedRelations = relations(mobilePushTokensInHarnessShared, ({one}) => ({
	mobileDevicesInHarnessShared: one(mobileDevicesInHarnessShared, {
		fields: [mobilePushTokensInHarnessShared.deviceId],
		references: [mobileDevicesInHarnessShared.deviceId]
	}),
}));

export const mobileDevicesInHarnessSharedRelations = relations(mobileDevicesInHarnessShared, ({many}) => ({
	mobilePushTokensInHarnessShareds: many(mobilePushTokensInHarnessShared),
}));

export const userPreferencesInHarnessSharedRelations = relations(userPreferencesInHarnessShared, ({one}) => ({
	usersInHarnessShared: one(usersInHarnessShared, {
		fields: [userPreferencesInHarnessShared.userId],
		references: [usersInHarnessShared.id]
	}),
}));

export const memoryAnchorsInHarnessSharedRelations = relations(memoryAnchorsInHarnessShared, ({one}) => ({
	memoryCanonicalInHarnessShared: one(memoryCanonicalInHarnessShared, {
		fields: [memoryAnchorsInHarnessShared.memoryId],
		references: [memoryCanonicalInHarnessShared.id]
	}),
}));

export const potEvalScoresInHarnessSharedRelations = relations(potEvalScoresInHarnessShared, ({one}) => ({
	potEvalRunsInHarnessShared: one(potEvalRunsInHarnessShared, {
		fields: [potEvalScoresInHarnessShared.runId],
		references: [potEvalRunsInHarnessShared.runId]
	}),
}));

export const beekeeperScoresInHarnessSharedRelations = relations(beekeeperScoresInHarnessShared, ({one}) => ({
	beekeeperRunsInHarnessShared: one(beekeeperRunsInHarnessShared, {
		fields: [beekeeperScoresInHarnessShared.runId],
		references: [beekeeperRunsInHarnessShared.runId]
	}),
}));

export const benchRunTasksInHarnessSharedRelations = relations(benchRunTasksInHarnessShared, ({one}) => ({
	benchRunsInHarnessShared: one(benchRunsInHarnessShared, {
		fields: [benchRunTasksInHarnessShared.runId],
		references: [benchRunsInHarnessShared.id]
	}),
}));

export const hiveMembersInHarnessSharedRelations = relations(hiveMembersInHarnessShared, ({one}) => ({
	hivesInHarnessShared: one(hivesInHarnessShared, {
		fields: [hiveMembersInHarnessShared.workspaceId],
		references: [hivesInHarnessShared.workspaceId]
	}),
}));

export const hivesInHarnessSharedRelations = relations(hivesInHarnessShared, ({many}) => ({
	hiveMembersInHarnessShareds: many(hiveMembersInHarnessShared),
}));