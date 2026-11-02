import { readFile } from "node:fs/promises";
import type { AuthProvider } from "@earendil-works/pi-mcp";

/** Where a `bearer` server's token comes from: written into the config, or a file that is re-read as it changes. */
export type BearerSource = { readonly token: string } | { readonly tokenFile: string };

const FILE_CACHE_MS = 5_000;

/**
 * Supplies an external server's token. A file is re-read at most every few seconds, and at once after a 401, so a
 * rotated secret (a mounted Kubernetes secret, say) takes effect without a restart.
 */
export function bearerProvider(source: BearerSource, now: () => number = Date.now): AuthProvider {
	if ("token" in source) return { token: async () => source.token };
	let cached: { token: string; at: number } | undefined;
	const read = async () => {
		const token = (await readFile(source.tokenFile, "utf8")).trim();
		if (token === "") throw new Error(`MCP token file ${source.tokenFile} is empty`);
		cached = { token, at: now() };
		return token;
	};
	return {
		token: async () => (cached !== undefined && now() - cached.at < FILE_CACHE_MS ? cached.token : read()),
		// The rejected token is stale only if the file has not already been re-read since.
		onUnauthorized: async (context) => {
			if (cached === undefined || context.token === undefined || context.token === cached.token) await read();
		},
	};
}
