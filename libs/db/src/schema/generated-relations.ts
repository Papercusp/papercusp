import { relations } from "drizzle-orm/relations";
import { routineGroupsInHarnessShared, routinesInHarnessShared, usersInHarnessShared, userSessionsInHarnessShared, llmTestRunsInHarnessShared, llmTestFindingsInHarnessShared, llmTestFixturesInHarnessShared, memoryCanonicalInHarnessShared, memoryVecGemmaInHarnessShared, projectsInHarnessShared, projectSpecRevisionsInHarnessShared, messagesInPapercuspShared, messageCommentsInPapercuspShared, backupSnapshotsInHarnessShared, backupEventsInHarnessShared, memoryVecLocalInHarnessShared, memoryVecOpenaiInHarnessShared, planRunsInHarnessShared, planRunTurnsInHarnessShared, eventAwaitNodesInHarnessShared, operatorConversationsInHarnessShared, operatorTurnsInHarnessShared, goalsInHarnessShared, goalProjectsInHarnessShared, benchmarkRolloutInHarnessShared, benchmarkRunResultInHarnessShared, savedPromptsInHarnessShared, potEvalInstancesInHarnessShared, potEvalRunsInHarnessShared, memoryVecHarrierInHarnessShared, benchRunsInHarnessShared, benchRunEventsInHarnessShared, cupKeeperInstancesInHarnessShared, cupKeeperRunsInHarnessShared, memoryRecallStatsInHarnessShared, memoryRecallQueryTextInHarnessShared, messageRecipientsInPapercuspShared, mobileDevicesInHarnessShared, mobilePushTokensInHarnessShared, userPreferencesInHarnessShared, memoryAnchorsInHarnessShared, sessionTurnsInHarnessShared, sessionTurnChunksInHarnessShared, harnessPlansInHarnessShared, planDecisionsInHarnessShared, planItemsInHarnessShared, potEvalScoresInHarnessShared, cupKeeperScoresInHarnessShared, benchRunTasksInHarnessShared, potsInHarnessShared, potMembersInHarnessShared } from "./generated";

export const routinesInHarnessSharedRelations = relations(routinesInHarnessShared, ({one}) => ({
	routineGroupsInHarnessShared: one(routineGroupsInHarnessShared, {
		fields: [routinesInHarnessShared.workspaceId],
		references: [routineGroupsInHarnessShared.workspaceId]
	}),
}));

export const routineGroupsInHarnessSharedRelations = relations(routineGroupsInHarnessShared, ({many}) => ({
	routinesInHarnessShareds: many(routinesInHarnessShared),
}));

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
	memoryVecLocalInHarnessShareds: many(memoryVecLocalInHarnessShared),
	memoryVecOpenaiInHarnessShareds: many(memoryVecOpenaiInHarnessShared),
	memoryVecHarrierInHarnessShareds: many(memoryVecHarrierInHarnessShared),
	memoryAnchorsInHarnessShareds: many(memoryAnchorsInHarnessShared),
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

export const memoryVecLocalInHarnessSharedRelations = relations(memoryVecLocalInHarnessShared, ({one}) => ({
	memoryCanonicalInHarnessShared: one(memoryCanonicalInHarnessShared, {
		fields: [memoryVecLocalInHarnessShared.memoryId],
		references: [memoryCanonicalInHarnessShared.id]
	}),
}));

