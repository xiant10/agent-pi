/** A failure the client caused or can act on; carries its HTTP status and JSON-RPC code. */
export class AppError extends Error {
	readonly code: string;
	readonly status: number;
	readonly rpcCode: number;
	readonly headers: Readonly<Record<string, string>>;

	constructor(
		code: string,
		status: number,
		rpcCode: number,
		message: string,
		headers: Readonly<Record<string, string>> = {},
	) {
		super(message);
		this.name = "AppError";
		this.code = code;
		this.status = status;
		this.rpcCode = rpcCode;
		this.headers = headers;
	}
}

export const RPC = {
	parseError: -32700,
	invalidRequest: -32600,
	methodNotFound: -32601,
	invalidParams: -32602,
	internal: -32603,
	unauthorized: -32001,
	forbidden: -32003,
	notFound: -32004,
	busy: -32009,
	misdirected: -32021,
	rejected: -32022,
	rateLimited: -32029,
} as const;

export const invalidParams = (message: string) => new AppError("invalid_params", 400, RPC.invalidParams, message);

/** Unknown, closed, and other users' sessions all read as not found, so a session's existence is not revealed. */
export const sessionNotFound = () => new AppError("session_not_found", 404, RPC.notFound, "session not found");

export const rateLimited = (message: string, retryAfterSec: number) =>
	new AppError("rate_limited", 429, RPC.rateLimited, message, { "retry-after": String(retryAfterSec) });
