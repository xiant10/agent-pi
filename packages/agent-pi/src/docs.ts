/**
 * This repo's docs for coding agents, over MCP at `/docs/mcp`, as the t10 workspace's `contracts/docs/README.md`
 * describes: overview, search and read, and each doc as a resource. It serves only docs whose front matter says
 * `audience: consumer` and that aren't records, because the route takes no token.
 *
 * Run as `node packages/agent-pi/src/docs.ts <addr>`, it serves only that route, for the contract's suite.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DOCS_ROUTE = "/docs/mcp";

type Section = { heading: string; slug: string; level: number; start: number; end: number; text: string };
type Doc = { id: string; title: string; audience: string; kind: string; status: string; summary: string; body: string; sections: Section[] };
type Rpc = { jsonrpc?: string; id?: unknown; method?: string; params?: any };

const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_BODY = 64 * 1024;
const ORDER: Record<string, number> = { guide: 0, reference: 1, design: 2 };

/** A field of simple YAML front matter: a bare or double-quoted string. */
function field(frontMatter: string, key: string): string {
	const m = new RegExp(`^${key}:[ \\t]*(.*)$`, "m").exec(frontMatter);
	if (!m) return "";
	const raw = (m[1] ?? "").trim();
	if (raw.startsWith('"')) return JSON.parse(raw) as string;
	return raw.replace(/^'(.*)'$/, "$1");
}

const slug = (h: string) => h.toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, "").replaceAll(" ", "-");

function sections(body: string): Section[] {
	const out: Section[] = [];
	let fenced = false;
	let offset = 0;
	for (const line of body.split(/(?<=\n)/)) {
		const trimmed = line.trim();
		if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) fenced = !fenced;
		else if (!fenced) {
			const [, marks, heading] = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line.replace(/\n$/, "")) ?? [];
			if (marks !== undefined && heading !== undefined) out.push({ heading, slug: slug(heading), level: marks.length, start: offset, end: body.length, text: "" });
		}
		offset += line.length;
	}
	out.forEach((s, i) => {
		const next = out.slice(i + 1).find((n) => n.level <= s.level);
		s.end = next?.start ?? body.length;
		s.text = body.slice(s.start, out[i + 1]?.start ?? body.length);
	});
	return out;
}

/** Every served doc under `dir`, keyed by its path without `.md`. Records are never read. */
export function loadDocs(dir: string): Map<string, Doc> {
	const docs = new Map<string, Doc>();
	const walk = (d: string) => {
		for (const name of readdirSync(d).sort()) {
			const p = join(d, name);
			const rel = relative(dir, p).split(sep).join("/");
			if (statSync(p).isDirectory()) {
				if (rel !== "records") walk(p);
				continue;
			}
			if (!name.endsWith(".md")) continue;
			const text = readFileSync(p, "utf8").replaceAll("\r\n", "\n");
			if (!text.startsWith("---\n")) continue;
			const end = text.indexOf("\n---\n", 3);
			if (end < 0) throw new Error(`${rel}: front matter isn't closed`);
			const fm = text.slice(4, end);
			const doc = { id: rel.slice(0, -3), title: field(fm, "title"), audience: field(fm, "audience"), kind: field(fm, "kind"), status: field(fm, "status"), summary: field(fm, "summary") };
			if (doc.audience !== "consumer" || doc.status === "record" || doc.kind === "record") continue;
			const body = text.slice(end + 5).replace(/^\n+/, "");
			docs.set(doc.id, { ...doc, body, sections: sections(body) });
		}
	};
	walk(dir);
	return docs;
}

const terms = (q: string) => (q.toLowerCase().match(/[\p{L}\p{N}_./-]+/gu) ?? []).filter((w) => w.length > 1 || /[^\x00-\x7f]/.test(w));
const count = (text: string, t: string) => text.split(t).length - 1;

function snippet(text: string, ts: string[]): string {
	const lower = text.toLowerCase();
	const at = Math.min(...ts.map((t) => lower.indexOf(t)).filter((i) => i >= 0));
	const start = Math.max(at - 80, 0);
	const end = Math.min(start + 240, text.length);
	return `${start > 0 ? "…" : ""}${text.slice(start, end).split(/\s+/).filter(Boolean).join(" ")}${end < text.length ? "…" : ""}`;
}

export type DocsOptions = { readonly component: string; readonly summary: string; readonly version?: string; readonly dir: string };

