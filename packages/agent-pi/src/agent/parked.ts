import type { Context } from "@earendil-works/chord";
import type { ConversationId, Harness, TaskId } from "@earendil-works/pi-durable";

/**
 * Live tasks the crash-loop guard parked in `conversationId`, or in a conversation one of its tasks owns, such as a
 * consulted expert's: a parked child leaves its parent waiting too. All conversations when `conversationId` is omitted.
 */
export async function parkedTasks(harness: Harness, conversationId: ConversationId | undefined, context: Context): Promise<TaskId[]> {
	const { tasks } = await harness.inspect(context);
	const parked = (conversation?: ConversationId) =>
		tasks
			.filter((task) => task.state.kind === "blocked" && task.state.reason === "restart_limit")
			.filter((task) => conversation === undefined || task.record.conversationId === conversation)
			.map((task) => task.record.id);
	if (conversationId === undefined || parked().length === 0) return parked();

	const scope = [conversationId];
	const found: TaskId[] = [];
	for (const conversation of scope) {
		found.push(...parked(conversation));
		const owners = tasks.filter((task) => task.record.conversationId === conversation).map((task) => task.record.id);
		const children = await harness.commit(async (tx) => {
			const pages = await Promise.all(owners.map((ownerTaskId) => tx.scanConversations({ ownerTaskId }, 16)));
			return pages.flatMap((page) => page.items.map((child) => child.id));
		}, context);
		scope.push(...children);
	}
	return found;
}
