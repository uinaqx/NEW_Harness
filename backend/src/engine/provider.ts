/**
 * Harness backend — translate the app's model settings into an OpenCode config.
 *
 * The config is passed to the engine as `OPENCODE_CONFIG_CONTENT` (an inline
 * JSON environment variable), never written to a file, so the API key does not
 * land in any config artifact the engine might later persist.
 *
 * Protocol mapping (only these two are offered, per the plan):
 *   openai-compatible -> @ai-sdk/openai-compatible  (Chat Completions, NOT Responses)
 *   anthropic         -> @ai-sdk/anthropic          (Messages)
 */
import type { AppSettings } from "../app-settings";

export const PROVIDER_ID = "harness";

export function providerIdFor(profileId: string): string {
	return profileId === "default" ? PROVIDER_ID : `${PROVIDER_ID}_${profileId}`;
}

/** A second guard on top of the private chat directory: no model tools exist in Chat mode. */
export const CHAT_DISABLED_TOOLS: Record<string, boolean> = Object.fromEntries(
	["read", "edit", "write", "apply_patch", "bash", "glob", "grep", "list", "task", "todowrite", "todoread", "webfetch", "websearch", "lsp", "skill", "question"].map((name) => [name, false]),
);

/** A stable, readable model id even when the user typed something exotic. */
export function modelRef(model: string): string {
	return `${PROVIDER_ID}/${model}`;
}

export interface ProviderConfigOptions {
	settings: AppSettings;
	apiKey: string;
	profileKeys?: Record<string, string>;
}

export interface OpenCodeConfig {
	$schema: string;
	model: string;
	small_model: string;
	autoupdate: boolean;
	share: string;
	provider: Record<string, unknown>;
	permission: Record<string, unknown>;
	agent?: Record<string, unknown>;
}

export function buildOpenCodeConfig({ settings, apiKey, profileKeys = {} }: ProviderConfigOptions): OpenCodeConfig {
	const profiles = settings.profiles?.length ? settings.profiles : [{ id: "default", name: "默认 API", protocol: settings.protocol, baseUrl: settings.baseUrl, models: [settings.model] }];
	const primary = profiles.find((item) => item.id === settings.defaultProfileId) ?? profiles[0];
	const model = primary.models[0];
	const providers: Record<string, unknown> = {};
	for (const profile of profiles) {
		const isAnthropic = profile.protocol === "anthropic";
		providers[providerIdFor(profile.id)] = {
			npm: isAnthropic ? "@ai-sdk/anthropic" : "@ai-sdk/openai-compatible",
			name: profile.name,
			options: { baseURL: profile.baseUrl, apiKey: profileKeys[profile.id] ?? (profile.id === "default" ? apiKey : "") },
			models: Object.fromEntries(profile.models.map((id) => [id, {
				id, name: id, tool_call: true, reasoning: isAnthropic,
				limit: { context: 200_000, output: 32_000 },
			}])),
		};
	}

	return {
		$schema: "https://opencode.ai/config.json",
		model: `${providerIdFor(primary.id)}/${model}`,
		small_model: `${providerIdFor(primary.id)}/${model}`,
		autoupdate: false,
		share: "disabled",
		provider: providers,
		agent: {
			"harness-chat": {
				mode: "primary",
				description: "普通聊天，不访问文件、不执行命令或其他工具。",
				prompt: "你正在普通聊天模式。直接用文字回答用户。不能调用工具，不能读写本地文件或执行命令。",
				tools: { "*": false, ...CHAT_DISABLED_TOOLS },
				permission: { "*": "deny", read: "deny", edit: "deny", glob: "deny", grep: "deny", list: "deny", bash: "deny", task: "deny", skill: "deny", external_directory: "deny" },
			},
		},
		permission: {
			// Reads inside the workspace are allowed by default (engine default),
			// everything that mutates or executes asks unless the user opted out.
			edit: settings.autoApproveEdits ? "allow" : "ask",
			bash: settings.autoApproveCommands ? "allow" : "ask",
			// The workspace is described as a permission boundary, not an OS sandbox.
			external_directory: "ask",
			webfetch: "deny",
			doom_loop: "ask",
		},
	};
}

/** Redact the API key before anything derived from this config is logged. */
export function redactConfig(config: unknown): string {
	return JSON.stringify(config)
		.replace(/"apiKey":"[^"]*"/g, '"apiKey":"***"')
		.replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***");
}