/** Answers MCP over Streamable HTTP for `DOCS_ROUTE`: one JSON-RPC message per POST, no session, no token. */
export function docsHandler(options: DocsOptions): (req: IncomingMessage, res: ServerResponse) => void {
	const docs = loadDocs(options.dir);
	const version = options.version || "unknown";
	const ids = [...docs.keys()].sort((a, b) => (ORDER[docs.get(a)!.kind] ?? 3) - (ORDER[docs.get(b)!.kind] ?? 3) || a.localeCompare(b));
	const meta = (d: Doc) => ({ id: d.id, title: d.title, audience: d.audience, kind: d.kind, status: d.status, summary: d.summary });
	const result = (text: string, structuredContent: object) => ({ content: [{ type: "text", text }], structuredContent });
	const failure = (text: string) => ({ content: [{ type: "text", text }], isError: true });
	const headings = (d: Doc) => d.sections.map((s) => `${"#".repeat(s.level)} ${s.heading}`);
	const c = options.component;
	const object = (required: string[], properties: object) => ({ type: "object", properties, required, additionalProperties: false });
	const str = (description: string) => ({ type: "string", description });
	const tools = [
		{ name: "docs_overview", description: `What ${c} offers someone building on t10, its version, and every doc it serves with a one-line summary. Start here.`, inputSchema: object([], {}) },
		{
			name: "docs_search",
			description: `Search ${c}'s docs. Answers matching sections, best first, each with the id and section to pass to docs_read.`,
			inputSchema: object(["query"], {
				query: str("Words to look for. Every word must appear in a doc for it to match."),
				limit: { type: "integer", minimum: 1, maximum: 50, description: "At most this many results. Default 10." },
			}),
		},
		{
			name: "docs_read",
			description: `Read one of ${c}'s docs, whole or one section of it.`,
			inputSchema: object(["id"], {
				id: str('The doc\'s id, as docs_overview or docs_search gives it, such as "api".'),
				section: str('Optional. A heading, or its anchor such as "work-items". The section comes with its subsections.'),
			}),
		},
	].map((t) => ({ ...t, annotations: { readOnlyHint: true, openWorldHint: false } }));

	function search(q: string, limit: number) {
		const ts = terms(q);
		const hits: { id: string; section: string; title: string; snippet: string; score: number }[] = [];
		for (const d of docs.values()) {
			const whole = `${d.title}\n${d.summary}\n${d.body}`.toLowerCase();
			if (!ts.every((t) => whole.includes(t))) continue;
			const head = `${d.title} ${d.summary}`.toLowerCase();
			const parts = d.sections.length > 0 ? d.sections : [{ heading: "", slug: "", text: d.body } as Section];
			for (const s of parts) {
				let score = 0;
				for (const t of ts) {
					const n = count(s.text.toLowerCase(), t) + 3 * count(s.heading.toLowerCase(), t);
					if (n > 0) score += 100; // a section that has more of the words comes first
					score += n + 2 * count(head, t);
				}
				if (score === 0) continue;
				const title = s.heading === "" || s.heading === d.title ? d.title : `${d.title} › ${s.heading}`;
				hits.push({ id: d.id, section: s.slug, title, snippet: snippet(s.text, ts), score });
			}
		}
		hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id) || a.section.localeCompare(b.section));
		return hits.slice(0, limit);
	}

	function call(name: string, args: Record<string, unknown>): object | undefined {
		const text = (k: string): string | Error => {
			const v = args[k];
			if (v === undefined || v === null) return "";
			return typeof v === "string" ? v : new Error(`${k} must be a string`);
		};
		switch (name) {
			case "docs_overview": {
				let out = `# ${c}\n\n${options.summary}\n\nVersion ${version}. Read a doc with docs_read and its id.\n`;
				let last = "";
				const heads: Record<string, string> = { guide: "Guides", reference: "Reference", design: "Design" };
				for (const id of ids) {
					const d = docs.get(id)!;
					if (d.kind !== last) out += `\n## ${heads[d.kind] ?? d.kind}\n\n`;
					last = d.kind;
					out += `- ${d.id}: ${d.title}${d.status === "proposed" ? " (proposed, not built)" : ""}. ${d.summary}\n`;
				}
				return result(out, { component: c, summary: options.summary, version, docs: ids.map((id) => meta(docs.get(id)!)), api_operations: 0, agent_tools: false });
			}
			case "docs_search": {
				const q = text("query");
				if (q instanceof Error) return failure(q.message);
				if (terms(q).length === 0) return failure("query needs at least one word");
				const limit = typeof args.limit === "number" ? Math.min(Math.max(Math.trunc(args.limit), 1), 50) : 10;
				const results = search(q, limit);
				const body = results.length === 0 ? "No section matches. Try fewer or other words, or docs_overview for the list of docs." : results.map((h) => `- ${h.id}, section "${h.section}": ${h.title}\n  ${h.snippet}`).join("\n");
				return result(body, { results });
			}
			case "docs_read": {
				const id = text("id");
				const sec = text("section");
				if (id instanceof Error) return failure(id.message);
				if (sec instanceof Error) return failure(sec.message);
				const d = docs.get(id.replace(/^\//, "").replace(/\.md$/, ""));
				if (!d) return failure(`no doc "${id}". docs_overview lists them.`);
				const structured: Record<string, unknown> = { id: d.id, title: d.title, kind: d.kind, status: d.status, summary: d.summary, sections: headings(d) };
				let body = d.body;
				if (sec !== "") {
					const name = sec.trim().replace(/^#/, "");
					const s = d.sections.find((x) => x.slug === slug(name) || x.heading.toLowerCase() === name.toLowerCase());
					if (!s) return failure(`${d.id} has no section "${sec}". Its sections: ${headings(d).join("; ")}`);
					body = d.body.slice(s.start, s.end);
					structured.section = s.slug;
				}
				return result(`<!-- ${c}/${d.id} · ${d.kind} · ${d.status} -->\n\n${body}`, structured);
			}
			default:
				return undefined;
		}
	}

	function answer(m: Rpc): { result?: unknown; error?: { code: number; message: string } } {
		switch (m.method) {
			case "initialize": {
				const asked = m.params?.protocolVersion;
				return {
					result: {
						protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
						capabilities: { tools: {}, resources: {} },
						serverInfo: { name: c, title: `${c} docs`, version },
						instructions: `The docs of ${c} for people building on t10. Start with docs_overview, then docs_search or docs_read.`,
					},
				};
			}
			case "ping":
				return { result: {} };
			case "tools/list":
				return { result: { tools } };
			case "tools/call": {
				const name = m.params?.name;
				const args = m.params?.arguments ?? {};
				if (typeof name !== "string" || typeof args !== "object" || Array.isArray(args)) return { error: { code: -32602, message: "params need a tool name and object arguments" } };
				const out = call(name, args as Record<string, unknown>);
				return out === undefined ? { error: { code: -32602, message: "unknown tool" } } : { result: out };
			}
			case "resources/list":
				return { result: { resources: ids.map((id) => ({ uri: `t10://${c}/${id}`, name: id, title: docs.get(id)!.title, description: docs.get(id)!.summary, mimeType: "text/markdown" })) } };
			case "resources/read": {
				const uri = m.params?.uri;
				const prefix = `t10://${c}/`;
				const d = typeof uri === "string" && uri.startsWith(prefix) ? docs.get(uri.slice(prefix.length)) : undefined;
				if (!d) return { error: { code: -32002, message: "unknown resource" } };
				return { result: { contents: [{ uri, mimeType: "text/markdown", text: d.body }] } };
			}
			case "resources/templates/list":
				return { result: { resourceTemplates: [] } };
			default:
				return { error: { code: -32601, message: "unknown method" } };
		}
	}

	const send = (res: ServerResponse, status: number, body?: unknown) => {
		if (body === undefined) {
			res.writeHead(status);
			res.end();
			return;
		}
		res.writeHead(status, { "content-type": "application/json" });
		res.end(JSON.stringify(body));
	};

	return (req, res) => {
		if (req.method !== "POST") {
			res.writeHead(405, { allow: "POST", "content-type": "text/plain" });
			res.end("this route takes POST");
			return;
		}
		// The protocol asks a server to refuse what a browser page sent, so a local one can't be reached by DNS rebinding.
		if (req.headers.origin !== undefined) {
			res.writeHead(403, { "content-type": "text/plain" });
			res.end("this route doesn't serve browsers");
			return;
		}
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY) req.destroy();
			else chunks.push(chunk);
		});
		req.on("end", () => {
			let m: Rpc;
			try {
				m = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Rpc;
				if (typeof m !== "object" || m === null) throw new Error();
			} catch {
				return send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "the body isn't a JSON-RPC message" } });
			}
			if (m.id === undefined || m.id === null) return send(res, 202);
			if (m.jsonrpc !== "2.0" || typeof m.method !== "string") return send(res, 200, { jsonrpc: "2.0", id: m.id, error: { code: -32600, message: "not a JSON-RPC 2.0 request" } });
			send(res, 200, { jsonrpc: "2.0", id: m.id, ...answer(m) });
		});
	};
}

/** agent-pi's own docs: the repo's `docs/`, or `DOCS_DIR`. */
export function agentPiDocs(env: NodeJS.ProcessEnv = process.env) {
	return docsHandler({
		component: "agent-pi",
		summary:
			"A multi-user agent harness: build an agent from config, skills, MCP tools and plugins, and reach it over the /agent contract by text or voice, with durable sessions.",
		version: env.AGENT_PI_VERSION,
		dir: env.DOCS_DIR ?? fileURLToPath(new URL("../../../docs", import.meta.url)),
	});
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const [host, port] = (process.argv[2] ?? "").split(":");
	if (!host || !port) {
		console.error("usage: docs.ts <host:port>");
		process.exit(2);
	}
	const handle = agentPiDocs();
	createServer((req, res) => {
		if (new URL(req.url ?? "/", "http://localhost").pathname === DOCS_ROUTE) handle(req, res);
		else {
			res.writeHead(404);
			res.end();
		}
	}).listen(Number(port), host);
}
