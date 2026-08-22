import { relations } from "drizzle-orm/relations";
import { routineGroupsInHarnessShared, routinesInHarnessShared, llmTestRunsInHarnessShared, llmTestFindingsInHarnessShared, llmTestFixturesInHarnessShared, memoryCanonicalInHarnessShared, memoryVecGemmaInHarnessShared, projectsInHarnessShared, projectSpecRevisionsInHarnessShared, messagesInPapercuspShared, messageCommentsInPapercuspShared, backupSnapshotsInHarnessShared, backupEventsInHarnessShared, memoryVecLocalInHarnessShared, memoryVecOpenaiInHarnessShared, planRunsInHarnessShared, planRunTurnsInHarnessShared, eventAwaitNodesInHarnessShared, operatorConversationsInHarnessShared, operatorTurnsInHarnessShared, goalsInHarnessShared, goalPotsInHarnessShared, usersInHarnessShared, userSessionsInHarnessShared, benchmarkRolloutInHarnessShared, benchmarkRunResultInHarnessShared, savedPromptsInHarnessShared, potEvalInstancesInHarnessShared, potEvalRunsInHarnessShared, memoryVecHarrierInHarnessShared, testingSurfacesInHarnessShared, coverageEvidenceInHarnessShared, testRunsInHarnessShared, coverageWaiversInHarnessShared, benchRunsInHarnessShared, benchRunEventsInHarnessShared, cupKeeperInstancesInHarnessShared, cupKeeperRunsInHarnessShared, memoryRecallStatsInHarnessShared, memoryRecallQueryTextInHarnessShared, workItemSpecRevisionEdgesInHarnessShared, specEvidenceBindingsInHarnessShared, messageRecipientsInPapercuspShared, mobileDevicesInHarnessShared, mobilePushTokensInHarnessShared, userPreferencesInHarnessShared, personalVaultSettingsInHarnessShared, memoryAnchorsInHarnessShared, personalSyncStateInHarnessShared, personalIdentitiesInHarnessShared, harnessPlansInHarnessShared, planSpecClausesInHarnessShared, planSpecClauseRevisionsInHarnessShared, workItemsInHarnessShared, sessionTurnsInHarnessShared, sessionTurnChunksInHarnessShared, planDecisionsInHarnessShared, personalIdentityAliasesInHarnessShared, workspaceHostsInHarnessShared, workspaceHostLogsInHarnessShared, workspaceHostOperationsInHarnessShared, personalGrantsInHarnessShared, workspaceHostEventsInHarnessShared, planItemsInHarnessShared, triggerSourcesInHarnessShared, triggerBindingsInHarnessShared, potEvalScoresInHarnessShared, triggerRunsInHarnessShared, triggerDeliveriesInHarnessShared, datatypeRegistryInHarnessShared, cupKeeperScoresInHarnessShared, benchRunTasksInHarnessShared, workspaceHostResourcesInHarnessShared, personalDocumentsInHarnessShared, triageSnapshotsInHarnessShared, triageLedgerInHarnessShared, potsInHarnessShared, potMembersInHarnessShared, workspaceHostConnectionsInHarnessShared } from "./generated";

export const routinesInHarnessSharedRelations = relations(routinesInHarnessShared, ({one}) => ({
	routineGroupsInHarnessShared: one(routineGroupsInHarnessShared, {
		fields: [routinesInHarnessShared.workspaceId, routinesInHarnessShared.groupSlug],
		references: [routineGroupsInHarnessShared.workspaceId, routineGroupsInHarnessShared.slug]
	}),
}));

export const routineGroupsInHarnessSharedRelations = relations(routineGroupsInHarnessShared, ({many}) => ({
	routinesInHarnessShareds: many(routinesInHarnessShared),
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
	triggerSourcesInHarnessShareds: many(triggerSourcesInHarnessShared),
	personalDocumentsInHarnessShareds: many(personalDocumentsInHarnessShared),
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
		fields: [specEvidenceBindingsInHarnessShared.workspaceId, specEvidenceBindingsInHarnessShared.harnessSlug, specEvidenceBindingsInHarnessShared.workItemId, specEvidenceBindingsInHarnessShared.planSlug, specEvidenceBindingsInHarnessShared.specId, specEvidenceBindingsInHarnessShared.specRevision, specEvidenceBindingsInHarnessShared.specFingerprint],
		references: [workItemSpecRevisionEdgesInHarnessShared.workspaceId, workItemSpecRevisionEdgesInHarnessShared.harnessSlug, workItemSpecRevisionEdgesInHarnessShared.workItemId, workItemSpecRevisionEdgesInHarnessShared.planSlug, workItemSpecRevisionEdgesInHarnessShared.specId, workItemSpecRevisionEdgesInHarnessShared.specRevision, workItemSpecRevisionEdgesInHarnessShared.specFingerprint]
	}),
}));

