import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadDocs } from "../src/docs.ts";

describe("docs at /docs/mcp", () => {
	// The image serves these, so broken front matter must fail here, not at startup.
	it("serves the repo's consumer docs and nothing else", () => {
		const docs = loadDocs(fileURLToPath(new URL("../../../docs", import.meta.url)));
		expect(docs.has("api")).toBe(true);
		expect(docs.has("guides/developer-guide")).toBe(true);
		expect(docs.has("design")).toBe(false); // for contributors
		for (const doc of docs.values()) expect(doc.audience).toBe("consumer");
	});
});
