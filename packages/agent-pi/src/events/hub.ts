import { randomBytes } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type AgentEvent, type AgentEventStream, type ConversationId, type Harness, watchEvents } from "@earendil-works/pi-durable";
import { TasksDoc } from "../agent/tasks.ts";
import type { Logger } from "../util/log.ts";
import { type ClientEventBody, EventMapper, type MapperOptions, type TaskStatus } from "./mapper.ts";

/** `id` is `<epoch>-<seq>`: the epoch changes whenever a hub is recreated, so a stale id never resumes wrongly. */
export type ClientEvent = { readonly id: string; readonly body: ClientEventBody };

export type Subscriber = {
	readonly event: (event: ClientEvent) => void;
	/** The hub stopped: harness closing or the session closed. */
	readonly end: () => void;
};

export type Subscription = {
	/** Events to send before live ones: the missed ones after `lastEventId`, or a snapshot. */
	readonly initial: readonly ClientEvent[];
	unsubscribe(): void;
};

/** How a hub's mapper is configured, plus an optional transform of every client event (plugins' `mapEvent`). */
export type HubMapping = MapperOptions & {
	readonly transform?: (event: ClientEventBody) => ClientEventBody[];
	/** Sees every event as it happened, whatever `transform` makes of it. */
	readonly observe?: (event: ClientEventBody) => void;
	/** The turn of an input the conversation is answering. */
	readonly turn?: (input: number) => Promise<string | undefined>;
};

export type HubOptions = {
	/** Events kept for `Last-Event-ID` resume. Default 1024. */
	readonly bufferSize?: number;
	/** A hub with no subscribers and no run stops after this long. Default 60 s. */
	readonly idleMs?: number;
	/** A hub with no subscribers stops after this long even while a run goes on. Default 10 minutes. */
	readonly detachedMs?: number;
};

/**
 * One durable event stream per live session, fanned out to every subscriber: the prompt response, the GET stream, a
 * second device. Kept briefly after the last subscriber leaves, so a client that drops and reconnects resumes from
 * the buffer instead of a snapshot.
 */
export class SessionHub {
	readonly conversationId: ConversationId;
	readonly #stream: AgentEventStream;
	readonly #mapper: EventMapper;
	readonly #subscribers = new Set<Subscriber>();
	readonly #buffer: ClientEvent[] = [];
	readonly #bufferSize: number;
	readonly #idleMs: number;
	readonly #detachedMs: number;
	readonly #epoch = randomBytes(4).toString("hex");
	readonly #onStop: () => void;
	#seq = 0;
	#busy: boolean;
	#activeTools: string[];
	#inbox: { id: number; mode: string }[];
	/** Durable's snapshots do not cover tasks, so the hub keeps them for its own. */
	readonly #tasks = new Map<string, TaskStatus>();
	#idleTimer: ReturnType<typeof setTimeout> | undefined;
	#detachedSince: number | undefined;
	#stopped = false;
	#stopTasks: (() => Promise<unknown> | undefined) | undefined;

	private constructor(
		conversationId: ConversationId,
		stream: AgentEventStream,
		mapper: EventMapper,
		options: HubOptions,
		onStop: () => void,
	) {
		this.conversationId = conversationId;
		this.#stream = stream;
		this.#mapper = mapper;
		this.#bufferSize = options.bufferSize ?? 1024;
		this.#idleMs = options.idleMs ?? 60_000;
		this.#detachedMs = options.detachedMs ?? 600_000;
		this.#onStop = onStop;
		const snapshot = mapper.seed(stream.snapshot) as Extract<ClientEventBody, { type: "snapshot" }>;
		this.#busy = snapshot.busy;
		this.#activeTools = snapshot.activeTools;
		this.#inbox = snapshot.inbox;
	}