export const workItemSpecRevisionEdgesInHarnessSharedRelations = relations(workItemSpecRevisionEdgesInHarnessShared, ({one, many}) => ({
	specEvidenceBindingsInHarnessShareds: many(specEvidenceBindingsInHarnessShared),
	workItemsInHarnessShared: one(workItemsInHarnessShared, {
		fields: [workItemSpecRevisionEdgesInHarnessShared.workspaceId, workItemSpecRevisionEdgesInHarnessShared.harnessSlug, workItemSpecRevisionEdgesInHarnessShared.workItemId],
		references: [workItemsInHarnessShared.workspaceId, workItemsInHarnessShared.harnessSlug, workItemsInHarnessShared.featureId]
	}),
	planSpecClauseRevisionsInHarnessShared: one(planSpecClauseRevisionsInHarnessShared, {
		fields: [workItemSpecRevisionEdgesInHarnessShared.workspaceId, workItemSpecRevisionEdgesInHarnessShared.harnessSlug, workItemSpecRevisionEdgesInHarnessShared.planSlug, workItemSpecRevisionEdgesInHarnessShared.specId, workItemSpecRevisionEdgesInHarnessShared.specRevision, workItemSpecRevisionEdgesInHarnessShared.specFingerprint],
		references: [planSpecClauseRevisionsInHarnessShared.workspaceId, planSpecClauseRevisionsInHarnessShared.harnessSlug, planSpecClauseRevisionsInHarnessShared.planSlug, planSpecClauseRevisionsInHarnessShared.specId, planSpecClauseRevisionsInHarnessShared.revision, planSpecClauseRevisionsInHarnessShared.contentHash]
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
		fields: [planSpecClausesInHarnessShared.workspaceId, planSpecClausesInHarnessShared.harnessSlug, planSpecClausesInHarnessShared.planSlug],
		references: [harnessPlansInHarnessShared.workspaceId, harnessPlansInHarnessShared.harnessSlug, harnessPlansInHarnessShared.planSlug]
	}),
	planSpecClauseRevisionsInHarnessShared: one(planSpecClauseRevisionsInHarnessShared, {
		fields: [planSpecClausesInHarnessShared.workspaceId, planSpecClausesInHarnessShared.harnessSlug, planSpecClausesInHarnessShared.planSlug, planSpecClausesInHarnessShared.specId, planSpecClausesInHarnessShared.currentRevision],
		references: [planSpecClauseRevisionsInHarnessShared.workspaceId, planSpecClauseRevisionsInHarnessShared.harnessSlug, planSpecClauseRevisionsInHarnessShared.planSlug, planSpecClauseRevisionsInHarnessShared.specId, planSpecClauseRevisionsInHarnessShared.revision],
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
		fields: [planSpecClauseRevisionsInHarnessShared.workspaceId, planSpecClauseRevisionsInHarnessShared.harnessSlug, planSpecClauseRevisionsInHarnessShared.planSlug, planSpecClauseRevisionsInHarnessShared.specId],
		references: [planSpecClausesInHarnessShared.workspaceId, planSpecClausesInHarnessShared.harnessSlug, planSpecClausesInHarnessShared.planSlug, planSpecClausesInHarnessShared.specId],
		relationName: "planSpecClauseRevisionsInHarnessShared_workspaceId_planSpecClausesInHarnessShared_workspaceId"
	}),
	planSpecClauseRevisionsInHarnessShared: one(planSpecClauseRevisionsInHarnessShared, {
		fields: [planSpecClauseRevisionsInHarnessShared.workspaceId, planSpecClauseRevisionsInHarnessShared.harnessSlug, planSpecClauseRevisionsInHarnessShared.planSlug, planSpecClauseRevisionsInHarnessShared.supersedesSpecId, planSpecClauseRevisionsInHarnessShared.supersedesRevision],
		references: [planSpecClauseRevisionsInHarnessShared.workspaceId, planSpecClauseRevisionsInHarnessShared.harnessSlug, planSpecClauseRevisionsInHarnessShared.planSlug, planSpecClauseRevisionsInHarnessShared.specId, planSpecClauseRevisionsInHarnessShared.revision],
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
		fields: [sessionTurnChunksInHarnessShared.workspaceId, sessionTurnChunksInHarnessShared.sourceKind, sessionTurnChunksInHarnessShared.sessionId, sessionTurnChunksInHarnessShared.turnIdx],
		references: [sessionTurnsInHarnessShared.workspaceId, sessionTurnsInHarnessShared.sourceKind, sessionTurnsInHarnessShared.sessionId, sessionTurnsInHarnessShared.turnIdx]
	}),
}));

