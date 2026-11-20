import { relations } from "drizzle-orm/relations";
import { governancePolicyLayersInHarnessShared, routineGroupsInHarnessShared, routinesInHarnessShared, operatorConversationsInHarnessShared, operatorTurnsInHarnessShared, llmTestRunsInHarnessShared, llmTestFindingsInHarnessShared, llmTestFixturesInHarnessShared, memoryCanonicalInHarnessShared, memoryVecGemmaInHarnessShared, projectsInHarnessShared, projectSpecRevisionsInHarnessShared, messagesInPapercuspShared, messageCommentsInPapercuspShared, backupSnapshotsInHarnessShared, backupEventsInHarnessShared, memoryVecOpenaiInHarnessShared, memoryVecLocalInHarnessShared, connectedAppOauthClientsInHarnessShared, connectedAppDeviceGrantsInHarnessShared, planRunsInHarnessShared, planRunTurnsInHarnessShared, eventAwaitNodesInHarnessShared, memoryPrecisionBenchInHarnessShared, memoryPrecisionBenchAttemptsInHarnessShared, goalsInHarnessShared, goalPotsInHarnessShared, capabilityClassRegistryInHarnessShared, capabilityClassConformanceRunsInHarnessShared, connectedAppsInHarnessShared, connectedAppAccessTokensInHarnessShared, usersInHarnessShared, userSessionsInHarnessShared, daoHrPolicyVersionsInHarnessShared, daoHrPolicyAuditInHarnessShared, savedPromptsInHarnessShared, dataSourcesInHarnessShared, connectorPushSecretsInHarnessShared, potEvalInstancesInHarnessShared, potEvalRunsInHarnessShared, chatBugSuggestionsInHarnessShared, memoryVecHarrierInHarnessShared, testingSurfacesInHarnessShared, coverageEvidenceInHarnessShared, testRunsInHarnessShared, coverageWaiversInHarnessShared, benchRunsInHarnessShared, benchRunEventsInHarnessShared, cupKeeperInstancesInHarnessShared, cupKeeperRunsInHarnessShared, memoryRecallStatsInHarnessShared, memoryRecallQueryTextInHarnessShared, benchmarkRolloutInHarnessShared, benchmarkRunResultInHarnessShared, governanceDelegationsInHarnessShared, sensitiveActionRequestsInHarnessShared, daoHrContractTemplateVersionsInHarnessShared, daoHrCounselApprovalsInHarnessShared, siemExportStreamsInHarnessShared, siemExportDeliveriesInHarnessShared, specEvidenceBindingsInHarnessShared, workItemSpecRevisionEdgesInHarnessShared, planBlindReviewSessionsInHarnessShared, acceptanceAdoptionRunsInHarnessShared, messageRecipientsInPapercuspShared, mobilePushTokensInHarnessShared, connectedAppClientAssertionsInHarnessShared, userPreferencesInHarnessShared, documentPermissionListsInHarnessShared, documentPermissionMembersInHarnessShared, diskCensusRunsInHarnessShared, diskCensusConsumersInHarnessShared, daoHrOffersInHarnessShared, daoHrOfferApprovalsInHarnessShared, sensitiveActionApprovalsInHarnessShared, personalVaultSettingsInHarnessShared, blueprintPackageResourcesInHarnessShared, blueprintPackageDependentsInHarnessShared, reportLibraryInHarnessShared, reportLibrarySharesInHarnessShared, moneyJournalRollupsInHarnessShared, moneyJournalMicroAccrualsInHarnessShared, sessionTurnsInHarnessShared, sessionTurnWindowsInHarnessShared, memoryAnchorsInHarnessShared, daoHrRolesInHarnessShared, daoHrCandidatesInHarnessShared, moneyJournalEntriesInHarnessShared, moneyJournalLinesInHarnessShared, sqlIntentRunsInHarnessShared, sqlIntentFamilyRunsInHarnessShared, sessionTasksInHarnessShared, sessionTaskWorkItemLinksInHarnessShared, testCaseRunsInHarnessShared, personalSyncStateInHarnessShared, appOwnerMappingsInHarnessShared, triggerWebhookSecretsInHarnessShared, personalIdentitiesInHarnessShared, reportLibraryChunksInHarnessShared, planSpecClauseRevisionsInHarnessShared, planSpecClausesInHarnessShared, harnessPlansInHarnessShared, providerIdentityMappingsInHarnessShared, dataSourceLegalHoldsInHarnessShared, workItemsInHarnessShared, organizationKeyCustodyInHarnessShared, organizationDataKeysInHarnessShared, chatRollupQueueInHarnessShared, workspaceHostsInHarnessShared, workspaceHostLogsInHarnessShared, workspaceHostOperationsInHarnessShared, daoHrContractTemplatesInHarnessShared, personalIdentityAliasesInHarnessShared, capabilityClassProviderBindingsInHarnessShared, potCapabilityClassBindingsInHarnessShared, sessionTurnChunksInHarnessShared, planDecisionsInHarnessShared, governancePolicyLayerVersionsInHarnessShared, personalPrivacyRulesInHarnessShared, workspaceHostEventsInHarnessShared, personalGrantsInHarnessShared, personalVaultImportUploadsInHarnessShared, workspaceHostInitializationStepsInHarnessShared, docSectionsInHarnessShared, docSectionPredecessorsInHarnessShared, chatRetrievalUnitsInHarnessShared, personalDisclosuresInHarnessShared, planItemsInHarnessShared, cupboardMeteredAccountsInHarnessShared, cupboardFundedTurnsInHarnessShared, admissionRulesInHarnessShared, semanticCodeFilesInHarnessShared, semanticCodeFunctionsInHarnessShared, potEvalScoresInHarnessShared, chatMessagesInHarnessShared, triggerBindingsInHarnessShared, triggerRunsInHarnessShared, triggerDeliveriesInHarnessShared, datatypeRegistryInHarnessShared, cupKeeperScoresInHarnessShared, benchRunTasksInHarnessShared, customerWorkspacesInHarnessShared, workspaceGrantsInHarnessShared, workspaceHostResourcesInHarnessShared, triggerPackInstallationsInHarnessShared, triageSnapshotsInHarnessShared, triageLedgerInHarnessShared, potsInHarnessShared, potMembersInHarnessShared, documentsInHarnessShared, personalVaultImportJobsInHarnessShared, daoHrContractsInHarnessShared, workspaceHostConnectionsInHarnessShared } from "./generated";

export const governancePolicyLayersInHarnessSharedRelations = relations(governancePolicyLayersInHarnessShared, ({one, many}) => ({
	governancePolicyLayersInHarnessShared: one(governancePolicyLayersInHarnessShared, {
		fields: [governancePolicyLayersInHarnessShared.parentLayerId],
		references: [governancePolicyLayersInHarnessShared.layerId],
		relationName: "governancePolicyLayersInHarnessShared_parentLayerId_governancePolicyLayersInHarnessShared_layerId"
	}),
	governancePolicyLayersInHarnessShareds: many(governancePolicyLayersInHarnessShared, {
		relationName: "governancePolicyLayersInHarnessShared_parentLayerId_governancePolicyLayersInHarnessShared_layerId"
	}),
	governanceDelegationsInHarnessShareds: many(governanceDelegationsInHarnessShared),
	sensitiveActionRequestsInHarnessShareds: many(sensitiveActionRequestsInHarnessShared),
	governancePolicyLayerVersionsInHarnessShareds: many(governancePolicyLayerVersionsInHarnessShared),
}));

export const routinesInHarnessSharedRelations = relations(routinesInHarnessShared, ({one}) => ({
	routineGroupsInHarnessShared: one(routineGroupsInHarnessShared, {
		fields: [routinesInHarnessShared.workspaceId, routinesInHarnessShared.groupSlug],
		references: [routineGroupsInHarnessShared.workspaceId, routineGroupsInHarnessShared.slug]
	}),
}));

