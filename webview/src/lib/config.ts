export const DEFAULT_BASE_URLS = {
	"openai-compatible": "https://api.openai.com/v1",
	anthropic: "https://api.anthropic.com",
} as const;

export const DEFAULT_MODELS = {
	"openai-compatible": "gpt-4.1",
	anthropic: "claude-sonnet-4-5",
} as const;

export const PROTOCOL_LABELS = {
	"openai-compatible": "OpenAI 兼容 · Chat Completions",
	anthropic: "Anthropic · Messages",
} as const;