export const sessionTurnsInHarnessSharedRelations = relations(sessionTurnsInHarnessShared, ({many}) => ({
	sessionTurnChunksInHarnessShareds: many(sessionTurnChunksInHarnessShared),
}));

export const planDecisionsInHarnessSharedRelations = relations(planDecisionsInHarnessShared, ({one}) => ({
	harnessPlansInHarnessShared: one(harnessPlansInHarnessShared, {
		fields: [planDecisionsInHarnessShared.workspaceId, planDecisionsInHarnessShared.harnessSlug, planDecisionsInHarnessShared.planSlug],
		references: [harnessPlansInHarnessShared.workspaceId, harnessPlansInHarnessShared.harnessSlug, harnessPlansInHarnessShared.planSlug]
	}),
}));

export const personalIdentityAliasesInHarnessSharedRelations = relations(personalIdentityAliasesInHarnessShared, ({one}) => ({
	personalIdentitiesInHarnessShared: one(personalIdentitiesInHarnessShared, {
		fields: [personalIdentityAliasesInHarnessShared.workspaceId, personalIdentityAliasesInHarnessShared.userId, personalIdentityAliasesInHarnessShared.identityId],
		references: [personalIdentitiesInHarnessShared.workspaceId, personalIdentitiesInHarnessShared.userId, personalIdentitiesInHarnessShared.id]
	}),
}));

export const workspaceHostLogsInHarnessSharedRelations = relations(workspaceHostLogsInHarnessShared, ({one}) => ({
	workspaceHostsInHarnessShared: one(workspaceHostsInHarnessShared, {
		fields: [workspaceHostLogsInHarnessShared.workspaceId, workspaceHostLogsInHarnessShared.hostId],
		references: [workspaceHostsInHarnessShared.workspaceId, workspaceHostsInHarnessShared.id]
	}),
	workspaceHostOperationsInHarnessShared: one(workspaceHostOperationsInHarnessShared, {
		fields: [workspaceHostLogsInHarnessShared.workspaceId, workspaceHostLogsInHarnessShared.operationId],
		references: [workspaceHostOperationsInHarnessShared.workspaceId, workspaceHostOperationsInHarnessShared.id]
	}),
}));

export const workspaceHostsInHarnessSharedRelations = relations(workspaceHostsInHarnessShared, ({one, many}) => ({
	workspaceHostLogsInHarnessShareds: many(workspaceHostLogsInHarnessShared),
	workspaceHostEventsInHarnessShareds: many(workspaceHostEventsInHarnessShared),
	workspaceHostOperationsInHarnessShareds: many(workspaceHostOperationsInHarnessShared),
	workspaceHostResourcesInHarnessShareds: many(workspaceHostResourcesInHarnessShared),
	workspaceHostConnectionsInHarnessShared: one(workspaceHostConnectionsInHarnessShared, {
		fields: [workspaceHostsInHarnessShared.workspaceId, workspaceHostsInHarnessShared.connectionId],
		references: [workspaceHostConnectionsInHarnessShared.workspaceId, workspaceHostConnectionsInHarnessShared.id]
	}),
}));

