import { relations } from "drizzle-orm/relations";
import { routineGroupsInHarnessShared, routinesInHarnessShared, usersInHarnessShared, userSessionsInHarnessShared, llmTestRunsInHarnessShared, llmTestFindingsInHarnessShared, llmTestFixturesInHarnessShared, memoryCanonicalInHarnessShared, memoryVecGemmaInHarnessShared, projectsInHarnessShared, projectSpecRevisionsInHarnessShared, messagesInPapercuspShared, messageCommentsInPapercuspShared, backupSnapshotsInHarnessShared, backupEventsInHarnessShared, memoryVecLocalInHarnessShared, memoryVecOpenaiInHarnessShared, planRunsInHarnessShared, planRunTurnsInHarnessShared, eventAwaitNodesInHarnessShared, operatorConversationsInHarnessShared, operatorTurnsInHarnessShared, goalsInHarnessShared, goalPotsInHarnessShared, benchmarkRolloutInHarnessShared, benchmarkRunResultInHarnessShared, savedPromptsInHarnessShared, potEvalInstancesInHarnessShared, potEvalRunsInHarnessShared, memoryVecHarrierInHarnessShared, testingSurfacesInHarnessShared, coverageEvidenceInHarnessShared, testRunsInHarnessShared, coverageWaiversInHarnessShared, benchRunsInHarnessShared, benchRunEventsInHarnessShared, cupKeeperInstancesInHarnessShared, cupKeeperRunsInHarnessShared, memoryRecallStatsInHarnessShared, memoryRecallQueryTextInHarnessShared, workItemSpecRevisionEdgesInHarnessShared, specEvidenceBindingsInHarnessShared, messageRecipientsInPapercuspShared, mobileDevicesInHarnessShared, mobilePushTokensInHarnessShared, userPreferencesInHarnessShared, personalVaultSettingsInHarnessShared, memoryAnchorsInHarnessShared, personalSyncStateInHarnessShared, personalIdentitiesInHarnessShared, harnessPlansInHarnessShared, planSpecClausesInHarnessShared, planSpecClauseRevisionsInHarnessShared, workItemsInHarnessShared, sessionTurnsInHarnessShared, sessionTurnChunksInHarnessShared, planDecisionsInHarnessShared, personalIdentityAliasesInHarnessShared, personalGrantsInHarnessShared, planItemsInHarnessShared, triggerSourcesInHarnessShared, triggerBindingsInHarnessShared, triggerRunsInHarnessShared, triggerDeliveriesInHarnessShared, potEvalScoresInHarnessShared, datatypeRegistryInHarnessShared, cupKeeperScoresInHarnessShared, benchRunTasksInHarnessShared, personalDocumentsInHarnessShared, potsInHarnessShared, potMembersInHarnessShared } from "./generated";

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
	personalVaultSettingsInHarnessShareds: many(personalVaultSettingsInHarnessShared),
	personalSyncStateInHarnessShareds: many(personalSyncStateInHarnessShared),
	personalIdentitiesInHarnessShareds: many(personalIdentitiesInHarnessShared),
	personalGrantsInHarnessShareds: many(personalGrantsInHarnessShared),
	personalDocumentsInHarnessShareds: many(personalDocumentsInHarnessShared),
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

export const goalPotsInHarnessSharedRelations = relations(goalPotsInHarnessShared, ({one}) => ({
	goalsInHarnessShared: one(goalsInHarnessShared, {
		fields: [goalPotsInHarnessShared.goalId],
		references: [goalsInHarnessShared.id]
	}),
}));

