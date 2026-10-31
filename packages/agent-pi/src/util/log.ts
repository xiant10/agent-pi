type Level = "debug" | "info" | "warn" | "error";
type Fields = Readonly<Record<string, unknown>>;

export interface Logger {
	debug(event: string, fields?: Fields): void;
	info(event: string, fields?: Fields): void;
	warn(event: string, fields?: Fields): void;
	error(event: string, fields?: Fields): void;
}

const RANK: Readonly<Record<Level, number>> = { debug: 10, info: 20, warn: 30, error: 40 };

/** One JSON object per line on stdout, for container log collectors. `base` fields go on every line. */
export function createLogger(minimum: Level = "info", write: (line: string) => void = console.log, base?: Fields): Logger {
	const emit = (level: Level, event: string, fields?: Fields) => {
		if (RANK[level] < RANK[minimum]) return;
		write(JSON.stringify({ time: new Date().toISOString(), level, event, ...base, ...fields }));
	};
	return {
		debug: (event, fields) => emit("debug", event, fields),
		info: (event, fields) => emit("info", event, fields),
		warn: (event, fields) => emit("warn", event, fields),
		error: (event, fields) => emit("error", event, fields),
	};
}

export const SILENT_LOGGER: Logger = createLogger("error", () => undefined);