export const workspaceHostOperationsInHarnessSharedRelations = relations(workspaceHostOperationsInHarnessShared, ({one, many}) => ({
	workspaceHostLogsInHarnessShareds: many(workspaceHostLogsInHarnessShared),
	workspaceHostEventsInHarnessShareds: many(workspaceHostEventsInHarnessShared),
	workspaceHostsInHarnessShared: one(workspaceHostsInHarnessShared, {
		fields: [workspaceHostOperationsInHarnessShared.workspaceId, workspaceHostOperationsInHarnessShared.hostId],
		references: [workspaceHostsInHarnessShared.workspaceId, workspaceHostsInHarnessShared.id]
	}),
	workspaceHostResourcesInHarnessShareds: many(workspaceHostResourcesInHarnessShared),
}));

export const personalGrantsInHarnessSharedRelations = relations(personalGrantsInHarnessShared, ({one}) => ({
	usersInHarnessShared: one(usersInHarnessShared, {
		fields: [personalGrantsInHarnessShared.userId],
		references: [usersInHarnessShared.id]
	}),
}));

export const workspaceHostEventsInHarnessSharedRelations = relations(workspaceHostEventsInHarnessShared, ({one}) => ({
	workspaceHostsInHarnessShared: one(workspaceHostsInHarnessShared, {
		fields: [workspaceHostEventsInHarnessShared.workspaceId, workspaceHostEventsInHarnessShared.hostId],
		references: [workspaceHostsInHarnessShared.workspaceId, workspaceHostsInHarnessShared.id]
	}),
	workspaceHostOperationsInHarnessShared: one(workspaceHostOperationsInHarnessShared, {
		fields: [workspaceHostEventsInHarnessShared.workspaceId, workspaceHostEventsInHarnessShared.operationId],
		references: [workspaceHostOperationsInHarnessShared.workspaceId, workspaceHostOperationsInHarnessShared.id]
	}),
}));

export const planItemsInHarnessSharedRelations = relations(planItemsInHarnessShared, ({one}) => ({
	harnessPlansInHarnessShared: one(harnessPlansInHarnessShared, {
		fields: [planItemsInHarnessShared.workspaceId, planItemsInHarnessShared.harnessSlug, planItemsInHarnessShared.planSlug],
		references: [harnessPlansInHarnessShared.workspaceId, harnessPlansInHarnessShared.harnessSlug, harnessPlansInHarnessShared.planSlug]
	}),
}));

export const triggerBindingsInHarnessSharedRelations = relations(triggerBindingsInHarnessShared, ({one, many}) => ({
	triggerSourcesInHarnessShared: one(triggerSourcesInHarnessShared, {
		fields: [triggerBindingsInHarnessShared.workspaceId, triggerBindingsInHarnessShared.sourceId],
		references: [triggerSourcesInHarnessShared.workspaceId, triggerSourcesInHarnessShared.id]
	}),
	harnessPlansInHarnessShared: one(harnessPlansInHarnessShared, {
		fields: [triggerBindingsInHarnessShared.workspaceId, triggerBindingsInHarnessShared.planHarnessSlug, triggerBindingsInHarnessShared.planSlug],
		references: [harnessPlansInHarnessShared.workspaceId, harnessPlansInHarnessShared.harnessSlug, harnessPlansInHarnessShared.planSlug]
	}),
	triggerRunsInHarnessShareds: many(triggerRunsInHarnessShared),
}));

export const triggerSourcesInHarnessSharedRelations = relations(triggerSourcesInHarnessShared, ({one, many}) => ({
	triggerBindingsInHarnessShareds: many(triggerBindingsInHarnessShared),
	usersInHarnessShared: one(usersInHarnessShared, {
		fields: [triggerSourcesInHarnessShared.ownerUserId],
		references: [usersInHarnessShared.id]
	}),
	triggerDeliveriesInHarnessShareds: many(triggerDeliveriesInHarnessShared),
}));

export const potEvalScoresInHarnessSharedRelations = relations(potEvalScoresInHarnessShared, ({one}) => ({
	potEvalRunsInHarnessShared: one(potEvalRunsInHarnessShared, {
		fields: [potEvalScoresInHarnessShared.runId],
		references: [potEvalRunsInHarnessShared.runId]
	}),
}));

