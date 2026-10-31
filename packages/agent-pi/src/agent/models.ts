import type { ProviderStreams } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { createModels, createProvider, type Models, type MutableModels, type Provider } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import type { ModelRef } from "@earendil-works/pi-durable";
import { type IdentityHeaderNames, type IdentityHeaderResolver, IdentityRegistry, withIdentityHeaders, withModelSpans } from "../identity.ts";

export type ModelConfig =
	| { readonly provider: "anthropic" | "openai"; readonly modelId: string }
	| {
			readonly provider: "openai-compatible";
			readonly modelId: string;
			/** e.g. "https://gateway.internal/v1". */
			readonly baseUrl: string;
			/** Provider id models of one endpoint share. Default "openai-compatible". */
			readonly providerId?: string;
			/** Env var holding the bearer token. Default OPENAI_API_KEY. */
			readonly apiKeyEnv?: string;
			/** Default "chat-completions", which most gateways and vLLM implement. */
			readonly api?: "responses" | "chat-completions";
			readonly reasoning?: boolean;
			readonly contextWindow?: number;
			readonly maxOutputTokens?: number;
			/**
			 * Send who the call is for as HTTP headers, so a gateway can audit by session, turn, and user. Applies to every
			 * model of the endpoint, so models sharing a `providerId` must agree.
			 */
			readonly identityHeaders?: IdentityHeaderNames;
	  };

type CompatibleConfig = Extract<ModelConfig, { readonly provider: "openai-compatible" }>;

/** Builds pi-ai `Models` holding every configured model, and the `ModelRef` of each config name. */
export function createConfiguredModels(
	configs: Readonly<Record<string, ModelConfig>>,
	identity: IdentityRegistry = new IdentityRegistry(),
	resolver?: IdentityHeaderResolver,
): {
	readonly models: Models;
	readonly refs: ReadonlyMap<string, ModelRef>;
} {
	const models: MutableModels = createModels();
	const refs = new Map<string, ModelRef>();
	const compatible = new Map<string, CompatibleConfig[]>();
	for (const [name, config] of Object.entries(configs)) {
		if (config.provider === "openai-compatible") {
			const providerId = config.providerId ?? "openai-compatible";
			const group = compatible.get(providerId) ?? [];
			group.push(config);
			compatible.set(providerId, group);
			refs.set(name, { provider: providerId, modelId: config.modelId });
		} else {
			if (models.getProvider(config.provider) === undefined) {
				models.setProvider(config.provider === "anthropic" ? anthropicProvider() : openaiProvider());
			}
			refs.set(name, { provider: config.provider, modelId: config.modelId });
		}
	}
	for (const [providerId, group] of compatible) models.setProvider(compatibleProvider(providerId, group, identity, resolver));
	for (const [name, ref] of refs) {
		if (models.getModel(ref.provider, ref.modelId) === undefined) {
			throw new Error(`model "${name}": ${ref.provider}/${ref.modelId} is not a known model of that provider`);
		}
	}
	return { models, refs };
}

/** One OpenAI-compatible endpoint; every model of the group must share its base URL, key, and wire protocol. */
function compatibleProvider(providerId: string, group: readonly CompatibleConfig[], identity: IdentityRegistry, resolver?: IdentityHeaderResolver): Provider {
	const first = group[0]!;
	const api = first.api ?? "chat-completions";
	const envVar = first.apiKeyEnv ?? "OPENAI_API_KEY";
	for (const config of group) {
		if (config.baseUrl !== first.baseUrl || (config.api ?? "chat-completions") !== api || (config.apiKeyEnv ?? "OPENAI_API_KEY") !== envVar) {
			throw new Error(`models of provider "${providerId}" must share baseUrl, api, and apiKeyEnv; set providerId to separate them`);
		}
	}
	const headerNames = first.identityHeaders;
	for (const config of group) {
		if (JSON.stringify(config.identityHeaders) !== JSON.stringify(headerNames)) {
			throw new Error(`models of provider "${providerId}" must share identityHeaders; set providerId to separate them`);
		}
	}
	const withIdentity = (streams: ProviderStreams) =>
		withModelSpans(headerNames === undefined ? streams : withIdentityHeaders(streams, identity, headerNames, resolver), identity, headerNames !== undefined);
	const wire = api === "responses" ? "openai-responses" : "openai-completions";
	return createProvider({
		id: providerId,
		name: providerId,
		baseUrl: first.baseUrl,
		auth: {
			apiKey: {
				name: `${providerId} API key`,
				resolve: async ({ ctx, credential, signal }) => {
					signal.throwIfAborted();
					if (credential?.key) return { auth: { apiKey: credential.key }, source: "stored credential" };
					const value = await ctx.env(envVar);
					return value ? { auth: { apiKey: value }, source: envVar } : undefined;
				},
			},
		},
		models: group.map((config) => ({
			id: config.modelId,
			name: config.modelId,
			api: wire,
			provider: providerId,
			baseUrl: config.baseUrl,
			input: ["text", "image"],
			reasoning: config.reasoning ?? false,
			// Send the system prompt as a leading role "system" message; many gateways reject "developer".
			compat: { supportsDeveloperRole: false },
			contextWindow: config.contextWindow ?? 128_000,
			maxTokens: config.maxOutputTokens ?? 4_096,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		})),
		api: withIdentity(api === "responses" ? openAIResponsesApi() : openAICompletionsApi()),
	});
}