export const memoryVecOpenaiInHarnessSharedRelations = relations(memoryVecOpenaiInHarnessShared, ({one}) => ({
	memoryCanonicalInHarnessShared: one(memoryCanonicalInHarnessShared, {
		fields: [memoryVecOpenaiInHarnessShared.memoryId],
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

export const eventAwaitNodesInHarnessSharedRelations = relations(eventAwaitNodesInHarnessShared, ({one, many}) => ({
	eventAwaitNodesInHarnessShared: one(eventAwaitNodesInHarnessShared, {
		fields: [eventAwaitNodesInHarnessShared.parentId],
		references: [eventAwaitNodesInHarnessShared.id],
		relationName: "eventAwaitNodesInHarnessShared_parentId_eventAwaitNodesInHarnessShared_id"
	}),
	eventAwaitNodesInHarnessShareds: many(eventAwaitNodesInHarnessShared, {
		relationName: "eventAwaitNodesInHarnessShared_parentId_eventAwaitNodesInHarnessShared_id"
	}),
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

export const goalProjectsInHarnessSharedRelations = relations(goalProjectsInHarnessShared, ({one}) => ({
	goalsInHarnessShared: one(goalsInHarnessShared, {
		fields: [goalProjectsInHarnessShared.goalId],
		references: [goalsInHarnessShared.id]
	}),
}));

export const goalsInHarnessSharedRelations = relations(goalsInHarnessShared, ({one, many}) => ({
	goalProjectsInHarnessShareds: many(goalProjectsInHarnessShared),
	goalsInHarnessShared: one(goalsInHarnessShared, {
		fields: [goalsInHarnessShared.parentId],
		references: [goalsInHarnessShared.id],
		relationName: "goalsInHarnessShared_parentId_goalsInHarnessShared_id"
	}),
	goalsInHarnessShareds: many(goalsInHarnessShared, {
		relationName: "goalsInHarnessShared_parentId_goalsInHarnessShared_id"
	}),
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

export const savedPromptsInHarnessSharedRelations = relations(savedPromptsInHarnessShared, ({one, many}) => ({
	savedPromptsInHarnessShared: one(savedPromptsInHarnessShared, {
		fields: [savedPromptsInHarnessShared.parentId],
		references: [savedPromptsInHarnessShared.id],
		relationName: "savedPromptsInHarnessShared_parentId_savedPromptsInHarnessShared_id"
	}),
	savedPromptsInHarnessShareds: many(savedPromptsInHarnessShared, {
		relationName: "savedPromptsInHarnessShared_parentId_savedPromptsInHarnessShared_id"
	}),
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

export const cupKeeperRunsInHarnessSharedRelations = relations(cupKeeperRunsInHarnessShared, ({one, many}) => ({
	cupKeeperInstancesInHarnessShared: one(cupKeeperInstancesInHarnessShared, {
		fields: [cupKeeperRunsInHarnessShared.instanceId],
		references: [cupKeeperInstancesInHarnessShared.instanceId]
	}),
	cupKeeperScoresInHarnessShareds: many(cupKeeperScoresInHarnessShared),
}));

export const cupKeeperInstancesInHarnessSharedRelations = relations(cupKeeperInstancesInHarnessShared, ({many}) => ({
	cupKeeperRunsInHarnessShareds: many(cupKeeperRunsInHarnessShared),
}));

export const memoryRecallQueryTextInHarnessSharedRelations = relations(memoryRecallQueryTextInHarnessShared, ({one}) => ({
	memoryRecallStatsInHarnessShared: one(memoryRecallStatsInHarnessShared, {
		fields: [memoryRecallQueryTextInHarnessShared.statsId],
		references: [memoryRecallStatsInHarnessShared.id]
	}),
}));

export const memoryRecallStatsInHarnessSharedRelations = relations(memoryRecallStatsInHarnessShared, ({many}) => ({
	memoryRecallQueryTextInHarnessShareds: many(memoryRecallQueryTextInHarnessShared),
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

export const sessionTurnChunksInHarnessSharedRelations = relations(sessionTurnChunksInHarnessShared, ({one}) => ({
	sessionTurnsInHarnessShared: one(sessionTurnsInHarnessShared, {
		fields: [sessionTurnChunksInHarnessShared.workspaceId],
		references: [sessionTurnsInHarnessShared.workspaceId]
	}),
}));

export const sessionTurnsInHarnessSharedRelations = relations(sessionTurnsInHarnessShared, ({many}) => ({
	sessionTurnChunksInHarnessShareds: many(sessionTurnChunksInHarnessShared),
}));

export const planDecisionsInHarnessSharedRelations = relations(planDecisionsInHarnessShared, ({one}) => ({
	harnessPlansInHarnessShared: one(harnessPlansInHarnessShared, {
		fields: [planDecisionsInHarnessShared.workspaceId],
		references: [harnessPlansInHarnessShared.workspaceId]
	}),
}));

export const harnessPlansInHarnessSharedRelations = relations(harnessPlansInHarnessShared, ({many}) => ({
	planDecisionsInHarnessShareds: many(planDecisionsInHarnessShared),
	planItemsInHarnessShareds: many(planItemsInHarnessShared),
}));

export const planItemsInHarnessSharedRelations = relations(planItemsInHarnessShared, ({one}) => ({
	harnessPlansInHarnessShared: one(harnessPlansInHarnessShared, {
		fields: [planItemsInHarnessShared.workspaceId],
		references: [harnessPlansInHarnessShared.workspaceId]
	}),
}));

export const potEvalScoresInHarnessSharedRelations = relations(potEvalScoresInHarnessShared, ({one}) => ({
	potEvalRunsInHarnessShared: one(potEvalRunsInHarnessShared, {
		fields: [potEvalScoresInHarnessShared.runId],
		references: [potEvalRunsInHarnessShared.runId]
	}),
}));

export const cupKeeperScoresInHarnessSharedRelations = relations(cupKeeperScoresInHarnessShared, ({one}) => ({
	cupKeeperRunsInHarnessShared: one(cupKeeperRunsInHarnessShared, {
		fields: [cupKeeperScoresInHarnessShared.runId],
		references: [cupKeeperRunsInHarnessShared.runId]
	}),
}));

export const benchRunTasksInHarnessSharedRelations = relations(benchRunTasksInHarnessShared, ({one}) => ({
	benchRunsInHarnessShared: one(benchRunsInHarnessShared, {
		fields: [benchRunTasksInHarnessShared.runId],
		references: [benchRunsInHarnessShared.id]
	}),
}));

export const potMembersInHarnessSharedRelations = relations(potMembersInHarnessShared, ({one}) => ({
	potsInHarnessShared: one(potsInHarnessShared, {
		fields: [potMembersInHarnessShared.workspaceId],
		references: [potsInHarnessShared.workspaceId]
	}),
}));

export const potsInHarnessSharedRelations = relations(potsInHarnessShared, ({many}) => ({
	potMembersInHarnessShareds: many(potMembersInHarnessShared),
}));