export const triggerRunsInHarnessSharedRelations = relations(triggerRunsInHarnessShared, ({one}) => ({
	triggerBindingsInHarnessShared: one(triggerBindingsInHarnessShared, {
		fields: [triggerRunsInHarnessShared.workspaceId, triggerRunsInHarnessShared.bindingId],
		references: [triggerBindingsInHarnessShared.workspaceId, triggerBindingsInHarnessShared.id]
	}),
	triggerDeliveriesInHarnessShared: one(triggerDeliveriesInHarnessShared, {
		fields: [triggerRunsInHarnessShared.workspaceId, triggerRunsInHarnessShared.deliveryId],
		references: [triggerDeliveriesInHarnessShared.workspaceId, triggerDeliveriesInHarnessShared.id]
	}),
}));

export const triggerDeliveriesInHarnessSharedRelations = relations(triggerDeliveriesInHarnessShared, ({one, many}) => ({
	triggerRunsInHarnessShareds: many(triggerRunsInHarnessShared),
	triggerSourcesInHarnessShared: one(triggerSourcesInHarnessShared, {
		fields: [triggerDeliveriesInHarnessShared.workspaceId, triggerDeliveriesInHarnessShared.sourceId],
		references: [triggerSourcesInHarnessShared.workspaceId, triggerSourcesInHarnessShared.id]
	}),
	datatypeRegistryInHarnessShared: one(datatypeRegistryInHarnessShared, {
		fields: [triggerDeliveriesInHarnessShared.workspaceId, triggerDeliveriesInHarnessShared.datatypeId],
		references: [datatypeRegistryInHarnessShared.workspaceId, datatypeRegistryInHarnessShared.id]
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

export const workspaceHostResourcesInHarnessSharedRelations = relations(workspaceHostResourcesInHarnessShared, ({one}) => ({
	workspaceHostsInHarnessShared: one(workspaceHostsInHarnessShared, {
		fields: [workspaceHostResourcesInHarnessShared.workspaceId, workspaceHostResourcesInHarnessShared.hostId],
		references: [workspaceHostsInHarnessShared.workspaceId, workspaceHostsInHarnessShared.id]
	}),
	workspaceHostOperationsInHarnessShared: one(workspaceHostOperationsInHarnessShared, {
		fields: [workspaceHostResourcesInHarnessShared.workspaceId, workspaceHostResourcesInHarnessShared.operationId],
		references: [workspaceHostOperationsInHarnessShared.workspaceId, workspaceHostOperationsInHarnessShared.id]
	}),
}));

export const personalDocumentsInHarnessSharedRelations = relations(personalDocumentsInHarnessShared, ({one}) => ({
	usersInHarnessShared: one(usersInHarnessShared, {
		fields: [personalDocumentsInHarnessShared.userId],
		references: [usersInHarnessShared.id]
	}),
}));

export const triageLedgerInHarnessSharedRelations = relations(triageLedgerInHarnessShared, ({one}) => ({
	triageSnapshotsInHarnessShared: one(triageSnapshotsInHarnessShared, {
		fields: [triageLedgerInHarnessShared.snapshotId],
		references: [triageSnapshotsInHarnessShared.snapshotId]
	}),
}));

export const triageSnapshotsInHarnessSharedRelations = relations(triageSnapshotsInHarnessShared, ({many}) => ({
	triageLedgerInHarnessShareds: many(triageLedgerInHarnessShared),
}));

export const potMembersInHarnessSharedRelations = relations(potMembersInHarnessShared, ({one}) => ({
	potsInHarnessShared: one(potsInHarnessShared, {
		fields: [potMembersInHarnessShared.workspaceId, potMembersInHarnessShared.potHomeSlug],
		references: [potsInHarnessShared.workspaceId, potsInHarnessShared.canonicalPotHomeSlug]
	}),
}));

export const potsInHarnessSharedRelations = relations(potsInHarnessShared, ({many}) => ({
	potMembersInHarnessShareds: many(potMembersInHarnessShared),
}));

export const workspaceHostConnectionsInHarnessSharedRelations = relations(workspaceHostConnectionsInHarnessShared, ({many}) => ({
	workspaceHostsInHarnessShareds: many(workspaceHostsInHarnessShared),
}));