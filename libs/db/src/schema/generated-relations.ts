import { relations } from "drizzle-orm/relations";
import { operator_conversationsInHarness_shared, operator_turnsInHarness_shared, messagesInPapercup_shared, message_commentsInPapercup_shared, message_recipientsInPapercup_shared, goalsInHarness_shared, projectsInHarness_shared, project_spec_revisionsInHarness_shared, mobile_devicesInHarness_shared, mobile_push_tokensInHarness_shared } from "./schema";

export const operator_turnsInHarness_sharedRelations = relations(operator_turnsInHarness_shared, ({one}) => ({
	operator_conversationsInHarness_shared: one(operator_conversationsInHarness_shared, {
		fields: [operator_turnsInHarness_shared.conversation_id],
		references: [operator_conversationsInHarness_shared.id]
	}),
}));

export const operator_conversationsInHarness_sharedRelations = relations(operator_conversationsInHarness_shared, ({many}) => ({
	operator_turnsInHarness_shareds: many(operator_turnsInHarness_shared),
}));

export const message_commentsInPapercup_sharedRelations = relations(message_commentsInPapercup_shared, ({one}) => ({
	messagesInPapercup_shared: one(messagesInPapercup_shared, {
		fields: [message_commentsInPapercup_shared.message_id],
		references: [messagesInPapercup_shared.id]
	}),
}));

export const messagesInPapercup_sharedRelations = relations(messagesInPapercup_shared, ({many}) => ({
	message_commentsInPapercup_shareds: many(message_commentsInPapercup_shared),
	message_recipientsInPapercup_shareds: many(message_recipientsInPapercup_shared),
}));

export const message_recipientsInPapercup_sharedRelations = relations(message_recipientsInPapercup_shared, ({one}) => ({
	messagesInPapercup_shared: one(messagesInPapercup_shared, {
		fields: [message_recipientsInPapercup_shared.message_id],
		references: [messagesInPapercup_shared.id]
	}),
}));

export const goalsInHarness_sharedRelations = relations(goalsInHarness_shared, ({one, many}) => ({
	goalsInHarness_shared: one(goalsInHarness_shared, {
		fields: [goalsInHarness_shared.parent_id],
		references: [goalsInHarness_shared.id],
		relationName: "goalsInHarness_shared_parent_id_goalsInHarness_shared_id"
	}),
	goalsInHarness_shareds: many(goalsInHarness_shared, {
		relationName: "goalsInHarness_shared_parent_id_goalsInHarness_shared_id"
	}),
}));

export const project_spec_revisionsInHarness_sharedRelations = relations(project_spec_revisionsInHarness_shared, ({one}) => ({
	projectsInHarness_shared: one(projectsInHarness_shared, {
		fields: [project_spec_revisionsInHarness_shared.project_id],
		references: [projectsInHarness_shared.id]
	}),
}));

export const projectsInHarness_sharedRelations = relations(projectsInHarness_shared, ({many}) => ({
	project_spec_revisionsInHarness_shareds: many(project_spec_revisionsInHarness_shared),
}));

export const mobile_push_tokensInHarness_sharedRelations = relations(mobile_push_tokensInHarness_shared, ({one}) => ({
	mobile_devicesInHarness_shared: one(mobile_devicesInHarness_shared, {
		fields: [mobile_push_tokensInHarness_shared.device_id],
		references: [mobile_devicesInHarness_shared.device_id]
	}),
}));

export const mobile_devicesInHarness_sharedRelations = relations(mobile_devicesInHarness_shared, ({many}) => ({
	mobile_push_tokensInHarness_shareds: many(mobile_push_tokensInHarness_shared),
}));