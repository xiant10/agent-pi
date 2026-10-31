import { definePlugin } from "../types.ts";

/**
 * One log line per settled run: who asked, what answered it (the model or a plugin), and how it ended. Replace the log
 * call with a write to your analytics or CRM; `afterRun` runs in the background and never delays the answer.
 */
export const audit = definePlugin({
	name: "audit",
	sessionCreated: (session) => {
		session.log.info("audit.session_created", { sessionId: session.sessionId, userId: session.userId, profile: session.profile.name });
	},
	afterRun: (run) => {
		run.log.info("audit.run", {
			sessionId: run.sessionId,
			turnId: run.turnId,
			userId: run.userId,
			userName: run.userName,
			tenantId: run.tenantId,
			profile: run.profile.name,
			answeredBy: run.answeredBy,
			status: run.status,
			reason: run.reason,
			chars: run.text?.length ?? 0,
		});
	},
});
