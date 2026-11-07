import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { type Attributes, isSpanContextValid, ROOT_CONTEXT, SpanStatusCode, trace } from "@opentelemetry/api";

/**
 * Spans of the turn a client is tracing. A client names its turn with a W3C `traceparent` and this process adds to that
 * trace; nothing here depends on an SDK being installed, so without `setupTracing` the spans are no-ops and a
 * `traceparent` still passes through to the model gateway.
 */
const tracer = trace.getTracer("agent-pi");

/** Names a chat session on its spans. Each turn is its own trace; this is what finds all of a session's turns. */
export const SESSION_ATTRIBUTE = "t10.session.id";

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

export function validTraceparent(value: string): boolean {
	const match = TRACEPARENT.exec(value);
	return match !== null && !/^0+$/.test(match[1]!) && !/^0+$/.test(match[2]!);
}

/** The trace a `traceparent` belongs to. */
export function traceIdOf(traceparent: string | undefined): string | undefined {
	return traceparent === undefined ? undefined : TRACEPARENT.exec(traceparent)?.[1];
}

/** What a span may say about a failure. An error's message can quote a person's words, so it stays off the span. */
export function errorClass(error: unknown): string {
	return error instanceof Error ? error.name : "error";
}

export type TraceSpan = {
	/** This span as a parent for others, here or downstream; absent when there is no trace to be part of. */
	readonly traceparent: string | undefined;
	setAttributes(attributes: Attributes): void;
	/** Only the first call counts; an `error` marks the span failed. */
	end(error?: string): void;
};

export function startSpan(
	name: string,
	options: { readonly traceparent?: string | undefined; readonly attributes?: Attributes; readonly startTime?: number },
): TraceSpan {
	const match = options.traceparent === undefined ? null : TRACEPARENT.exec(options.traceparent);
	const parent = match === null
		? ROOT_CONTEXT
		: trace.setSpanContext(ROOT_CONTEXT, { traceId: match[1]!, spanId: match[2]!, traceFlags: Number.parseInt(match[3]!, 16), isRemote: true });
	const span = tracer.startSpan(
		name,
		{
			...(options.attributes === undefined ? {} : { attributes: options.attributes }),
			...(options.startTime === undefined ? {} : { startTime: options.startTime }),
		},
		parent,
	);
	const context = span.spanContext();
	const flags = context.traceFlags.toString(16).padStart(2, "0");
	return {
		traceparent: isSpanContextValid(context) ? `00-${context.traceId}-${context.spanId}-${flags}` : options.traceparent,
		setAttributes: (attributes) => void span.setAttributes(attributes),
		end: (error) => {
			if (!span.isRecording()) return;
			if (error !== undefined) span.setStatus({ code: SpanStatusCode.ERROR, message: error });
			span.end();
		},
	};
}

/**
 * Exports spans over OTLP/HTTP when `OTEL_EXPORTER_OTLP_ENDPOINT` names a collector (`http://host:4318`). Returns the
 * shutdown that flushes them, or `undefined` when tracing stays off.
 */
export function setupTracing(
	env: Readonly<Record<string, string | undefined>> = process.env,
	serviceName = "agent-pi",
): (() => Promise<void>) | undefined {
	const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;
	if (endpoint === undefined || endpoint === "") return undefined;
	const provider = new BasicTracerProvider({
		resource: resourceFromAttributes({ "service.name": env.OTEL_SERVICE_NAME ?? serviceName }),
		spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, "")}/v1/traces` }))],
	});
	trace.setGlobalTracerProvider(provider);
	return () => provider.shutdown();
}
