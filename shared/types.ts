/**
 * Harness — shared types used by both the Bun backend and the Vite frontend.
 * Kept deliberately small and free of any @cline/* dependency.
 */

export type ChatSessionStatus =
	| "idle"
	| "starting"
	| "running"
	| "stopping"
	| "completed"
	| "cancelled"
	| "failed"
	| "error";

export type ChatMessageRole =
	| "user"
	| "assistant"
	| "tool"
	| "system"
	| "status"
	| "error";

export interface ChatMessageMeta {
	stream?: "stdout" | "stderr";
	toolName?: string;
	durationMs?: number;
	toolCallId?: string;
	toolOutput?: string;
	toolOutputTruncated?: boolean;
	/** Assistant turn's full tool_calls, replayed back to the model on resume. */
	toolCalls?: Array<{
		id: string;
		type: "function";
		function: { name: string; arguments: string };
	}>;
	/** "tool_call_start" | "tool_call_end" | "tool_call_interrupted" */
	hookEventName?: string;
	iteration?: number;
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	totalCost?: number;
	providerId?: string;
	modelId?: string;
	messageKind?: string;
	displayRole?: string;
	reason?: string;
	/** Engine-reported exit code for a command node. */
	exitCode?: number;
	/** Short label the engine attached to the tool call (path / command). */
	title?: string;
	/** Node phase mirrored from the engine's tool state machine. */
	phase?: "pending" | "running" | "success" | "failure" | "cancelled";
}

export interface ChatMessage {
	id: string;
	sessionId: string | null;
	role: ChatMessageRole;
	content: string;
	reasoning?: string;
	reasoningRedacted?: boolean;
	createdAt: number;
	meta?: ChatMessageMeta;
}

export interface ChatSessionConfig {
	sessionId?: string;
	kind?: "work" | "chat";
	profileId?: string;
	workspaceRoot: string;
	cwd?: string;
	/** Always "openai-compatible" in this build. */
	provider: string;
	model: string;
	mode: "act" | "plan";
	goal?: string;
	apiKey: string;
	/** OpenAI-compatible base URL, e.g. https://api.openai.com/v1 */
	baseUrl?: string;
	systemPrompt?: string;
	rules?: string;
	maxIterations?: number;
	thinking?: boolean;
	reasoningEffort?: "low" | "medium" | "high" | "xhigh";
	enableTools: boolean;
	autoApproveTools?: boolean;
}

export interface ChatSummary {
	toolCalls: number;
	tokensIn: number;
	tokensOut: number;
}

export interface SessionRecord {
	id: string;
	createdAt: number;
	updatedAt: number;
	status: ChatSessionStatus;
	config: ChatSessionConfig;
	/** Rolling transcript of messages persisted to disk. */
	messages: ChatMessage[];
	summary: ChatSummary;
}

/* ------------------------------------------------------------------ */
/* Transport protocol (identical shape to the upstream desktop app so  */
/* the extracted canvas / future components stay drop-in compatible). */
/* ------------------------------------------------------------------ */

export interface DesktopTransportRequest {
	type: "command";
	id: string;
	command: string;
	args?: Record<string, unknown>;
}

export interface DesktopTransportResponse {
	type: "response";
	id: string;
	ok: boolean;
	result?: unknown;
	error?: string;
}

export interface DesktopTransportEvent {
	type: "event";
	event: { name: string; payload: unknown };
}

export type DesktopTransportMessage =
	| DesktopTransportResponse
	| DesktopTransportEvent;

export type DesktopTransportState =
	| "connecting"
	| "reconnecting"
	| "connected"
	| "unavailable";

/** A single streamed chunk for the `chat_event` transport event. */
export interface AgentChunkEvent {
	sessionId: string;
	/** chat_text | chat_reasoning | chat_tool_call_start | chat_tool_call_update | chat_tool_call_end | chat_usage | chat_done | chat_queued_prompt_start */
	stream: string;
	/** JSON string for structured streams, plain text for chat_text/chat_reasoning. */
	chunk: string;
	ts: number;
	index?: number;
	/**
	 * Identifies the backend process that numbered this chunk. `index` restarts
	 * whenever the backend does, so a changed `boot` means the counter reset.
	 */
	boot?: string;
}