export const routineGroupsInHarnessSharedRelations = relations(routineGroupsInHarnessShared, ({many}) => ({
	routinesInHarnessShareds: many(routinesInHarnessShared),
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

export const connectedAppDeviceGrantsInHarnessSharedRelations = relations(connectedAppDeviceGrantsInHarnessShared, ({one}) => ({
	connectedAppOauthClientsInHarnessShared: one(connectedAppOauthClientsInHarnessShared, {
		fields: [connectedAppDeviceGrantsInHarnessShared.oauthClientId],
		references: [connectedAppOauthClientsInHarnessShared.clientId]
	}),
}));

export const connectedAppOauthClientsInHarnessSharedRelations = relations(connectedAppOauthClientsInHarnessShared, ({many}) => ({
	connectedAppDeviceGrantsInHarnessShareds: many(connectedAppDeviceGrantsInHarnessShared),
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

export const memoryPrecisionBenchAttemptsInHarnessSharedRelations = relations(memoryPrecisionBenchAttemptsInHarnessShared, ({one}) => ({
	memoryPrecisionBenchInHarnessShared: one(memoryPrecisionBenchInHarnessShared, {
		fields: [memoryPrecisionBenchAttemptsInHarnessShared.rowId],
		references: [memoryPrecisionBenchInHarnessShared.id]
	}),
}));

export const memoryPrecisionBenchInHarnessSharedRelations = relations(memoryPrecisionBenchInHarnessShared, ({many}) => ({
	memoryPrecisionBenchAttemptsInHarnessShareds: many(memoryPrecisionBenchAttemptsInHarnessShared),
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
	triggerBindingsInHarnessShareds: many(triggerBindingsInHarnessShared),
}));

export const capabilityClassConformanceRunsInHarnessSharedRelations = relations(capabilityClassConformanceRunsInHarnessShared, ({one, many}) => ({
	capabilityClassRegistryInHarnessShared: one(capabilityClassRegistryInHarnessShared, {
		fields: [capabilityClassConformanceRunsInHarnessShared.workspaceId, capabilityClassConformanceRunsInHarnessShared.classId, capabilityClassConformanceRunsInHarnessShared.classVersion],
		references: [capabilityClassRegistryInHarnessShared.workspaceId, capabilityClassRegistryInHarnessShared.id, capabilityClassRegistryInHarnessShared.version]
	}),
	capabilityClassProviderBindingsInHarnessShareds: many(capabilityClassProviderBindingsInHarnessShared),
}));

export const capabilityClassRegistryInHarnessSharedRelations = relations(capabilityClassRegistryInHarnessShared, ({many}) => ({
	capabilityClassConformanceRunsInHarnessShareds: many(capabilityClassConformanceRunsInHarnessShared),
	capabilityClassProviderBindingsInHarnessShareds: many(capabilityClassProviderBindingsInHarnessShared),
}));

export const connectedAppAccessTokensInHarnessSharedRelations = relations(connectedAppAccessTokensInHarnessShared, ({one}) => ({
	connectedAppsInHarnessShared: one(connectedAppsInHarnessShared, {
		fields: [connectedAppAccessTokensInHarnessShared.appId],
		references: [connectedAppsInHarnessShared.id]
	}),
}));

export const connectedAppsInHarnessSharedRelations = relations(connectedAppsInHarnessShared, ({many}) => ({
	connectedAppAccessTokensInHarnessShareds: many(connectedAppAccessTokensInHarnessShared),
	mobilePushTokensInHarnessShareds: many(mobilePushTokensInHarnessShared),
	connectedAppClientAssertionsInHarnessShareds: many(connectedAppClientAssertionsInHarnessShared),
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
	appOwnerMappingsInHarnessShareds: many(appOwnerMappingsInHarnessShared),
	personalIdentitiesInHarnessShareds: many(personalIdentitiesInHarnessShared),
	providerIdentityMappingsInHarnessShareds: many(providerIdentityMappingsInHarnessShared),
	personalPrivacyRulesInHarnessShareds: many(personalPrivacyRulesInHarnessShared),
	personalGrantsInHarnessShareds: many(personalGrantsInHarnessShared),
	personalVaultImportUploadsInHarnessShareds: many(personalVaultImportUploadsInHarnessShared),
	personalDisclosuresInHarnessShareds: many(personalDisclosuresInHarnessShared),
	documentsInHarnessShareds: many(documentsInHarnessShared),
	dataSourcesInHarnessShareds: many(dataSourcesInHarnessShared),
	personalVaultImportJobsInHarnessShareds: many(personalVaultImportJobsInHarnessShared),
}));

export const daoHrPolicyAuditInHarnessSharedRelations = relations(daoHrPolicyAuditInHarnessShared, ({one}) => ({
	daoHrPolicyVersionsInHarnessShared: one(daoHrPolicyVersionsInHarnessShared, {
		fields: [daoHrPolicyAuditInHarnessShared.workspaceId, daoHrPolicyAuditInHarnessShared.daoSlug, daoHrPolicyAuditInHarnessShared.version],
		references: [daoHrPolicyVersionsInHarnessShared.workspaceId, daoHrPolicyVersionsInHarnessShared.daoSlug, daoHrPolicyVersionsInHarnessShared.version]
	}),
}));

export const daoHrPolicyVersionsInHarnessSharedRelations = relations(daoHrPolicyVersionsInHarnessShared, ({many}) => ({
	daoHrPolicyAuditInHarnessShareds: many(daoHrPolicyAuditInHarnessShared),
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

export const connectorPushSecretsInHarnessSharedRelations = relations(connectorPushSecretsInHarnessShared, ({one}) => ({
	dataSourcesInHarnessShared: one(dataSourcesInHarnessShared, {
		fields: [connectorPushSecretsInHarnessShared.workspaceId, connectorPushSecretsInHarnessShared.sourceId],
		references: [dataSourcesInHarnessShared.workspaceId, dataSourcesInHarnessShared.id]
	}),
}));

export const dataSourcesInHarnessSharedRelations = relations(dataSourcesInHarnessShared, ({one, many}) => ({
	connectorPushSecretsInHarnessShareds: many(connectorPushSecretsInHarnessShared),
	chatBugSuggestionsInHarnessShareds: many(chatBugSuggestionsInHarnessShared),
	triggerWebhookSecretsInHarnessShareds: many(triggerWebhookSecretsInHarnessShared),
	dataSourceLegalHoldsInHarnessShareds: many(dataSourceLegalHoldsInHarnessShared),
	chatRollupQueueInHarnessShareds: many(chatRollupQueueInHarnessShared),
	chatRetrievalUnitsInHarnessShareds: many(chatRetrievalUnitsInHarnessShared),
	admissionRulesInHarnessShareds: many(admissionRulesInHarnessShared),
	chatMessagesInHarnessShareds: many(chatMessagesInHarnessShared),
	triggerDeliveriesInHarnessShareds: many(triggerDeliveriesInHarnessShared),
	triggerBindingsInHarnessShareds: many(triggerBindingsInHarnessShared),
	usersInHarnessShared: one(usersInHarnessShared, {
		fields: [dataSourcesInHarnessShared.ownerUserId],
		references: [usersInHarnessShared.id]
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

export const chatBugSuggestionsInHarnessSharedRelations = relations(chatBugSuggestionsInHarnessShared, ({one}) => ({
	dataSourcesInHarnessShared: one(dataSourcesInHarnessShared, {
		fields: [chatBugSuggestionsInHarnessShared.workspaceId, chatBugSuggestionsInHarnessShared.dataSourceId],
		references: [dataSourcesInHarnessShared.workspaceId, dataSourcesInHarnessShared.id]
	}),
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
	specEvidenceBindingsInHarnessShareds: many(specEvidenceBindingsInHarnessShared),
	testCaseRunsInHarnessShareds: many(testCaseRunsInHarnessShared),
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

export const benchmarkRunResultInHarnessSharedRelations = relations(benchmarkRunResultInHarnessShared, ({one}) => ({
	benchmarkRolloutInHarnessShared: one(benchmarkRolloutInHarnessShared, {
		fields: [benchmarkRunResultInHarnessShared.rolloutId],
		references: [benchmarkRolloutInHarnessShared.rolloutId]
	}),
}));

export const benchmarkRolloutInHarnessSharedRelations = relations(benchmarkRolloutInHarnessShared, ({many}) => ({
	benchmarkRunResultInHarnessShareds: many(benchmarkRunResultInHarnessShared),
}));

export const governanceDelegationsInHarnessSharedRelations = relations(governanceDelegationsInHarnessShared, ({one}) => ({
	governancePolicyLayersInHarnessShared: one(governancePolicyLayersInHarnessShared, {
		fields: [governanceDelegationsInHarnessShared.layerId],
		references: [governancePolicyLayersInHarnessShared.layerId]
	}),
}));

export const sensitiveActionRequestsInHarnessSharedRelations = relations(sensitiveActionRequestsInHarnessShared, ({one, many}) => ({
	governancePolicyLayersInHarnessShared: one(governancePolicyLayersInHarnessShared, {
		fields: [sensitiveActionRequestsInHarnessShared.authorityLayerId],
		references: [governancePolicyLayersInHarnessShared.layerId]
	}),
	sensitiveActionApprovalsInHarnessShareds: many(sensitiveActionApprovalsInHarnessShared),
}));

export const daoHrCounselApprovalsInHarnessSharedRelations = relations(daoHrCounselApprovalsInHarnessShared, ({one}) => ({
	daoHrContractTemplateVersionsInHarnessShared: one(daoHrContractTemplateVersionsInHarnessShared, {
		fields: [daoHrCounselApprovalsInHarnessShared.workspaceId, daoHrCounselApprovalsInHarnessShared.daoSlug, daoHrCounselApprovalsInHarnessShared.templateKey, daoHrCounselApprovalsInHarnessShared.version],
		references: [daoHrContractTemplateVersionsInHarnessShared.workspaceId, daoHrContractTemplateVersionsInHarnessShared.daoSlug, daoHrContractTemplateVersionsInHarnessShared.templateKey, daoHrContractTemplateVersionsInHarnessShared.version]
	}),
}));

export const daoHrContractTemplateVersionsInHarnessSharedRelations = relations(daoHrContractTemplateVersionsInHarnessShared, ({one, many}) => ({
	daoHrCounselApprovalsInHarnessShareds: many(daoHrCounselApprovalsInHarnessShared),
	daoHrContractTemplatesInHarnessShared: one(daoHrContractTemplatesInHarnessShared, {
		fields: [daoHrContractTemplateVersionsInHarnessShared.workspaceId, daoHrContractTemplateVersionsInHarnessShared.daoSlug, daoHrContractTemplateVersionsInHarnessShared.templateKey],
		references: [daoHrContractTemplatesInHarnessShared.workspaceId, daoHrContractTemplatesInHarnessShared.daoSlug, daoHrContractTemplatesInHarnessShared.templateKey]
	}),
}));

export const siemExportDeliveriesInHarnessSharedRelations = relations(siemExportDeliveriesInHarnessShared, ({one}) => ({
	siemExportStreamsInHarnessShared: one(siemExportStreamsInHarnessShared, {
		fields: [siemExportDeliveriesInHarnessShared.streamId],
		references: [siemExportStreamsInHarnessShared.streamId]
	}),
}));

export const siemExportStreamsInHarnessSharedRelations = relations(siemExportStreamsInHarnessShared, ({many}) => ({
	siemExportDeliveriesInHarnessShareds: many(siemExportDeliveriesInHarnessShared),
}));

export const specEvidenceBindingsInHarnessSharedRelations = relations(specEvidenceBindingsInHarnessShared, ({one, many}) => ({
	testRunsInHarnessShared: one(testRunsInHarnessShared, {
		fields: [specEvidenceBindingsInHarnessShared.testRunId],
		references: [testRunsInHarnessShared.id]
	}),
	specEvidenceBindingsInHarnessShared: one(specEvidenceBindingsInHarnessShared, {
		fields: [specEvidenceBindingsInHarnessShared.verifiesBindingId],
		references: [specEvidenceBindingsInHarnessShared.id],
		relationName: "specEvidenceBindingsInHarnessShared_verifiesBindingId_specEvidenceBindingsInHarnessShared_id"
	}),
	specEvidenceBindingsInHarnessShareds: many(specEvidenceBindingsInHarnessShared, {
		relationName: "specEvidenceBindingsInHarnessShared_verifiesBindingId_specEvidenceBindingsInHarnessShared_id"
	}),
	workItemSpecRevisionEdgesInHarnessShared: one(workItemSpecRevisionEdgesInHarnessShared, {
		fields: [specEvidenceBindingsInHarnessShared.workspaceId, specEvidenceBindingsInHarnessShared.harnessSlug, specEvidenceBindingsInHarnessShared.workItemId, specEvidenceBindingsInHarnessShared.planSlug, specEvidenceBindingsInHarnessShared.specId, specEvidenceBindingsInHarnessShared.specRevision, specEvidenceBindingsInHarnessShared.specFingerprint],
		references: [workItemSpecRevisionEdgesInHarnessShared.workspaceId, workItemSpecRevisionEdgesInHarnessShared.harnessSlug, workItemSpecRevisionEdgesInHarnessShared.workItemId, workItemSpecRevisionEdgesInHarnessShared.planSlug, workItemSpecRevisionEdgesInHarnessShared.specId, workItemSpecRevisionEdgesInHarnessShared.specRevision, workItemSpecRevisionEdgesInHarnessShared.specFingerprint]
	}),
}));

export const workItemSpecRevisionEdgesInHarnessSharedRelations = relations(workItemSpecRevisionEdgesInHarnessShared, ({one, many}) => ({
	specEvidenceBindingsInHarnessShareds: many(specEvidenceBindingsInHarnessShared),
	planSpecClauseRevisionsInHarnessShared: one(planSpecClauseRevisionsInHarnessShared, {
		fields: [workItemSpecRevisionEdgesInHarnessShared.workspaceId, workItemSpecRevisionEdgesInHarnessShared.harnessSlug, workItemSpecRevisionEdgesInHarnessShared.planSlug, workItemSpecRevisionEdgesInHarnessShared.specId, workItemSpecRevisionEdgesInHarnessShared.specRevision, workItemSpecRevisionEdgesInHarnessShared.specFingerprint],
		references: [planSpecClauseRevisionsInHarnessShared.workspaceId, planSpecClauseRevisionsInHarnessShared.harnessSlug, planSpecClauseRevisionsInHarnessShared.planSlug, planSpecClauseRevisionsInHarnessShared.specId, planSpecClauseRevisionsInHarnessShared.revision, planSpecClauseRevisionsInHarnessShared.contentHash]
	}),
	workItemsInHarnessShared: one(workItemsInHarnessShared, {
		fields: [workItemSpecRevisionEdgesInHarnessShared.workspaceId, workItemSpecRevisionEdgesInHarnessShared.harnessSlug, workItemSpecRevisionEdgesInHarnessShared.workItemId],
		references: [workItemsInHarnessShared.workspaceId, workItemsInHarnessShared.harnessSlug, workItemsInHarnessShared.featureId]
	}),
}));

export const planBlindReviewSessionsInHarnessSharedRelations = relations(planBlindReviewSessionsInHarnessShared, ({one, many}) => ({
	planBlindReviewSessionsInHarnessShared: one(planBlindReviewSessionsInHarnessShared, {
		fields: [planBlindReviewSessionsInHarnessShared.replacementOf],
		references: [planBlindReviewSessionsInHarnessShared.id],
		relationName: "planBlindReviewSessionsInHarnessShared_replacementOf_planBlindReviewSessionsInHarnessShared_id"
	}),
	planBlindReviewSessionsInHarnessShareds: many(planBlindReviewSessionsInHarnessShared, {
		relationName: "planBlindReviewSessionsInHarnessShared_replacementOf_planBlindReviewSessionsInHarnessShared_id"
	}),
}));

export const acceptanceAdoptionRunsInHarnessSharedRelations = relations(acceptanceAdoptionRunsInHarnessShared, ({one, many}) => ({
	acceptanceAdoptionRunsInHarnessShared: one(acceptanceAdoptionRunsInHarnessShared, {
		fields: [acceptanceAdoptionRunsInHarnessShared.reportRunId],
		references: [acceptanceAdoptionRunsInHarnessShared.runId],
		relationName: "acceptanceAdoptionRunsInHarnessShared_reportRunId_acceptanceAdoptionRunsInHarnessShared_runId"
	}),
	acceptanceAdoptionRunsInHarnessShareds: many(acceptanceAdoptionRunsInHarnessShared, {
		relationName: "acceptanceAdoptionRunsInHarnessShared_reportRunId_acceptanceAdoptionRunsInHarnessShared_runId"
	}),
}));

export const messageRecipientsInPapercuspSharedRelations = relations(messageRecipientsInPapercuspShared, ({one}) => ({
	messagesInPapercuspShared: one(messagesInPapercuspShared, {
		fields: [messageRecipientsInPapercuspShared.messageId],
		references: [messagesInPapercuspShared.id]
	}),
}));

export const mobilePushTokensInHarnessSharedRelations = relations(mobilePushTokensInHarnessShared, ({one}) => ({
	connectedAppsInHarnessShared: one(connectedAppsInHarnessShared, {
		fields: [mobilePushTokensInHarnessShared.deviceId],
		references: [connectedAppsInHarnessShared.id]
	}),
}));

export const connectedAppClientAssertionsInHarnessSharedRelations = relations(connectedAppClientAssertionsInHarnessShared, ({one}) => ({
	connectedAppsInHarnessShared: one(connectedAppsInHarnessShared, {
		fields: [connectedAppClientAssertionsInHarnessShared.appId],
		references: [connectedAppsInHarnessShared.id]
	}),
}));

export const userPreferencesInHarnessSharedRelations = relations(userPreferencesInHarnessShared, ({one}) => ({
	usersInHarnessShared: one(usersInHarnessShared, {
		fields: [userPreferencesInHarnessShared.userId],
		references: [usersInHarnessShared.id]
	}),
}));

export const documentPermissionMembersInHarnessSharedRelations = relations(documentPermissionMembersInHarnessShared, ({one}) => ({
	documentPermissionListsInHarnessShared: one(documentPermissionListsInHarnessShared, {
		fields: [documentPermissionMembersInHarnessShared.workspaceId, documentPermissionMembersInHarnessShared.listId],
		references: [documentPermissionListsInHarnessShared.workspaceId, documentPermissionListsInHarnessShared.id]
	}),
}));

export const documentPermissionListsInHarnessSharedRelations = relations(documentPermissionListsInHarnessShared, ({many}) => ({
	documentPermissionMembersInHarnessShareds: many(documentPermissionMembersInHarnessShared),
	documentsInHarnessShareds: many(documentsInHarnessShared),
}));

export const diskCensusConsumersInHarnessSharedRelations = relations(diskCensusConsumersInHarnessShared, ({one}) => ({
	diskCensusRunsInHarnessShared: one(diskCensusRunsInHarnessShared, {
		fields: [diskCensusConsumersInHarnessShared.runId],
		references: [diskCensusRunsInHarnessShared.runId]
	}),
}));

export const diskCensusRunsInHarnessSharedRelations = relations(diskCensusRunsInHarnessShared, ({many}) => ({
	diskCensusConsumersInHarnessShareds: many(diskCensusConsumersInHarnessShared),
}));

export const daoHrOfferApprovalsInHarnessSharedRelations = relations(daoHrOfferApprovalsInHarnessShared, ({one}) => ({
	daoHrOffersInHarnessShared: one(daoHrOffersInHarnessShared, {
		fields: [daoHrOfferApprovalsInHarnessShared.workspaceId, daoHrOfferApprovalsInHarnessShared.daoSlug, daoHrOfferApprovalsInHarnessShared.offerId],
		references: [daoHrOffersInHarnessShared.workspaceId, daoHrOffersInHarnessShared.daoSlug, daoHrOffersInHarnessShared.offerId]
	}),
}));

export const daoHrOffersInHarnessSharedRelations = relations(daoHrOffersInHarnessShared, ({one, many}) => ({
	daoHrOfferApprovalsInHarnessShareds: many(daoHrOfferApprovalsInHarnessShared),
	daoHrOffersInHarnessShared: one(daoHrOffersInHarnessShared, {
		fields: [daoHrOffersInHarnessShared.workspaceId, daoHrOffersInHarnessShared.daoSlug, daoHrOffersInHarnessShared.amendsOfferId],
		references: [daoHrOffersInHarnessShared.workspaceId, daoHrOffersInHarnessShared.daoSlug, daoHrOffersInHarnessShared.offerId],
		relationName: "daoHrOffersInHarnessShared_workspaceId_daoHrOffersInHarnessShared_workspaceId"
	}),
	daoHrOffersInHarnessShareds: many(daoHrOffersInHarnessShared, {
		relationName: "daoHrOffersInHarnessShared_workspaceId_daoHrOffersInHarnessShared_workspaceId"
	}),
	daoHrCandidatesInHarnessShared: one(daoHrCandidatesInHarnessShared, {
		fields: [daoHrOffersInHarnessShared.workspaceId, daoHrOffersInHarnessShared.daoSlug, daoHrOffersInHarnessShared.roleId, daoHrOffersInHarnessShared.personId],
		references: [daoHrCandidatesInHarnessShared.workspaceId, daoHrCandidatesInHarnessShared.daoSlug, daoHrCandidatesInHarnessShared.roleId, daoHrCandidatesInHarnessShared.personId]
	}),
	daoHrContractsInHarnessShareds: many(daoHrContractsInHarnessShared),
}));

export const sensitiveActionApprovalsInHarnessSharedRelations = relations(sensitiveActionApprovalsInHarnessShared, ({one}) => ({
	sensitiveActionRequestsInHarnessShared: one(sensitiveActionRequestsInHarnessShared, {
		fields: [sensitiveActionApprovalsInHarnessShared.requestId],
		references: [sensitiveActionRequestsInHarnessShared.requestId]
	}),
}));

export const personalVaultSettingsInHarnessSharedRelations = relations(personalVaultSettingsInHarnessShared, ({one}) => ({
	usersInHarnessShared: one(usersInHarnessShared, {
		fields: [personalVaultSettingsInHarnessShared.userId],
		references: [usersInHarnessShared.id]
	}),
}));

export const blueprintPackageDependentsInHarnessSharedRelations = relations(blueprintPackageDependentsInHarnessShared, ({one}) => ({
	blueprintPackageResourcesInHarnessShared: one(blueprintPackageResourcesInHarnessShared, {
		fields: [blueprintPackageDependentsInHarnessShared.workspaceId, blueprintPackageDependentsInHarnessShared.resourceKey],
		references: [blueprintPackageResourcesInHarnessShared.workspaceId, blueprintPackageResourcesInHarnessShared.resourceKey]
	}),
}));

export const blueprintPackageResourcesInHarnessSharedRelations = relations(blueprintPackageResourcesInHarnessShared, ({many}) => ({
	blueprintPackageDependentsInHarnessShareds: many(blueprintPackageDependentsInHarnessShared),
}));

export const reportLibrarySharesInHarnessSharedRelations = relations(reportLibrarySharesInHarnessShared, ({one}) => ({
	reportLibraryInHarnessShared: one(reportLibraryInHarnessShared, {
		fields: [reportLibrarySharesInHarnessShared.workspaceId, reportLibrarySharesInHarnessShared.reportId],
		references: [reportLibraryInHarnessShared.workspaceId, reportLibraryInHarnessShared.reportId]
	}),
}));

export const reportLibraryInHarnessSharedRelations = relations(reportLibraryInHarnessShared, ({many}) => ({
	reportLibrarySharesInHarnessShareds: many(reportLibrarySharesInHarnessShared),
	reportLibraryChunksInHarnessShareds: many(reportLibraryChunksInHarnessShared),
}));

export const moneyJournalMicroAccrualsInHarnessSharedRelations = relations(moneyJournalMicroAccrualsInHarnessShared, ({one}) => ({
	moneyJournalRollupsInHarnessShared: one(moneyJournalRollupsInHarnessShared, {
		fields: [moneyJournalMicroAccrualsInHarnessShared.workspaceId, moneyJournalMicroAccrualsInHarnessShared.rollupId],
		references: [moneyJournalRollupsInHarnessShared.workspaceId, moneyJournalRollupsInHarnessShared.rollupId]
	}),
}));

export const moneyJournalRollupsInHarnessSharedRelations = relations(moneyJournalRollupsInHarnessShared, ({many}) => ({
	moneyJournalMicroAccrualsInHarnessShareds: many(moneyJournalMicroAccrualsInHarnessShared),
}));

export const sessionTurnWindowsInHarnessSharedRelations = relations(sessionTurnWindowsInHarnessShared, ({one}) => ({
	sessionTurnsInHarnessShared: one(sessionTurnsInHarnessShared, {
		fields: [sessionTurnWindowsInHarnessShared.workspaceId, sessionTurnWindowsInHarnessShared.sourceKind, sessionTurnWindowsInHarnessShared.sessionId, sessionTurnWindowsInHarnessShared.turnIdx],
		references: [sessionTurnsInHarnessShared.workspaceId, sessionTurnsInHarnessShared.sourceKind, sessionTurnsInHarnessShared.sessionId, sessionTurnsInHarnessShared.turnIdx]
	}),
}));

export const sessionTurnsInHarnessSharedRelations = relations(sessionTurnsInHarnessShared, ({many}) => ({
	sessionTurnWindowsInHarnessShareds: many(sessionTurnWindowsInHarnessShared),
	sessionTurnChunksInHarnessShareds: many(sessionTurnChunksInHarnessShared),
}));

export const memoryAnchorsInHarnessSharedRelations = relations(memoryAnchorsInHarnessShared, ({one}) => ({
	memoryCanonicalInHarnessShared: one(memoryCanonicalInHarnessShared, {
		fields: [memoryAnchorsInHarnessShared.memoryId],
		references: [memoryCanonicalInHarnessShared.id]
	}),
}));

export const daoHrCandidatesInHarnessSharedRelations = relations(daoHrCandidatesInHarnessShared, ({one, many}) => ({
	daoHrRolesInHarnessShared: one(daoHrRolesInHarnessShared, {
		fields: [daoHrCandidatesInHarnessShared.workspaceId, daoHrCandidatesInHarnessShared.daoSlug, daoHrCandidatesInHarnessShared.roleId],
		references: [daoHrRolesInHarnessShared.workspaceId, daoHrRolesInHarnessShared.daoSlug, daoHrRolesInHarnessShared.roleId]
	}),
	daoHrOffersInHarnessShareds: many(daoHrOffersInHarnessShared),
}));

export const daoHrRolesInHarnessSharedRelations = relations(daoHrRolesInHarnessShared, ({many}) => ({
	daoHrCandidatesInHarnessShareds: many(daoHrCandidatesInHarnessShared),
}));

export const moneyJournalLinesInHarnessSharedRelations = relations(moneyJournalLinesInHarnessShared, ({one}) => ({
	moneyJournalEntriesInHarnessShared: one(moneyJournalEntriesInHarnessShared, {
		fields: [moneyJournalLinesInHarnessShared.workspaceId, moneyJournalLinesInHarnessShared.entryId],
		references: [moneyJournalEntriesInHarnessShared.workspaceId, moneyJournalEntriesInHarnessShared.entryId]
	}),
}));

export const moneyJournalEntriesInHarnessSharedRelations = relations(moneyJournalEntriesInHarnessShared, ({many}) => ({
	moneyJournalLinesInHarnessShareds: many(moneyJournalLinesInHarnessShared),
}));

export const sqlIntentFamilyRunsInHarnessSharedRelations = relations(sqlIntentFamilyRunsInHarnessShared, ({one}) => ({
	sqlIntentRunsInHarnessShared: one(sqlIntentRunsInHarnessShared, {
		fields: [sqlIntentFamilyRunsInHarnessShared.workspaceId, sqlIntentFamilyRunsInHarnessShared.runId],
		references: [sqlIntentRunsInHarnessShared.workspaceId, sqlIntentRunsInHarnessShared.runId]
	}),
}));

export const sqlIntentRunsInHarnessSharedRelations = relations(sqlIntentRunsInHarnessShared, ({many}) => ({
	sqlIntentFamilyRunsInHarnessShareds: many(sqlIntentFamilyRunsInHarnessShared),
}));

export const sessionTaskWorkItemLinksInHarnessSharedRelations = relations(sessionTaskWorkItemLinksInHarnessShared, ({one}) => ({
	sessionTasksInHarnessShared: one(sessionTasksInHarnessShared, {
		fields: [sessionTaskWorkItemLinksInHarnessShared.workspaceId, sessionTaskWorkItemLinksInHarnessShared.sessionId, sessionTaskWorkItemLinksInHarnessShared.taskId],
		references: [sessionTasksInHarnessShared.workspaceId, sessionTasksInHarnessShared.sessionId, sessionTasksInHarnessShared.taskId]
	}),
}));

export const sessionTasksInHarnessSharedRelations = relations(sessionTasksInHarnessShared, ({many}) => ({
	sessionTaskWorkItemLinksInHarnessShareds: many(sessionTaskWorkItemLinksInHarnessShared),
}));

export const testCaseRunsInHarnessSharedRelations = relations(testCaseRunsInHarnessShared, ({one}) => ({
	testRunsInHarnessShared: one(testRunsInHarnessShared, {
		fields: [testCaseRunsInHarnessShared.testRunId],
		references: [testRunsInHarnessShared.id]
	}),
}));

export const personalSyncStateInHarnessSharedRelations = relations(personalSyncStateInHarnessShared, ({one}) => ({
	usersInHarnessShared: one(usersInHarnessShared, {
		fields: [personalSyncStateInHarnessShared.userId],
		references: [usersInHarnessShared.id]
	}),
}));

export const appOwnerMappingsInHarnessSharedRelations = relations(appOwnerMappingsInHarnessShared, ({one}) => ({
	usersInHarnessShared: one(usersInHarnessShared, {
		fields: [appOwnerMappingsInHarnessShared.userId],
		references: [usersInHarnessShared.id]
	}),
}));

export const triggerWebhookSecretsInHarnessSharedRelations = relations(triggerWebhookSecretsInHarnessShared, ({one}) => ({
	dataSourcesInHarnessShared: one(dataSourcesInHarnessShared, {
		fields: [triggerWebhookSecretsInHarnessShared.workspaceId, triggerWebhookSecretsInHarnessShared.sourceId],
		references: [dataSourcesInHarnessShared.workspaceId, dataSourcesInHarnessShared.id]
	}),
}));

export const personalIdentitiesInHarnessSharedRelations = relations(personalIdentitiesInHarnessShared, ({one, many}) => ({
	usersInHarnessShared: one(usersInHarnessShared, {
		fields: [personalIdentitiesInHarnessShared.userId],
		references: [usersInHarnessShared.id]
	}),
	personalIdentityAliasesInHarnessShareds: many(personalIdentityAliasesInHarnessShared),
}));

export const reportLibraryChunksInHarnessSharedRelations = relations(reportLibraryChunksInHarnessShared, ({one}) => ({
	reportLibraryInHarnessShared: one(reportLibraryInHarnessShared, {
		fields: [reportLibraryChunksInHarnessShared.workspaceId, reportLibraryChunksInHarnessShared.reportId],
		references: [reportLibraryInHarnessShared.workspaceId, reportLibraryInHarnessShared.reportId]
	}),
}));

export const planSpecClausesInHarnessSharedRelations = relations(planSpecClausesInHarnessShared, ({one, many}) => ({
	planSpecClauseRevisionsInHarnessShared: one(planSpecClauseRevisionsInHarnessShared, {
		fields: [planSpecClausesInHarnessShared.workspaceId, planSpecClausesInHarnessShared.harnessSlug, planSpecClausesInHarnessShared.planSlug, planSpecClausesInHarnessShared.specId, planSpecClausesInHarnessShared.currentRevision],
		references: [planSpecClauseRevisionsInHarnessShared.workspaceId, planSpecClauseRevisionsInHarnessShared.harnessSlug, planSpecClauseRevisionsInHarnessShared.planSlug, planSpecClauseRevisionsInHarnessShared.specId, planSpecClauseRevisionsInHarnessShared.revision],
		relationName: "planSpecClausesInHarnessShared_workspaceId_planSpecClauseRevisionsInHarnessShared_workspaceId"
	}),
	harnessPlansInHarnessShared: one(harnessPlansInHarnessShared, {
		fields: [planSpecClausesInHarnessShared.workspaceId, planSpecClausesInHarnessShared.harnessSlug, planSpecClausesInHarnessShared.planSlug],
		references: [harnessPlansInHarnessShared.workspaceId, harnessPlansInHarnessShared.harnessSlug, harnessPlansInHarnessShared.planSlug]
	}),
	planSpecClauseRevisionsInHarnessShareds: many(planSpecClauseRevisionsInHarnessShared, {
		relationName: "planSpecClauseRevisionsInHarnessShared_workspaceId_planSpecClausesInHarnessShared_workspaceId"
	}),
}));

export const planSpecClauseRevisionsInHarnessSharedRelations = relations(planSpecClauseRevisionsInHarnessShared, ({one, many}) => ({
	planSpecClausesInHarnessShareds: many(planSpecClausesInHarnessShared, {
		relationName: "planSpecClausesInHarnessShared_workspaceId_planSpecClauseRevisionsInHarnessShared_workspaceId"
	}),
	workItemSpecRevisionEdgesInHarnessShareds: many(workItemSpecRevisionEdgesInHarnessShared),
	planSpecClauseRevisionsInHarnessShared: one(planSpecClauseRevisionsInHarnessShared, {
		fields: [planSpecClauseRevisionsInHarnessShared.workspaceId, planSpecClauseRevisionsInHarnessShared.harnessSlug, planSpecClauseRevisionsInHarnessShared.planSlug, planSpecClauseRevisionsInHarnessShared.supersedesSpecId, planSpecClauseRevisionsInHarnessShared.supersedesRevision],
		references: [planSpecClauseRevisionsInHarnessShared.workspaceId, planSpecClauseRevisionsInHarnessShared.harnessSlug, planSpecClauseRevisionsInHarnessShared.planSlug, planSpecClauseRevisionsInHarnessShared.specId, planSpecClauseRevisionsInHarnessShared.revision],
		relationName: "planSpecClauseRevisionsInHarnessShared_workspaceId_planSpecClauseRevisionsInHarnessShared_workspaceId"
	}),
	planSpecClauseRevisionsInHarnessShareds: many(planSpecClauseRevisionsInHarnessShared, {
		relationName: "planSpecClauseRevisionsInHarnessShared_workspaceId_planSpecClauseRevisionsInHarnessShared_workspaceId"
	}),
	planSpecClausesInHarnessShared: one(planSpecClausesInHarnessShared, {
		fields: [planSpecClauseRevisionsInHarnessShared.workspaceId, planSpecClauseRevisionsInHarnessShared.harnessSlug, planSpecClauseRevisionsInHarnessShared.planSlug, planSpecClauseRevisionsInHarnessShared.specId],
		references: [planSpecClausesInHarnessShared.workspaceId, planSpecClausesInHarnessShared.harnessSlug, planSpecClausesInHarnessShared.planSlug, planSpecClausesInHarnessShared.specId],
		relationName: "planSpecClauseRevisionsInHarnessShared_workspaceId_planSpecClausesInHarnessShared_workspaceId"
	}),
}));

export const harnessPlansInHarnessSharedRelations = relations(harnessPlansInHarnessShared, ({many}) => ({
	planSpecClausesInHarnessShareds: many(planSpecClausesInHarnessShared),
	planDecisionsInHarnessShareds: many(planDecisionsInHarnessShared),
	planItemsInHarnessShareds: many(planItemsInHarnessShared),
	triggerBindingsInHarnessShareds: many(triggerBindingsInHarnessShared),
}));

export const providerIdentityMappingsInHarnessSharedRelations = relations(providerIdentityMappingsInHarnessShared, ({one}) => ({
	usersInHarnessShared: one(usersInHarnessShared, {
		fields: [providerIdentityMappingsInHarnessShared.userId],
		references: [usersInHarnessShared.id]
	}),
}));

export const dataSourceLegalHoldsInHarnessSharedRelations = relations(dataSourceLegalHoldsInHarnessShared, ({one}) => ({
	dataSourcesInHarnessShared: one(dataSourcesInHarnessShared, {
		fields: [dataSourceLegalHoldsInHarnessShared.workspaceId, dataSourceLegalHoldsInHarnessShared.dataSourceId],
		references: [dataSourcesInHarnessShared.workspaceId, dataSourcesInHarnessShared.id]
	}),
}));

export const workItemsInHarnessSharedRelations = relations(workItemsInHarnessShared, ({many}) => ({
	workItemSpecRevisionEdgesInHarnessShareds: many(workItemSpecRevisionEdgesInHarnessShared),
}));

export const organizationDataKeysInHarnessSharedRelations = relations(organizationDataKeysInHarnessShared, ({one}) => ({
	organizationKeyCustodyInHarnessShared: one(organizationKeyCustodyInHarnessShared, {
		fields: [organizationDataKeysInHarnessShared.organizationId],
		references: [organizationKeyCustodyInHarnessShared.organizationId]
	}),
}));

export const organizationKeyCustodyInHarnessSharedRelations = relations(organizationKeyCustodyInHarnessShared, ({many}) => ({
	organizationDataKeysInHarnessShareds: many(organizationDataKeysInHarnessShared),
}));

export const chatRollupQueueInHarnessSharedRelations = relations(chatRollupQueueInHarnessShared, ({one}) => ({
	dataSourcesInHarnessShared: one(dataSourcesInHarnessShared, {
		fields: [chatRollupQueueInHarnessShared.workspaceId, chatRollupQueueInHarnessShared.dataSourceId],
		references: [dataSourcesInHarnessShared.workspaceId, dataSourcesInHarnessShared.id]
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
	workspaceHostInitializationStepsInHarnessShareds: many(workspaceHostInitializationStepsInHarnessShared),
	workspaceHostResourcesInHarnessShareds: many(workspaceHostResourcesInHarnessShared),
	customerWorkspacesInHarnessShareds: many(customerWorkspacesInHarnessShared),
	workspaceHostConnectionsInHarnessShared: one(workspaceHostConnectionsInHarnessShared, {
		fields: [workspaceHostsInHarnessShared.workspaceId, workspaceHostsInHarnessShared.connectionId],
		references: [workspaceHostConnectionsInHarnessShared.workspaceId, workspaceHostConnectionsInHarnessShared.id]
	}),
	workspaceHostOperationsInHarnessShareds: many(workspaceHostOperationsInHarnessShared),
}));

export const workspaceHostOperationsInHarnessSharedRelations = relations(workspaceHostOperationsInHarnessShared, ({one, many}) => ({
	workspaceHostLogsInHarnessShareds: many(workspaceHostLogsInHarnessShared),
	workspaceHostEventsInHarnessShareds: many(workspaceHostEventsInHarnessShared),
	workspaceHostResourcesInHarnessShareds: many(workspaceHostResourcesInHarnessShared),
	customerWorkspacesInHarnessShared: one(customerWorkspacesInHarnessShared, {
		fields: [workspaceHostOperationsInHarnessShared.workspaceId, workspaceHostOperationsInHarnessShared.organizationId, workspaceHostOperationsInHarnessShared.customerWorkspaceId],
		references: [customerWorkspacesInHarnessShared.workspaceId, customerWorkspacesInHarnessShared.organizationId, customerWorkspacesInHarnessShared.id]
	}),
	workspaceHostsInHarnessShared: one(workspaceHostsInHarnessShared, {
		fields: [workspaceHostOperationsInHarnessShared.workspaceId, workspaceHostOperationsInHarnessShared.hostId],
		references: [workspaceHostsInHarnessShared.workspaceId, workspaceHostsInHarnessShared.id]
	}),
}));

export const daoHrContractTemplatesInHarnessSharedRelations = relations(daoHrContractTemplatesInHarnessShared, ({many}) => ({
	daoHrContractTemplateVersionsInHarnessShareds: many(daoHrContractTemplateVersionsInHarnessShared),
}));

export const personalIdentityAliasesInHarnessSharedRelations = relations(personalIdentityAliasesInHarnessShared, ({one}) => ({
	personalIdentitiesInHarnessShared: one(personalIdentitiesInHarnessShared, {
		fields: [personalIdentityAliasesInHarnessShared.workspaceId, personalIdentityAliasesInHarnessShared.userId, personalIdentityAliasesInHarnessShared.identityId],
		references: [personalIdentitiesInHarnessShared.workspaceId, personalIdentitiesInHarnessShared.userId, personalIdentitiesInHarnessShared.id]
	}),
}));

export const potCapabilityClassBindingsInHarnessSharedRelations = relations(potCapabilityClassBindingsInHarnessShared, ({one}) => ({
	capabilityClassProviderBindingsInHarnessShared: one(capabilityClassProviderBindingsInHarnessShared, {
		fields: [potCapabilityClassBindingsInHarnessShared.workspaceId, potCapabilityClassBindingsInHarnessShared.classId, potCapabilityClassBindingsInHarnessShared.classVersion, potCapabilityClassBindingsInHarnessShared.providerPackage, potCapabilityClassBindingsInHarnessShared.providerVersion, potCapabilityClassBindingsInHarnessShared.providerKind, potCapabilityClassBindingsInHarnessShared.latencyClass],
		references: [capabilityClassProviderBindingsInHarnessShared.workspaceId, capabilityClassProviderBindingsInHarnessShared.classId, capabilityClassProviderBindingsInHarnessShared.classVersion, capabilityClassProviderBindingsInHarnessShared.providerPackage, capabilityClassProviderBindingsInHarnessShared.providerVersion, capabilityClassProviderBindingsInHarnessShared.providerKind, capabilityClassProviderBindingsInHarnessShared.latencyClass]
	}),
}));

export const capabilityClassProviderBindingsInHarnessSharedRelations = relations(capabilityClassProviderBindingsInHarnessShared, ({one, many}) => ({
	potCapabilityClassBindingsInHarnessShareds: many(potCapabilityClassBindingsInHarnessShared),
	capabilityClassRegistryInHarnessShared: one(capabilityClassRegistryInHarnessShared, {
		fields: [capabilityClassProviderBindingsInHarnessShared.workspaceId, capabilityClassProviderBindingsInHarnessShared.classId, capabilityClassProviderBindingsInHarnessShared.classVersion],
		references: [capabilityClassRegistryInHarnessShared.workspaceId, capabilityClassRegistryInHarnessShared.id, capabilityClassRegistryInHarnessShared.version]
	}),
	capabilityClassConformanceRunsInHarnessShared: one(capabilityClassConformanceRunsInHarnessShared, {
		fields: [capabilityClassProviderBindingsInHarnessShared.workspaceId, capabilityClassProviderBindingsInHarnessShared.classId, capabilityClassProviderBindingsInHarnessShared.classVersion, capabilityClassProviderBindingsInHarnessShared.providerPackage, capabilityClassProviderBindingsInHarnessShared.providerVersion, capabilityClassProviderBindingsInHarnessShared.conformanceRunId, capabilityClassProviderBindingsInHarnessShared.bindingEligible, capabilityClassProviderBindingsInHarnessShared.providerKind, capabilityClassProviderBindingsInHarnessShared.latencyClass],
		references: [capabilityClassConformanceRunsInHarnessShared.workspaceId, capabilityClassConformanceRunsInHarnessShared.classId, capabilityClassConformanceRunsInHarnessShared.classVersion, capabilityClassConformanceRunsInHarnessShared.providerPackage, capabilityClassConformanceRunsInHarnessShared.providerVersion, capabilityClassConformanceRunsInHarnessShared.id, capabilityClassConformanceRunsInHarnessShared.structuralPassed, capabilityClassConformanceRunsInHarnessShared.providerKind, capabilityClassConformanceRunsInHarnessShared.latencyClass]
	}),
}));

export const sessionTurnChunksInHarnessSharedRelations = relations(sessionTurnChunksInHarnessShared, ({one}) => ({
	sessionTurnsInHarnessShared: one(sessionTurnsInHarnessShared, {
		fields: [sessionTurnChunksInHarnessShared.workspaceId, sessionTurnChunksInHarnessShared.sourceKind, sessionTurnChunksInHarnessShared.sessionId, sessionTurnChunksInHarnessShared.turnIdx],
		references: [sessionTurnsInHarnessShared.workspaceId, sessionTurnsInHarnessShared.sourceKind, sessionTurnsInHarnessShared.sessionId, sessionTurnsInHarnessShared.turnIdx]
	}),
}));

export const planDecisionsInHarnessSharedRelations = relations(planDecisionsInHarnessShared, ({one}) => ({
	harnessPlansInHarnessShared: one(harnessPlansInHarnessShared, {
		fields: [planDecisionsInHarnessShared.workspaceId, planDecisionsInHarnessShared.harnessSlug, planDecisionsInHarnessShared.planSlug],
		references: [harnessPlansInHarnessShared.workspaceId, harnessPlansInHarnessShared.harnessSlug, harnessPlansInHarnessShared.planSlug]
	}),
}));

export const governancePolicyLayerVersionsInHarnessSharedRelations = relations(governancePolicyLayerVersionsInHarnessShared, ({one}) => ({
	governancePolicyLayersInHarnessShared: one(governancePolicyLayersInHarnessShared, {
		fields: [governancePolicyLayerVersionsInHarnessShared.layerId],
		references: [governancePolicyLayersInHarnessShared.layerId]
	}),
}));

export const personalPrivacyRulesInHarnessSharedRelations = relations(personalPrivacyRulesInHarnessShared, ({one}) => ({
	usersInHarnessShared: one(usersInHarnessShared, {
		fields: [personalPrivacyRulesInHarnessShared.userId],
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

export const personalGrantsInHarnessSharedRelations = relations(personalGrantsInHarnessShared, ({one}) => ({
	usersInHarnessShared: one(usersInHarnessShared, {
		fields: [personalGrantsInHarnessShared.userId],
		references: [usersInHarnessShared.id]
	}),
}));

export const personalVaultImportUploadsInHarnessSharedRelations = relations(personalVaultImportUploadsInHarnessShared, ({one}) => ({
	usersInHarnessShared: one(usersInHarnessShared, {
		fields: [personalVaultImportUploadsInHarnessShared.userId],
		references: [usersInHarnessShared.id]
	}),
}));

export const workspaceHostInitializationStepsInHarnessSharedRelations = relations(workspaceHostInitializationStepsInHarnessShared, ({one}) => ({
	workspaceHostsInHarnessShared: one(workspaceHostsInHarnessShared, {
		fields: [workspaceHostInitializationStepsInHarnessShared.workspaceId, workspaceHostInitializationStepsInHarnessShared.hostId],
		references: [workspaceHostsInHarnessShared.workspaceId, workspaceHostsInHarnessShared.id]
	}),
}));

export const docSectionPredecessorsInHarnessSharedRelations = relations(docSectionPredecessorsInHarnessShared, ({one}) => ({
	docSectionsInHarnessShared: one(docSectionsInHarnessShared, {
		fields: [docSectionPredecessorsInHarnessShared.sourceKey, docSectionPredecessorsInHarnessShared.slug, docSectionPredecessorsInHarnessShared.successorAnchor, docSectionPredecessorsInHarnessShared.successorSha],
		references: [docSectionsInHarnessShared.sourceKey, docSectionsInHarnessShared.slug, docSectionsInHarnessShared.anchor, docSectionsInHarnessShared.pageSha]
	}),
}));

export const docSectionsInHarnessSharedRelations = relations(docSectionsInHarnessShared, ({many}) => ({
	docSectionPredecessorsInHarnessShareds: many(docSectionPredecessorsInHarnessShared),
}));

export const chatRetrievalUnitsInHarnessSharedRelations = relations(chatRetrievalUnitsInHarnessShared, ({one}) => ({
	dataSourcesInHarnessShared: one(dataSourcesInHarnessShared, {
		fields: [chatRetrievalUnitsInHarnessShared.workspaceId, chatRetrievalUnitsInHarnessShared.dataSourceId],
		references: [dataSourcesInHarnessShared.workspaceId, dataSourcesInHarnessShared.id]
	}),
}));

export const personalDisclosuresInHarnessSharedRelations = relations(personalDisclosuresInHarnessShared, ({one}) => ({
	usersInHarnessShared: one(usersInHarnessShared, {
		fields: [personalDisclosuresInHarnessShared.userId],
		references: [usersInHarnessShared.id]
	}),
}));

export const planItemsInHarnessSharedRelations = relations(planItemsInHarnessShared, ({one}) => ({
	harnessPlansInHarnessShared: one(harnessPlansInHarnessShared, {
		fields: [planItemsInHarnessShared.workspaceId, planItemsInHarnessShared.harnessSlug, planItemsInHarnessShared.planSlug],
		references: [harnessPlansInHarnessShared.workspaceId, harnessPlansInHarnessShared.harnessSlug, harnessPlansInHarnessShared.planSlug]
	}),
}));

export const cupboardFundedTurnsInHarnessSharedRelations = relations(cupboardFundedTurnsInHarnessShared, ({one}) => ({
	cupboardMeteredAccountsInHarnessShared: one(cupboardMeteredAccountsInHarnessShared, {
		fields: [cupboardFundedTurnsInHarnessShared.workspaceId, cupboardFundedTurnsInHarnessShared.accountId],
		references: [cupboardMeteredAccountsInHarnessShared.workspaceId, cupboardMeteredAccountsInHarnessShared.accountId]
	}),
}));

export const cupboardMeteredAccountsInHarnessSharedRelations = relations(cupboardMeteredAccountsInHarnessShared, ({many}) => ({
	cupboardFundedTurnsInHarnessShareds: many(cupboardFundedTurnsInHarnessShared),
}));

export const admissionRulesInHarnessSharedRelations = relations(admissionRulesInHarnessShared, ({one}) => ({
	dataSourcesInHarnessShared: one(dataSourcesInHarnessShared, {
		fields: [admissionRulesInHarnessShared.workspaceId, admissionRulesInHarnessShared.dataSourceId],
		references: [dataSourcesInHarnessShared.workspaceId, dataSourcesInHarnessShared.id]
	}),
}));

export const semanticCodeFunctionsInHarnessSharedRelations = relations(semanticCodeFunctionsInHarnessShared, ({one}) => ({
	semanticCodeFilesInHarnessShared: one(semanticCodeFilesInHarnessShared, {
		fields: [semanticCodeFunctionsInHarnessShared.workspaceId, semanticCodeFunctionsInHarnessShared.repositoryId, semanticCodeFunctionsInHarnessShared.embeddingProfile, semanticCodeFunctionsInHarnessShared.path],
		references: [semanticCodeFilesInHarnessShared.workspaceId, semanticCodeFilesInHarnessShared.repositoryId, semanticCodeFilesInHarnessShared.embeddingProfile, semanticCodeFilesInHarnessShared.path]
	}),
}));

export const semanticCodeFilesInHarnessSharedRelations = relations(semanticCodeFilesInHarnessShared, ({many}) => ({
	semanticCodeFunctionsInHarnessShareds: many(semanticCodeFunctionsInHarnessShared),
}));

export const potEvalScoresInHarnessSharedRelations = relations(potEvalScoresInHarnessShared, ({one}) => ({
	potEvalRunsInHarnessShared: one(potEvalRunsInHarnessShared, {
		fields: [potEvalScoresInHarnessShared.runId],
		references: [potEvalRunsInHarnessShared.runId]
	}),
}));

export const chatMessagesInHarnessSharedRelations = relations(chatMessagesInHarnessShared, ({one}) => ({
	dataSourcesInHarnessShared: one(dataSourcesInHarnessShared, {
		fields: [chatMessagesInHarnessShared.workspaceId, chatMessagesInHarnessShared.dataSourceId],
		references: [dataSourcesInHarnessShared.workspaceId, dataSourcesInHarnessShared.id]
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

export const triggerBindingsInHarnessSharedRelations = relations(triggerBindingsInHarnessShared, ({one, many}) => ({
	triggerRunsInHarnessShareds: many(triggerRunsInHarnessShared),
	goalsInHarnessShared: one(goalsInHarnessShared, {
		fields: [triggerBindingsInHarnessShared.goalId],
		references: [goalsInHarnessShared.id]
	}),
	triggerPackInstallationsInHarnessShared: one(triggerPackInstallationsInHarnessShared, {
		fields: [triggerBindingsInHarnessShared.packInstallationId],
		references: [triggerPackInstallationsInHarnessShared.id]
	}),
	harnessPlansInHarnessShared: one(harnessPlansInHarnessShared, {
		fields: [triggerBindingsInHarnessShared.workspaceId, triggerBindingsInHarnessShared.planHarnessSlug, triggerBindingsInHarnessShared.planSlug],
		references: [harnessPlansInHarnessShared.workspaceId, harnessPlansInHarnessShared.harnessSlug, harnessPlansInHarnessShared.planSlug]
	}),
	dataSourcesInHarnessShared: one(dataSourcesInHarnessShared, {
		fields: [triggerBindingsInHarnessShared.workspaceId, triggerBindingsInHarnessShared.sourceId],
		references: [dataSourcesInHarnessShared.workspaceId, dataSourcesInHarnessShared.id]
	}),
}));

export const triggerDeliveriesInHarnessSharedRelations = relations(triggerDeliveriesInHarnessShared, ({one, many}) => ({
	triggerRunsInHarnessShareds: many(triggerRunsInHarnessShared),
	datatypeRegistryInHarnessShared: one(datatypeRegistryInHarnessShared, {
		fields: [triggerDeliveriesInHarnessShared.workspaceId, triggerDeliveriesInHarnessShared.datatypeId],
		references: [datatypeRegistryInHarnessShared.workspaceId, datatypeRegistryInHarnessShared.id]
	}),
	dataSourcesInHarnessShared: one(dataSourcesInHarnessShared, {
		fields: [triggerDeliveriesInHarnessShared.workspaceId, triggerDeliveriesInHarnessShared.sourceId],
		references: [dataSourcesInHarnessShared.workspaceId, dataSourcesInHarnessShared.id]
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

export const workspaceGrantsInHarnessSharedRelations = relations(workspaceGrantsInHarnessShared, ({one}) => ({
	customerWorkspacesInHarnessShared: one(customerWorkspacesInHarnessShared, {
		fields: [workspaceGrantsInHarnessShared.workspaceId, workspaceGrantsInHarnessShared.organizationId, workspaceGrantsInHarnessShared.customerWorkspaceId],
		references: [customerWorkspacesInHarnessShared.workspaceId, customerWorkspacesInHarnessShared.organizationId, customerWorkspacesInHarnessShared.id]
	}),
}));

export const customerWorkspacesInHarnessSharedRelations = relations(customerWorkspacesInHarnessShared, ({one, many}) => ({
	workspaceGrantsInHarnessShareds: many(workspaceGrantsInHarnessShared),
	workspaceHostsInHarnessShared: one(workspaceHostsInHarnessShared, {
		fields: [customerWorkspacesInHarnessShared.workspaceId, customerWorkspacesInHarnessShared.hostedHostId],
		references: [workspaceHostsInHarnessShared.workspaceId, workspaceHostsInHarnessShared.id]
	}),
	workspaceHostOperationsInHarnessShareds: many(workspaceHostOperationsInHarnessShared),
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

export const triggerPackInstallationsInHarnessSharedRelations = relations(triggerPackInstallationsInHarnessShared, ({many}) => ({
	triggerBindingsInHarnessShareds: many(triggerBindingsInHarnessShared),
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

export const documentsInHarnessSharedRelations = relations(documentsInHarnessShared, ({one}) => ({
	documentPermissionListsInHarnessShared: one(documentPermissionListsInHarnessShared, {
		fields: [documentsInHarnessShared.workspaceId, documentsInHarnessShared.permissionListId],
		references: [documentPermissionListsInHarnessShared.workspaceId, documentPermissionListsInHarnessShared.id]
	}),
	usersInHarnessShared: one(usersInHarnessShared, {
		fields: [documentsInHarnessShared.userId],
		references: [usersInHarnessShared.id]
	}),
}));

export const personalVaultImportJobsInHarnessSharedRelations = relations(personalVaultImportJobsInHarnessShared, ({one}) => ({
	usersInHarnessShared: one(usersInHarnessShared, {
		fields: [personalVaultImportJobsInHarnessShared.userId],
		references: [usersInHarnessShared.id]
	}),
}));

export const daoHrContractsInHarnessSharedRelations = relations(daoHrContractsInHarnessShared, ({one}) => ({
	daoHrOffersInHarnessShared: one(daoHrOffersInHarnessShared, {
		fields: [daoHrContractsInHarnessShared.workspaceId, daoHrContractsInHarnessShared.daoSlug, daoHrContractsInHarnessShared.offerId],
		references: [daoHrOffersInHarnessShared.workspaceId, daoHrOffersInHarnessShared.daoSlug, daoHrOffersInHarnessShared.offerId]
	}),
}));

export const workspaceHostConnectionsInHarnessSharedRelations = relations(workspaceHostConnectionsInHarnessShared, ({many}) => ({
	workspaceHostsInHarnessShareds: many(workspaceHostsInHarnessShared),
}));