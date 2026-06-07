import { relations } from "drizzle-orm/relations";
import { usersInHarnessShared, userSessionsInHarnessShared, userPreferencesInHarnessShared, llmTestRunsInHarnessShared, llmTestFindingsInHarnessShared, llmTestFixturesInHarnessShared, beekeeperInstancesInHarnessShared, beekeeperRunsInHarnessShared, beekeeperSessionsInHarnessShared, projectsInHarnessShared, projectSpecRevisionsInHarnessShared, messagesInPapercupShared, messageCommentsInPapercupShared, backupSnapshotsInHarnessShared, backupEventsInHarnessShared, memoryCanonicalInHarnessShared, memoryVecOpenaiInHarnessShared, memoryVecLocalInHarnessShared, planRunsInHarnessShared, planRunTurnsInHarnessShared, operatorConversationsInHarnessShared, operatorTurnsInHarnessShared, goalsInHarnessShared, messageRecipientsInPapercupShared, mobileDevicesInHarnessShared, mobilePushTokensInHarnessShared, memoryAnchorsInHarnessShared, beekeeperScoresInHarnessShared } from "./generated";

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

export const userPreferencesInHarnessSharedRelations = relations(userPreferencesInHarnessShared, ({one}) => ({
	usersInHarnessShared: one(usersInHarnessShared, {
		fields: [userPreferencesInHarnessShared.userId],
		references: [usersInHarnessShared.id]
	}),
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

export const beekeeperRunsInHarnessSharedRelations = relations(beekeeperRunsInHarnessShared, ({one, many}) => ({
	beekeeperInstancesInHarnessShared: one(beekeeperInstancesInHarnessShared, {
		fields: [beekeeperRunsInHarnessShared.instanceId],
		references: [beekeeperInstancesInHarnessShared.instanceId]
	}),
	beekeeperScoresInHarnessShareds: many(beekeeperScoresInHarnessShared),
}));

export const beekeeperInstancesInHarnessSharedRelations = relations(beekeeperInstancesInHarnessShared, ({many}) => ({
	beekeeperRunsInHarnessShareds: many(beekeeperRunsInHarnessShared),
	beekeeperSessionsInHarnessShareds: many(beekeeperSessionsInHarnessShared),
}));

export const beekeeperSessionsInHarnessSharedRelations = relations(beekeeperSessionsInHarnessShared, ({one}) => ({
	beekeeperInstancesInHarnessShared: one(beekeeperInstancesInHarnessShared, {
		fields: [beekeeperSessionsInHarnessShared.instanceId],
		references: [beekeeperInstancesInHarnessShared.instanceId]
	}),
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

export const messageCommentsInPapercupSharedRelations = relations(messageCommentsInPapercupShared, ({one}) => ({
	messagesInPapercupShared: one(messagesInPapercupShared, {
		fields: [messageCommentsInPapercupShared.messageId],
		references: [messagesInPapercupShared.id]
	}),
}));

export const messagesInPapercupSharedRelations = relations(messagesInPapercupShared, ({many}) => ({
	messageCommentsInPapercupShareds: many(messageCommentsInPapercupShared),
	messageRecipientsInPapercupShareds: many(messageRecipientsInPapercupShared),
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

export const memoryCanonicalInHarnessSharedRelations = relations(memoryCanonicalInHarnessShared, ({many}) => ({
	memoryVecOpenaiInHarnessShareds: many(memoryVecOpenaiInHarnessShared),
	memoryVecLocalInHarnessShareds: many(memoryVecLocalInHarnessShared),
	memoryAnchorsInHarnessShareds: many(memoryAnchorsInHarnessShared),
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

export const messageRecipientsInPapercupSharedRelations = relations(messageRecipientsInPapercupShared, ({one}) => ({
	messagesInPapercupShared: one(messagesInPapercupShared, {
		fields: [messageRecipientsInPapercupShared.messageId],
		references: [messagesInPapercupShared.id]
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

export const memoryAnchorsInHarnessSharedRelations = relations(memoryAnchorsInHarnessShared, ({one}) => ({
	memoryCanonicalInHarnessShared: one(memoryCanonicalInHarnessShared, {
		fields: [memoryAnchorsInHarnessShared.memoryId],
		references: [memoryCanonicalInHarnessShared.id]
	}),
}));

export const beekeeperScoresInHarnessSharedRelations = relations(beekeeperScoresInHarnessShared, ({one}) => ({
	beekeeperRunsInHarnessShared: one(beekeeperRunsInHarnessShared, {
		fields: [beekeeperScoresInHarnessShared.runId],
		references: [beekeeperRunsInHarnessShared.runId]
	}),
}));