	static async open(
		harness: Harness,
		conversationId: ConversationId,
		mapping: HubMapping,
		options: HubOptions,
		log: Logger,
		onStop: () => void,
	): Promise<SessionHub> {
		const stream = await watchEvents(harness, conversationId, BACKGROUND_CONTEXT);
		const hub = new SessionHub(conversationId, stream, new EventMapper(mapping), options, onStop);
		const { transform, observe, turn } = mapping;
		// Followed through the events, not read from live state: a short run can end before its events get here.
		let input: number | undefined = stream.snapshot.run?.inputs.at(-1);
		// A turn failing to resolve must not stop the stream; the events go out without it.
		const resolveTurn = async () => hub.#mapper.setTurn(input === undefined ? undefined : await turn?.(input).catch(() => undefined));
		if (stream.snapshot.generation?.message !== undefined) await resolveTurn();
		const emit = (body: ClientEventBody) => {
			observe?.(body);
			// Snapshots carry the hub's own state; they are not for plugins to change.
			if (body.type === "snapshot") hub.#publish({ ...body, tasks: [...hub.#tasks.values()] });
			else if (transform === undefined) hub.#publish(body);
			else for (const mapped of transform(body)) hub.#publish(mapped);
		};
		stream.start(async (events) => {
			for (const event of events) {
				input = latestInput(event) ?? input;
				if (startsMessage(event)) await resolveTurn();
				for (const body of hub.#mapper.map(event)) emit(body);
			}
		});
		// Absent for a session without the document, such as a child: it has no tasks to report.
		const tasks = await harness.watchDoc(TasksDoc, conversationId, BACKGROUND_CONTEXT);
		hub.#stopTasks = () => tasks?.stop();
		for (const { id, name, status } of tasks?.value?.tasks ?? []) hub.#tasks.set(id, { taskId: id, name, status });
		tasks?.start(async (state) => {
			const current = state?.tasks ?? [];
			for (const id of hub.#tasks.keys()) if (!current.some((task) => task.id === id)) hub.#tasks.delete(id);
			for (const { id, name, status } of current) {
				if (hub.#tasks.get(id)?.status === status) continue;
				hub.#tasks.set(id, { taskId: id, name, status });
				emit({ type: "task.updated", taskId: id, name, status });
			}
		});
		void stream.closed.then(() => hub.stop()).catch((error: unknown) => {
			log.warn("hub.stream_failed", { conversationId, error: error instanceof Error ? error.message : String(error) });
			void hub.stop();
		});
		hub.#scheduleIdle();
		return hub;
	}

	get busy(): boolean {
		return this.#busy;
	}

	get stopped(): boolean {
		return this.#stopped;
	}

	subscribe(subscriber: Subscriber, lastEventId?: string): Subscription {
		this.#subscribers.add(subscriber);
		this.#detachedSince = undefined;
		clearTimeout(this.#idleTimer);
		const missed = this.#since(lastEventId);
		return {
			initial: missed ?? [this.#snapshot()],
			unsubscribe: () => {
				if (!this.#subscribers.delete(subscriber)) return;
				if (this.#subscribers.size === 0) {
					this.#detachedSince = Date.now();
					this.#scheduleIdle();
				}
			},
		};
	}

	async stop(): Promise<void> {
		if (this.#stopped) return;
		this.#stopped = true;
		clearTimeout(this.#idleTimer);
		this.#onStop();
		for (const subscriber of [...this.#subscribers]) subscriber.end();
		this.#subscribers.clear();
		await this.#stopTasks?.()?.catch(() => undefined);
		await this.#stream.stop().catch(() => undefined);
	}

	#publish(body: ClientEventBody): void {
		if (body.type === "run.started") this.#busy = true;
		if (body.type === "run.finished") this.#busy = false;
		if (body.type === "tools.active") this.#activeTools = body.names;
		if (body.type === "inbox") this.#inbox = body.items;
		if (body.type === "snapshot") {
			this.#busy = body.busy;
			this.#activeTools = body.activeTools;
			this.#inbox = body.inbox;
		}
		const event: ClientEvent = { id: `${this.#epoch}-${++this.#seq}`, body };
		this.#buffer.push(event);
		if (this.#buffer.length > this.#bufferSize) this.#buffer.shift();
		for (const subscriber of [...this.#subscribers]) subscriber.event(event);
		if (body.type === "run.finished") this.#scheduleIdle();
	}

	/** Buffered events after `lastEventId`, or undefined when it is absent, from another epoch, or already dropped. */
	#since(lastEventId: string | undefined): ClientEvent[] | undefined {
		if (lastEventId === undefined) return undefined;
		const [epoch, seqText] = lastEventId.split("-");
		const seq = Number(seqText);
		if (epoch !== this.#epoch || !Number.isInteger(seq) || seq > this.#seq) return undefined;
		const oldest = this.#seq - this.#buffer.length;
		if (seq < oldest) return undefined;
		return this.#buffer.slice(seq - oldest);
	}

	#snapshot(): ClientEvent {
		// Not buffered: it describes the moment of subscription, and its id lets the client resume from here.
		const partial = this.#mapper.partial;
		return {
			id: `${this.#epoch}-${this.#seq}`,
			body: {
				type: "snapshot",
				busy: this.#busy,
				activeTools: [...this.#activeTools],
				inbox: [...this.#inbox],
				tasks: [...this.#tasks.values()],
				...(partial === undefined ? {} : { partial }),
			},
		};
	}

	#scheduleIdle(): void {
		if (this.#stopped || this.#subscribers.size > 0) return;
		clearTimeout(this.#idleTimer);
		const detachedFor = this.#detachedSince === undefined ? 0 : Date.now() - this.#detachedSince;
		const delay = this.#busy ? Math.max(0, this.#detachedMs - detachedFor) : this.#idleMs;
		this.#idleTimer = setTimeout(() => {
			if (this.#subscribers.size > 0) return;
			if (this.#busy && Date.now() - (this.#detachedSince ?? Date.now()) < this.#detachedMs) {
				this.#scheduleIdle();
				return;
			}
			void this.stop();
		}, delay);
		this.#idleTimer.unref();
	}
}

/** The input an event places in the conversation: a run's newest, or a steer joining the run. */
function latestInput(event: AgentEvent): number | undefined {
	if (event.type === "run_start") return event.inputs.at(-1);
	if (event.type === "snapshot") return event.run?.inputs.at(-1);
	return event.type === "submission" && event.record.status === "placed" ? event.record.id : undefined;
}

/** Whether an event begins or resumes an assistant message, so the mapper needs its turn. */
function startsMessage(event: AgentEvent): boolean {
	if (event.type === "message_start") return event.message.role === "assistant";
	return event.type === "snapshot" && event.generation?.message !== undefined;
}

/** Opens at most one hub per conversation; concurrent callers share the opening. */
export class HubRegistry {
	readonly #harness: Harness;
	readonly #options: HubOptions;
	readonly #log: Logger;
	readonly #hubs = new Map<ConversationId, Promise<SessionHub>>();

	constructor(harness: Harness, options: HubOptions, log: Logger) {
		this.#harness = harness;
		this.#options = options;
		this.#log = log;
	}

	async get(conversationId: ConversationId, mapping: HubMapping): Promise<SessionHub> {
		const existing = this.#hubs.get(conversationId);
		if (existing !== undefined) {
			const hub = await existing;
			if (!hub.stopped) return hub;
		}
		const opening = SessionHub.open(this.#harness, conversationId, mapping, this.#options, this.#log, () => {
			if (this.#hubs.get(conversationId) === opening) this.#hubs.delete(conversationId);
		});
		this.#hubs.set(conversationId, opening);
		opening.catch(() => {
			if (this.#hubs.get(conversationId) === opening) this.#hubs.delete(conversationId);
		});
		return opening;
	}

	/** Stop a session's hub, ending its subscribers' streams. */
	async stop(conversationId: ConversationId): Promise<void> {
		const hub = this.#hubs.get(conversationId);
		this.#hubs.delete(conversationId);
		if (hub !== undefined) await (await hub).stop();
	}

	async stopAll(): Promise<void> {
		const hubs = [...this.#hubs.values()];
		this.#hubs.clear();
		await Promise.allSettled(hubs.map(async (hub) => (await hub).stop()));
	}
}