export interface ToolApprovalRequestItem {
	requestId: string;
	sessionId: string;
	createdAt: string;
	toolCallId: string;
	toolName: string;
	input?: unknown;
	iteration?: number;
	/** Readable one-line description of what is being authorised (path, command). */
	summary?: string;
}

export interface ProcessContext {
	workspaceRoot: string;
	cwd: string;
	homeDir?: string;
	platform?: string;
	appVersion?: string;
}

/** chat_done payload. */
export interface ChatDonePayload {
	reason: "completed" | "aborted" | "error" | "max_iterations";
	text: string;
}

/** chat_tool_call_start/update/end payloads (JSON-encoded in chunk). */
export interface ToolCallStartPayload {
	toolCallId?: string;
	toolName?: string;
	input?: unknown;
}
export interface ToolCallUpdatePayload {
	toolCallId?: string;
	toolName?: string;
	update?: { stream?: "stdout" | "stderr"; chunk?: string; detachable?: boolean; truncated?: boolean };
}
export interface ToolCallEndPayload {
	toolCallId?: string;
	toolName?: string;
	input?: unknown;
	output?: unknown;
	error?: string;
	durationMs?: number;
	/** Process exit code when the engine reported one (non-zero means failure). */
	exitCode?: number;
	/** Short human label the engine attached (file path, command, ...). */
	title?: string;
}
export interface ChatUsagePayload {
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cost?: number;
}

/* ------------------------------------------------------------------ */
/* Engine + settings contracts (Harness-side, never raw engine types)   */
/* ------------------------------------------------------------------ */

export type EngineState = "stopped" | "starting" | "running" | "crashed" | "failed";

export interface EngineStatusPayload {
	state: EngineState;
	instanceId: string;
	version: string;
	url: string | null;
	port: number | null;
	pid: number | null;
	startedAt: number | null;
	restarts: number;
	lastError: string | null;
	binary: { path: string; source: string; sha256: string; verified: boolean } | null;
	authMode: "password";
}

export type ProviderProtocol = "openai-compatible" | "anthropic";

export interface ApiProfilePayload {
	id: string;
	name: string;
	protocol: ProviderProtocol;
	baseUrl: string;
	models: string[];
	hasApiKey: boolean;
	apiKeyMask: string | null;
}

export interface ModelSettingsPayload {
	profiles: ApiProfilePayload[];
	defaultProfileId: string;
	protocol: ProviderProtocol;
	baseUrl: string;
	model: string;
	lastWorkspace: string;
	autoApproveEdits: boolean;
	autoApproveCommands: boolean;
	theme: "dark" | "light";
	legacyMigratedAt?: number;
	/** Always empty: the key never travels to the webview. */
	apiKey: "";
	hasApiKey: boolean;
	apiKeyMask: string | null;
}

export interface ConnectionTestResult {
	ok: boolean;
	/** "ok" | "auth" | "model-not-found" | "protocol-mismatch" | "network" | "engine-timeout" | ... */
	kind: string;
	message: string;
	detail?: string;
	latencyMs: number;
}

export interface FileDiffEntryPayload {
	file: string;
	patch: string;
	additions: number;
	deletions: number;
	status: "added" | "modified" | "deleted" | "unknown";
	unavailable?: string;
}

export interface ToolNodePayload {
	toolCallId: string;
	toolName: string;
	phase: "pending" | "running" | "success" | "failure" | "cancelled";
	input: unknown;
	output?: string;
	error?: string;
	title?: string;
	startedAt?: number;
	endedAt?: number;
	exitCode?: number;
}

export interface AppInfoPayload {
	appVersion: string;
	engineVersion: string;
	engineUpstream: string;
	engineSdk: string;
	dataDir: string;
	port: number | null;
	instanceId: string | null;
	credentialsOsProtected: boolean;
	dev: boolean;
}

export interface SessionListItemPayload {
	id: string;
	kind?: "work" | "chat";
	profileId?: string;
	createdAt: number;
	updatedAt: number;
	status: ChatSessionStatus;
	workspaceRoot: string;
	model: string;
	title: string;
	customTitle?: string;
	pinned?: boolean;
	legacy: boolean;
	summary: ChatSummary;
	lastMessage?: string;
}

export interface ProjectListItemPayload {
	id: string;
	workspaceRoot: string;
	lastOpenedAt: number;
	name?: string;
}