export const goalsInHarnessSharedRelations = relations(goalsInHarnessShared, ({one, many}) => ({
	goalPotsInHarnessShareds: many(goalPotsInHarnessShared),
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

export const coverageEvidenceInHarnessSharedRelations = relations(coverageEvidenceInHarnessShared, ({one}) => ({
	testingSurfacesInHarnessShared: one(testingSurfacesInHarnessShared, {
		fields: [coverageEvidenceInHarnessShared.surfaceRef],
		references: [testingSurfacesInHarnessShared.id]
	}),
	testRunsInHarnessShared: one(testRunsInHarnessShared, {
		fields: [coverageEvidenceInHarnessShared.testRunId],
		references: [testRunsInHarnessShared.id]
	}),
}));

export const testingSurfacesInHarnessSharedRelations = relations(testingSurfacesInHarnessShared, ({many}) => ({
	coverageEvidenceInHarnessShareds: many(coverageEvidenceInHarnessShared),
	coverageWaiversInHarnessShareds: many(coverageWaiversInHarnessShared),
}));

export const testRunsInHarnessSharedRelations = relations(testRunsInHarnessShared, ({many}) => ({
	coverageEvidenceInHarnessShareds: many(coverageEvidenceInHarnessShared),
}));

export const coverageWaiversInHarnessSharedRelations = relations(coverageWaiversInHarnessShared, ({one}) => ({
	testingSurfacesInHarnessShared: one(testingSurfacesInHarnessShared, {
		fields: [coverageWaiversInHarnessShared.surfaceRef],
		references: [testingSurfacesInHarnessShared.id]
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

export const specEvidenceBindingsInHarnessSharedRelations = relations(specEvidenceBindingsInHarnessShared, ({one}) => ({
	workItemSpecRevisionEdgesInHarnessShared: one(workItemSpecRevisionEdgesInHarnessShared, {
		fields: [specEvidenceBindingsInHarnessShared.workspaceId],
		references: [workItemSpecRevisionEdgesInHarnessShared.workspaceId]
	}),
}));

export const workItemSpecRevisionEdgesInHarnessSharedRelations = relations(workItemSpecRevisionEdgesInHarnessShared, ({one, many}) => ({
	specEvidenceBindingsInHarnessShareds: many(specEvidenceBindingsInHarnessShared),
	workItemsInHarnessShared: one(workItemsInHarnessShared, {
		fields: [workItemSpecRevisionEdgesInHarnessShared.workspaceId],
		references: [workItemsInHarnessShared.harnessSlug]
	}),
	planSpecClauseRevisionsInHarnessShared: one(planSpecClauseRevisionsInHarnessShared, {
		fields: [workItemSpecRevisionEdgesInHarnessShared.workspaceId],
		references: [planSpecClauseRevisionsInHarnessShared.workspaceId]
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

export const personalVaultSettingsInHarnessSharedRelations = relations(personalVaultSettingsInHarnessShared, ({one}) => ({
	usersInHarnessShared: one(usersInHarnessShared, {
		fields: [personalVaultSettingsInHarnessShared.userId],
		references: [usersInHarnessShared.id]
	}),
}));

export const memoryAnchorsInHarnessSharedRelations = relations(memoryAnchorsInHarnessShared, ({one}) => ({
	memoryCanonicalInHarnessShared: one(memoryCanonicalInHarnessShared, {
		fields: [memoryAnchorsInHarnessShared.memoryId],
		references: [memoryCanonicalInHarnessShared.id]
	}),
}));

export const personalSyncStateInHarnessSharedRelations = relations(personalSyncStateInHarnessShared, ({one}) => ({
	usersInHarnessShared: one(usersInHarnessShared, {
		fields: [personalSyncStateInHarnessShared.userId],
		references: [usersInHarnessShared.id]
	}),
}));

export const personalIdentitiesInHarnessSharedRelations = relations(personalIdentitiesInHarnessShared, ({one, many}) => ({
	usersInHarnessShared: one(usersInHarnessShared, {
		fields: [personalIdentitiesInHarnessShared.userId],
		references: [usersInHarnessShared.id]
	}),
	personalIdentityAliasesInHarnessShareds: many(personalIdentityAliasesInHarnessShared),
}));

export const planSpecClausesInHarnessSharedRelations = relations(planSpecClausesInHarnessShared, ({one, many}) => ({
	harnessPlansInHarnessShared: one(harnessPlansInHarnessShared, {
		fields: [planSpecClausesInHarnessShared.workspaceId],
		references: [harnessPlansInHarnessShared.workspaceId]
	}),
	planSpecClauseRevisionsInHarnessShared: one(planSpecClauseRevisionsInHarnessShared, {
		fields: [planSpecClausesInHarnessShared.workspaceId],
		references: [planSpecClauseRevisionsInHarnessShared.workspaceId],
		relationName: "planSpecClausesInHarnessShared_workspaceId_planSpecClauseRevisionsInHarnessShared_workspaceId"
	}),
	planSpecClauseRevisionsInHarnessShareds: many(planSpecClauseRevisionsInHarnessShared, {
		relationName: "planSpecClauseRevisionsInHarnessShared_workspaceId_planSpecClausesInHarnessShared_workspaceId"
	}),
}));

export const harnessPlansInHarnessSharedRelations = relations(harnessPlansInHarnessShared, ({many}) => ({
	planSpecClausesInHarnessShareds: many(planSpecClausesInHarnessShared),
	planDecisionsInHarnessShareds: many(planDecisionsInHarnessShared),
	planItemsInHarnessShareds: many(planItemsInHarnessShared),
	triggerBindingsInHarnessShareds: many(triggerBindingsInHarnessShared),
}));

export const planSpecClauseRevisionsInHarnessSharedRelations = relations(planSpecClauseRevisionsInHarnessShared, ({one, many}) => ({
	planSpecClausesInHarnessShareds: many(planSpecClausesInHarnessShared, {
		relationName: "planSpecClausesInHarnessShared_workspaceId_planSpecClauseRevisionsInHarnessShared_workspaceId"
	}),
	workItemSpecRevisionEdgesInHarnessShareds: many(workItemSpecRevisionEdgesInHarnessShared),
	planSpecClausesInHarnessShared: one(planSpecClausesInHarnessShared, {
		fields: [planSpecClauseRevisionsInHarnessShared.workspaceId],
		references: [planSpecClausesInHarnessShared.workspaceId],
		relationName: "planSpecClauseRevisionsInHarnessShared_workspaceId_planSpecClausesInHarnessShared_workspaceId"
	}),
	planSpecClauseRevisionsInHarnessShared: one(planSpecClauseRevisionsInHarnessShared, {
		fields: [planSpecClauseRevisionsInHarnessShared.workspaceId],
		references: [planSpecClauseRevisionsInHarnessShared.workspaceId],
		relationName: "planSpecClauseRevisionsInHarnessShared_workspaceId_planSpecClauseRevisionsInHarnessShared_workspaceId"
	}),
	planSpecClauseRevisionsInHarnessShareds: many(planSpecClauseRevisionsInHarnessShared, {
		relationName: "planSpecClauseRevisionsInHarnessShared_workspaceId_planSpecClauseRevisionsInHarnessShared_workspaceId"
	}),
}));

export const workItemsInHarnessSharedRelations = relations(workItemsInHarnessShared, ({many}) => ({
	workItemSpecRevisionEdgesInHarnessShareds: many(workItemSpecRevisionEdgesInHarnessShared),
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

export const personalIdentityAliasesInHarnessSharedRelations = relations(personalIdentityAliasesInHarnessShared, ({one}) => ({
	personalIdentitiesInHarnessShared: one(personalIdentitiesInHarnessShared, {
		fields: [personalIdentityAliasesInHarnessShared.workspaceId],
		references: [personalIdentitiesInHarnessShared.id]
	}),
}));

export const personalGrantsInHarnessSharedRelations = relations(personalGrantsInHarnessShared, ({one}) => ({
	usersInHarnessShared: one(usersInHarnessShared, {
		fields: [personalGrantsInHarnessShared.userId],
		references: [usersInHarnessShared.id]
	}),
}));

export const planItemsInHarnessSharedRelations = relations(planItemsInHarnessShared, ({one}) => ({
	harnessPlansInHarnessShared: one(harnessPlansInHarnessShared, {
		fields: [planItemsInHarnessShared.workspaceId],
		references: [harnessPlansInHarnessShared.workspaceId]
	}),
}));

export const triggerBindingsInHarnessSharedRelations = relations(triggerBindingsInHarnessShared, ({one, many}) => ({
	triggerSourcesInHarnessShared: one(triggerSourcesInHarnessShared, {
		fields: [triggerBindingsInHarnessShared.workspaceId],
		references: [triggerSourcesInHarnessShared.workspaceId]
	}),
	harnessPlansInHarnessShared: one(harnessPlansInHarnessShared, {
		fields: [triggerBindingsInHarnessShared.workspaceId],
		references: [harnessPlansInHarnessShared.workspaceId]
	}),
	triggerRunsInHarnessShareds: many(triggerRunsInHarnessShared),
}));

export const triggerSourcesInHarnessSharedRelations = relations(triggerSourcesInHarnessShared, ({many}) => ({
	triggerBindingsInHarnessShareds: many(triggerBindingsInHarnessShared),
	triggerDeliveriesInHarnessShareds: many(triggerDeliveriesInHarnessShared),
}));

export const triggerRunsInHarnessSharedRelations = relations(triggerRunsInHarnessShared, ({one}) => ({
	triggerBindingsInHarnessShared: one(triggerBindingsInHarnessShared, {
		fields: [triggerRunsInHarnessShared.workspaceId],
		references: [triggerBindingsInHarnessShared.workspaceId]
	}),
	triggerDeliveriesInHarnessShared: one(triggerDeliveriesInHarnessShared, {
		fields: [triggerRunsInHarnessShared.workspaceId],
		references: [triggerDeliveriesInHarnessShared.workspaceId]
	}),
}));

export const triggerDeliveriesInHarnessSharedRelations = relations(triggerDeliveriesInHarnessShared, ({one, many}) => ({
	triggerRunsInHarnessShareds: many(triggerRunsInHarnessShared),
	triggerSourcesInHarnessShared: one(triggerSourcesInHarnessShared, {
		fields: [triggerDeliveriesInHarnessShared.workspaceId],
		references: [triggerSourcesInHarnessShared.workspaceId]
	}),
	datatypeRegistryInHarnessShared: one(datatypeRegistryInHarnessShared, {
		fields: [triggerDeliveriesInHarnessShared.workspaceId],
		references: [datatypeRegistryInHarnessShared.id]
	}),
}));

export const potEvalScoresInHarnessSharedRelations = relations(potEvalScoresInHarnessShared, ({one}) => ({
	potEvalRunsInHarnessShared: one(potEvalRunsInHarnessShared, {
		fields: [potEvalScoresInHarnessShared.runId],
		references: [potEvalRunsInHarnessShared.runId]
	}),
}));

export const datatypeRegistryInHarnessSharedRelations = relations(datatypeRegistryInHarnessShared, ({many}) => ({
	triggerDeliveriesInHarnessShareds: many(triggerDeliveriesInHarnessShared),
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

export const personalDocumentsInHarnessSharedRelations = relations(personalDocumentsInHarnessShared, ({one}) => ({
	usersInHarnessShared: one(usersInHarnessShared, {
		fields: [personalDocumentsInHarnessShared.userId],
		references: [usersInHarnessShared.id]
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