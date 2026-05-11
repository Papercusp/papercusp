import { relations } from "drizzle-orm/relations";
import { backupSnapshotsInHarnessShared, backupEventsInHarnessShared, operatorConversationsInHarnessShared, operatorTurnsInHarnessShared, messagesInPapercupShared, messageCommentsInPapercupShared, messageRecipientsInPapercupShared, goalsInHarnessShared, projectsInHarnessShared, projectSpecRevisionsInHarnessShared, mobileDevicesInHarnessShared, mobilePushTokensInHarnessShared } from "./generated";

export const backupEventsInHarnessSharedRelations = relations(backupEventsInHarnessShared, ({one}) => ({
	backupSnapshotsInHarnessShared: one(backupSnapshotsInHarnessShared, {
		fields: [backupEventsInHarnessShared.snapshotId],
		references: [backupSnapshotsInHarnessShared.id]
	}),
}));

export const backupSnapshotsInHarnessSharedRelations = relations(backupSnapshotsInHarnessShared, ({many}) => ({
	backupEventsInHarnessShareds: many(backupEventsInHarnessShared),
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

export const messageRecipientsInPapercupSharedRelations = relations(messageRecipientsInPapercupShared, ({one}) => ({
	messagesInPapercupShared: one(messagesInPapercupShared, {
		fields: [messageRecipientsInPapercupShared.messageId],
		references: [messagesInPapercupShared.id]
	}),
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

export const projectSpecRevisionsInHarnessSharedRelations = relations(projectSpecRevisionsInHarnessShared, ({one}) => ({
	projectsInHarnessShared: one(projectsInHarnessShared, {
		fields: [projectSpecRevisionsInHarnessShared.projectId],
		references: [projectsInHarnessShared.id]
	}),
}));

export const projectsInHarnessSharedRelations = relations(projectsInHarnessShared, ({many}) => ({
	projectSpecRevisionsInHarnessShareds: many(projectSpecRevisionsInHarnessShared),
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