/**
 * Harness backend — the unified engine adapter.
 *
 * This is the only module that knows OpenCode exists. Everything above it
 * (transport, sessions, the webview protocol) talks in Harness terms.
 *
 * Plan mapping:
 *   启动与关闭引擎   start()/stop()/restart()
 *   读取引擎状态     status()
 *   会话 CRUD        createSession/listSessions/readMessages/deleteSession
 *   发送用户消息     prompt()
 *   停止当前任务     stopTask()
 *   回复授权请求     replyPermission()
 *   订阅会话事件     EventHub (SSE + reconnect + resync)
 *   读取文件差异     readDiffs()
 *   保存与测试配置   testConnection()
 */
import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import type { ChatMessage, ChatSessionStatus, ToolApprovalRequestItem } from "../../../shared/types";
import { ENGINE_PROMPT_TIMEOUT_MS, paths } from "../config";
import type { AppSettings } from "../app-settings";
import { proxyForUrl } from "../network-proxy";
import { call, dirQuery, engineClient, forgetClients, type OpencodeClient } from "./client";
import { classifyEngineError, engineError, redactText, userError, type EngineFailure } from "./errors";
import { EventNormalizer, type NormalizedEvent, type ToolNodeSnapshot } from "./normalize";
import { ENGINE_VERSION } from "./pin";
import { EngineProcess, type EngineStatus } from "./process";
import { CHAT_DISABLED_TOOLS, providerIdFor } from "./provider";

export interface FileDiffEntry {
	file: string;
	patch: string;
	additions: number;
	deletions: number;
	status: "added" | "modified" | "deleted" | "unknown";
	/** Set when the file is binary / the patch is unavailable. */
	unavailable?: string;
}

export interface EngineSessionSummary {
	id: string;
	title: string;
	directory: string;
	createdAt: number;
	updatedAt: number;
	status: ChatSessionStatus;
	model: string;
	summary: { additions: number; deletions: number; files: number };
}

export interface RunHandle {
	sessionId: string;
	directory: string;
	startedAt: number;
}

export type ChunkSink = (sessionId: string, stream: string, chunk: string, index: number) => void;
export type StatusSink = (sessionId: string, status: ChatSessionStatus) => void;
export type ApprovalSink = (sessionId: string, approvals: ToolApprovalRequestItem[]) => void;
export type EngineStateSink = (status: EngineStatus) => void;

interface Runtime {
	sessionId: string;
	directory: string;
	kind: "work" | "chat";
	normalizer: EventNormalizer;
	status: ChatSessionStatus;
	approvals: ToolApprovalRequestItem[];
	nodes: ToolNodeSnapshot[];
	chunkIndex: number;
	runAbort?: AbortController;
	/** Set when the engine died mid-turn so the UI can say "interrupted". */
	interrupted?: string;
	done: Promise<void>;
	resolveDone?: () => void;
}

interface SdkResult<T> {
	data?: T;
	error?: unknown;
	response?: Response;
}

const SSE_BACKOFF_MS = [400, 900, 1800, 3600, 6000];

export class HarnessEngine {
	readonly process = new EngineProcess();
	private settings: AppSettings;
	private apiKey: string;
	private profileKeys: Record<string, string> = {};
	private runtimes = new Map<string, Runtime>();
	/** Directory -> SSE subscription bookkeeping. */
	private subscriptions = new Map<string, { abort: AbortController; attempt: number; lastEvent: number; startedAt: number; alive: boolean }>();
	private activeRun: string | null = null;
	private chunkSink: ChunkSink = () => {};
	private statusSink: StatusSink = () => {};
	private approvalSink: ApprovalSink = () => {};
	private stateSink: EngineStateSink = () => {};
	private diagnostics: string[] = [];
	/**
	 * Identity of the provider config the running engine was spawned with.
	 * OpenCode resolves models from the config it booted with, so a change to the
	 * protocol / base URL / model / key requires a fresh engine — but never while
	 * a turn is in flight. That is what makes "changes apply from the next turn
	 * without interrupting the current task" true.
	 */
	private configFingerprint: string | null = null;
	private pendingReload = false;
	private reloadPromise: Promise<void> | null = null;
	/** In-flight startup, so concurrent callers share one engine launch. */
	private startPromise: Promise<EngineStatus> | null = null;

	constructor(settings: AppSettings, apiKey: string, profileKeys: Record<string, string> = {}) {
		this.settings = settings;
		this.apiKey = apiKey;
		this.profileKeys = profileKeys;
		this.process.onChange((status) => {
			this.stateSink(status);
			if (status.state === "crashed" || status.state === "failed") this.markAllInterrupted(status.lastError ?? "引擎已退出");
		});
	}

	private fingerprint(settings: AppSettings, apiKey: string, profileKeys: Record<string, string>): string {
		return createHash("sha256").update(JSON.stringify([settings.profiles, settings.defaultProfileId, apiKey, profileKeys, settings.autoApproveEdits, settings.autoApproveCommands])).digest("hex");
	}

	bindSinks(sinks: { chunk: ChunkSink; status: StatusSink; approvals: ApprovalSink; engine: EngineStateSink }): void {
		this.chunkSink = sinks.chunk;
		this.statusSink = sinks.status;
		this.approvalSink = sinks.approvals;
		this.stateSink = sinks.engine;
	}

	/**
	 * Adopt new model settings. If the engine is already running with a different
	 * provider identity, schedule a reload: immediately when idle, or after the
	 * current turn finishes when a task is in flight.
	 */
	updateCredentials(settings: AppSettings, apiKey: string, profileKeys: Record<string, string> = {}): void {
		const previous = this.configFingerprint;
		this.settings = settings;
		this.apiKey = apiKey;
		this.profileKeys = profileKeys;
		const next = this.fingerprint(settings, apiKey, profileKeys);
		if (this.process.status().state !== "running") {
			this.configFingerprint = next;
			return;
		}
		if (previous !== null && previous !== next) {
			this.requestConfigReload();
		}
		this.configFingerprint = next;
	}

	private requestConfigReload(): void {
		if (this.activeRun) {
			this.pendingReload = true;
			this.note("provider settings changed while a task is running; reload deferred to the next turn");
			return;
		}
		void this.reloadNow().catch(() => {});
	}

	private reloadNow(): Promise<void> {
		if (this.reloadPromise) return this.reloadPromise;
		this.reloadPromise = this.performReload().finally(() => { this.reloadPromise = null; });
		return this.reloadPromise;
	}

	private async performReload(): Promise<void> {
		this.pendingReload = false;
		try {
			for (const sub of this.subscriptions.values()) sub.abort.abort();
			this.subscriptions.clear();
			forgetClients();
			await this.process.restart(this.settings, this.apiKey, false, this.profileKeys);
			this.note("engine restarted to pick up new provider settings");
		} catch (error) {
			this.note(`engine reload failed: ${error instanceof Error ? error.message : String(error)}`);
			throw error;
		}
	}

	/* ------------------------------------------------------------------ */
	/* Engine lifecycle                                                     */
	/* ------------------------------------------------------------------ */

	async start(force = false): Promise<EngineStatus> {
		const status = await this.process.start(this.settings, this.apiKey, { force, profileKeys: this.profileKeys });
		this.configFingerprint = this.fingerprint(this.settings, this.apiKey, this.profileKeys);
		return status;
	}

	/**
	 * Start the engine if it is not already up, and coalesce concurrent callers
	 * onto a single startup instead of failing with "already starting".
	 */
	async ensureStarted(force = false): Promise<EngineStatus> {
		if (this.reloadPromise) await this.reloadPromise;
		if (!force && this.process.status().state === "running") return this.process.status();
		if (this.startPromise) return this.startPromise;
		// The bootstrap may already be bringing the engine up without going through
		// here; wait for that rather than failing with "already starting".
		if (!force && this.process.status().state === "starting") {
			const deadline = Date.now() + 60_000;
			while (Date.now() < deadline) {
				await Bun.sleep(150);
				const state = this.process.status().state;
				if (state === "running") return this.process.status();
				if (state !== "starting") break;
			}
		}
		this.startPromise = this.start(force).finally(() => {
			this.startPromise = null;
		});
		return this.startPromise;
	}

	async stop(force = true): Promise<void> {
		for (const [directory, sub] of this.subscriptions) {
			sub.abort.abort();
			this.subscriptions.delete(directory);
		}
		forgetClients();
		await this.process.stop(force);
	}

	async restart(force = false): Promise<EngineStatus> {
		for (const sub of this.subscriptions.values()) sub.abort.abort();
		this.subscriptions.clear();
		forgetClients();
		const status = await this.process.restart(this.settings, this.apiKey, force, this.profileKeys);
		return status;
	}

	status(): EngineStatus {
		return this.process.status();
	}

	/** Diagnostics: engine log tail plus the last classified failures. */
	diagnosticsText(): string {
		const status = this.status();
		const header = [
			`instance   : ${status.instanceId || "-"}`,
			`state      : ${status.state}`,
			`engine     : OpenCode ${status.version} (${status.binary?.source ?? "?"})`,
			`binary     : ${status.binary?.path ?? "-"}`,
			`hash       : ${status.binary?.sha256 ?? "-"} verified=${status.binary?.verified ?? false}`,
			`url        : ${status.url ?? "-"}`,
			`pid        : ${status.pid ?? "-"} restarts=${status.restarts}`,
			`data dir   : ${paths.root()}`,
			`last error : ${status.lastError ?? "-"}`,
		].join("\n");
		const events = this.diagnostics.slice(-40).join("\n");
		return `${header}\n\n--- engine log ---\n${this.process.tailLog(160).join("\n")}\n\n--- harness notes ---\n${events}`;
	}

	private note(text: string): void {
		this.diagnostics.push(`${new Date().toISOString()} ${redactText(text)}`);
		if (this.diagnostics.length > 400) this.diagnostics.splice(0, this.diagnostics.length - 400);
	}

	/* ------------------------------------------------------------------ */
	/* Sessions                                                             */
	/* ------------------------------------------------------------------ */

	private client(directory: string): OpencodeClient {
		return engineClient({
			url: this.process.getUrl(),
			directory,
			username: this.process.getUsername(),
			password: this.process.getPassword(),
		});
	}

	async createSession(directory: string, title?: string): Promise<EngineSessionSummary> {
		const client = this.client(directory);
		const created = await call<Record<string, unknown>>(
			"session.create",
			(signal) =>
				client.session.create({
					query: dirQuery(directory),
					body: { title: title ?? "新会话" },
					signal,
				}) as Promise<SdkResult<Record<string, unknown>>>,
			{ timeoutMs: 20_000 },
		);
		const id = String(created.id ?? "");
		if (!id) throw new Error("引擎未返回会话 ID");
		return {
			id,
			title: String(created.title ?? title ?? "新会话"),
			directory: String(created.directory ?? directory),
			createdAt: Number((created.time as Record<string, unknown>)?.created ?? Date.now()),
			updatedAt: Number((created.time as Record<string, unknown>)?.updated ?? Date.now()),
			status: "idle",
			model: this.settings.model,
			summary: { additions: 0, deletions: 0, files: 0 },
		};
	}

	async listEngineSessions(directory: string): Promise<EngineSessionSummary[]> {
		const client = this.client(directory);
		const list = await call<Array<Record<string, unknown>>>(
			"session.list",
			(signal) => client.session.list({ query: dirQuery(directory), signal }) as Promise<SdkResult<Array<Record<string, unknown>>>>,
			{ timeoutMs: 20_000 },
		);
		const running = await this.engineStatusMap(directory);
		return (list ?? []).map((raw) => {
			const id = String(raw.id ?? "");
			const summary = (raw.summary ?? {}) as Record<string, unknown>;
			return {
				id,
				title: String(raw.title ?? ""),
				directory: String(raw.directory ?? directory),
				createdAt: Number((raw.time as Record<string, unknown>)?.created ?? 0),
				updatedAt: Number((raw.time as Record<string, unknown>)?.updated ?? 0),
				status: running[id] ?? "idle",
				model: String((raw.model as Record<string, unknown>)?.id ?? this.settings.model),
				summary: {
					additions: Number(summary.additions ?? 0),
					deletions: Number(summary.deletions ?? 0),
					files: Number(summary.files ?? 0),
				},
			} satisfies EngineSessionSummary;
		});
	}

	private async engineStatusMap(directory: string): Promise<Record<string, ChatSessionStatus>> {
		try {
			const client = this.client(directory);
			const map = await call<Record<string, { type?: string }>>(
				"session.status",
				(signal) => client.session.status({ query: dirQuery(directory), signal }) as Promise<SdkResult<Record<string, { type?: string }>>>,
				{ timeoutMs: 10_000 },
			);
			const out: Record<string, ChatSessionStatus> = {};
			for (const [id, value] of Object.entries(map ?? {})) {
				out[id] = value?.type === "busy" || value?.type === "retry" ? "running" : "idle";
			}
			return out;
		} catch {
			return {};
		}
	}

	async getEngineSession(directory: string, sessionId: string): Promise<EngineSessionSummary | null> {
		const client = this.client(directory);
		try {
			const raw = await call<Record<string, unknown>>(
				"session.get",
				(signal) => client.session.get({ path: { id: sessionId }, query: dirQuery(directory), signal }) as Promise<SdkResult<Record<string, unknown>>>,
				{ timeoutMs: 15_000 },
			);
			const summary = (raw.summary ?? {}) as Record<string, unknown>;
			const runtime = this.runtimes.get(sessionId);
			return {
				id: String(raw.id ?? sessionId),
				title: String(raw.title ?? ""),
				directory: String(raw.directory ?? directory),
				createdAt: Number((raw.time as Record<string, unknown>)?.created ?? 0),
				updatedAt: Number((raw.time as Record<string, unknown>)?.updated ?? 0),
				status: runtime?.status ?? "idle",
				model: String((raw.model as Record<string, unknown>)?.id ?? this.settings.model),
				summary: {
					additions: Number(summary.additions ?? 0),
					deletions: Number(summary.deletions ?? 0),
					files: Number(summary.files ?? 0),
				},
			};
		} catch {
			return null;
		}
	}

	async deleteSession(directory: string, sessionId: string): Promise<void> {
		if (this.activeRun === sessionId) {
			throw userError("该会话正在执行任务，请先停止再删除。");
		}
		const client = this.client(directory);
		await call(
			"session.delete",
			(signal) => client.session.delete({ path: { id: sessionId }, query: dirQuery(directory), signal }) as Promise<SdkResult<unknown>>,
			{ timeoutMs: 20_000 },
		);
		this.runtimes.delete(sessionId);
	}

	/**
	 * Read the transcript for the chat list.
	 *
	 * The plan asks for a readable conversation, not a wall of tool output, so
	 * tool parts are collapsed into a single `status` line per assistant turn and
	 * full outputs stay available through the diff / node detail endpoints.
	 */
	async readMessages(directory: string, sessionId: string, max = 500): Promise<ChatMessage[]> {
		const client = this.client(directory);
		const raw = await call<Array<Record<string, unknown>>>(
			"session.messages",
			(signal) =>
				client.session.messages({
					path: { id: sessionId },
					query: { ...dirQuery(directory), limit: max },
					signal,
				}) as Promise<SdkResult<Array<Record<string, unknown>>>>,
			{ timeoutMs: 30_000 },
		);
		const out: ChatMessage[] = [];
		for (const entry of raw ?? []) {
			const info = (entry.info ?? {}) as Record<string, unknown>;
			const parts = (entry.parts ?? []) as Array<Record<string, unknown>>;
			const role = String(info.role ?? "");
			const messageId = String(info.id ?? "");
			const createdAt = Number((info.time as Record<string, unknown>)?.created ?? Date.now());
			const text = parts
				.filter((p) => p.type === "text")
				.map((p) => String(p.text ?? ""))
				.join("\n\n")
				.trim();
			const reasoning = parts
				.filter((p) => p.type === "reasoning")
				.map((p) => String(p.text ?? ""))
				.join("\n\n")
				.trim();
			if (role === "user") {
				out.push({ id: messageId, sessionId, role: "user", content: text, createdAt });
				continue;
			}
			if (role !== "assistant") continue;
			if (text || reasoning) {
				out.push({
					id: messageId,
					sessionId,
					role: "assistant",
					content: text,
					reasoning: reasoning || undefined,
					createdAt,
					meta: {
						modelId: String(info.modelID ?? ""),
						providerId: String(info.providerID ?? ""),
						inputTokens: Number((info.tokens as Record<string, unknown>)?.input ?? 0) || undefined,
						outputTokens: Number((info.tokens as Record<string, unknown>)?.output ?? 0) || undefined,
					},
				});
			}
			const tools = parts.filter((p) => p.type === "tool");
			if (tools.length) {
				const names = tools.map((p) => String(p.tool ?? "tool"));
				const failures = tools.filter((p) => {
					const state = (p.state ?? {}) as Record<string, unknown>;
					if (String(state.status) === "error") return true;
					const meta = (state.metadata ?? {}) as Record<string, unknown>;
					return typeof meta.exit === "number" && meta.exit !== 0;
				}).length;
				out.push({
					id: `${messageId}_summary`,
					sessionId,
					role: "status",
					content: `${names.length} 个工具调用：${summarizeToolNames(names)}${failures ? `（${failures} 个失败）` : ""}`,
					createdAt,
					meta: { toolCalls: undefined, hookEventName: "turn_summary", reason: failures ? "tool_failure" : "ok" },
				});
			}
			const error = info.error as Record<string, unknown> | undefined;
			if (error) {
				const data = (error.data ?? {}) as Record<string, unknown>;
				out.push({
					id: `${messageId}_error`,
					sessionId,
					role: "error",
					content: String(data.message ?? error.name ?? "未知错误"),
					createdAt,
				});
			}
		}
		return out;
	}

	/** Tool nodes for a stored session, so the canvas can be inspected later. */
	async readToolNodes(directory: string, sessionId: string): Promise<ToolNodeSnapshot[]> {
		const client = this.client(directory);
		const raw = await call<Array<Record<string, unknown>>>(
			"session.messages",
			(signal) =>
				client.session.messages({
					path: { id: sessionId },
					query: dirQuery(directory),
					signal,
				}) as Promise<SdkResult<Array<Record<string, unknown>>>>,
			{ timeoutMs: 30_000 },
		);
		const nodes: ToolNodeSnapshot[] = [];
		for (const entry of raw ?? []) {
			for (const part of ((entry.parts ?? []) as Array<Record<string, unknown>>)) {
				if (part.type !== "tool") continue;
				const state = (part.state ?? {}) as Record<string, unknown>;
				const status = String(state.status ?? "pending");
				const time = (state.time ?? {}) as Record<string, unknown>;
				const metadata = (state.metadata ?? {}) as Record<string, unknown>;
				const exitCode = typeof metadata.exit === "number" ? metadata.exit : undefined;
				const failedByExit = status === "completed" && exitCode !== undefined && exitCode !== 0;
				nodes.push({
					toolCallId: String(part.callID ?? part.id ?? ""),
					toolName: String(part.tool ?? "tool"),
					phase:
						status === "error" || failedByExit
							? "failure"
							: status === "completed"
								? "success"
								: status === "running"
									? "running"
									: "pending",
					input: state.input ?? {},
					output: typeof state.output === "string" ? state.output : undefined,
					error:
						typeof state.error === "string"
							? state.error
							: failedByExit
								? `命令以非零退出码 ${exitCode} 结束`
								: undefined,
					title: typeof state.title === "string" ? state.title : undefined,
					startedAt: typeof time.start === "number" ? time.start : undefined,
					endedAt: typeof time.end === "number" ? time.end : undefined,
					metadata,
					exitCode,
				});
			}
		}
		return nodes;
	}

	/* ------------------------------------------------------------------ */
	/* Diffs                                                               */
	/* ------------------------------------------------------------------ */

	/**
	 * Diffs live per user-message turn on this build: `/session/{id}/diff`
	 * without `messageID` returns an empty list. We therefore walk the turns.
	 */
	async readDiffs(directory: string, sessionId: string, messageId?: string): Promise<FileDiffEntry[]> {
		const client = this.client(directory);
		if (messageId) {
			const raw = await call<Array<Record<string, unknown>>>(
				"session.diff",
				(signal) =>
					client.session.diff({
						path: { id: sessionId },
						query: { ...dirQuery(directory), messageID: messageId },
						signal,
					}) as Promise<SdkResult<Array<Record<string, unknown>>>>,
				{ timeoutMs: 20_000 },
			);
			return normalizeDiffs(raw ?? []);
		}
		const messages = await call<Array<Record<string, unknown>>>(
			"session.messages",
			(signal) =>
				client.session.messages({
					path: { id: sessionId },
					query: dirQuery(directory),
					signal,
				}) as Promise<SdkResult<Array<Record<string, unknown>>>>,
			{ timeoutMs: 30_000 },
		);
		const merged = new Map<string, FileDiffEntry>();
		for (const entry of messages ?? []) {
			const info = (entry.info ?? {}) as Record<string, unknown>;
			if (String(info.role) !== "user") continue;
			const id = String(info.id ?? "");
			if (!id) continue;
			try {
				const raw = await call<Array<Record<string, unknown>>>(
					"session.diff",
					(signal) =>
						client.session.diff({
							path: { id: sessionId },
							query: { ...dirQuery(directory), messageID: id },
							signal,
						}) as Promise<SdkResult<Array<Record<string, unknown>>>>,
					{ timeoutMs: 20_000 },
				);
				for (const diff of normalizeDiffs(raw ?? [])) merged.set(diff.file, diff);
			} catch {
				// A turn with no diff (or a transient failure) must not break the view.
			}
		}
		// Fall back to the tool-part metadata for anything the turn walk missed
		// (e.g. writes that were later reverted).
		if (merged.size === 0) {
			const nodes = await this.readToolNodes(directory, sessionId);
			for (const node of nodes) {
				const fileDiff = node.metadata?.filediff as Record<string, unknown> | undefined;
				if (!fileDiff) continue;
				const file = String(fileDiff.file ?? "");
				if (!file) continue;
				merged.set(file, {
					file,
					patch: String(fileDiff.patch ?? ""),
					additions: Number(fileDiff.additions ?? 0),
					deletions: Number(fileDiff.deletions ?? 0),
					status: "modified",
				});
			}
		}
		return [...merged.values()];
	}

	/* ------------------------------------------------------------------ */
	/* Running a turn                                                      */
	/* ------------------------------------------------------------------ */

	private runtime(sessionId: string, directory: string): Runtime {
		const existing = this.runtimes.get(sessionId);
		if (existing) return existing;
		let resolveDone: (() => void) | undefined;
		const done = new Promise<void>((resolve) => {
			resolveDone = resolve;
		});
		const created: Runtime = {
			sessionId,
			directory,
			kind: "work",
			normalizer: new EventNormalizer({ sessionId }),
			status: "idle",
			approvals: [],
			nodes: [],
			chunkIndex: 0,
			done,
			resolveDone,
		};
		this.runtimes.set(sessionId, created);
		return created;
	}

	private emitChunk(runtime: Runtime, stream: string, chunk: string): void {
		// An endpoint may ignore the empty tool list and emit a tool call anyway.
		// OpenCode rejects it; keep that protocol error out of a text-only chat UI.
		if (runtime.kind === "chat" && stream.startsWith("chat_tool_call_")) return;
		this.chunkSink(runtime.sessionId, stream, chunk, runtime.chunkIndex++);
	}

	private setStatus(runtime: Runtime, status: ChatSessionStatus): void {
		runtime.status = status;
		this.statusSink(runtime.sessionId, status);
	}

	private emitApprovals(runtime: Runtime): void {
		this.approvalSink(runtime.sessionId, runtime.kind === "chat" ? [] : runtime.approvals);
	}

	pendingApprovals(sessionId: string): ToolApprovalRequestItem[] {
		return this.runtimes.get(sessionId)?.approvals ?? [];
	}

	nodes(sessionId: string): ToolNodeSnapshot[] | null {
		const runtime = this.runtimes.get(sessionId);
		return runtime?.kind === "chat" ? [] : runtime?.normalizer.nodeSnapshots() ?? null;
	}

	isBusy(sessionId: string): boolean {
		const runtime = this.runtimes.get(sessionId);
		return !!runtime && (runtime.status === "starting" || runtime.status === "running" || runtime.status === "stopping");
	}

	activeSession(): string | null {
		return this.activeRun;
	}

	/**
	 * Send a user message and stream the whole turn.
	 *
	 * Events are subscribed *before* the prompt is posted so the opening
	 * events of the turn cannot be missed.
	 */
	async prompt(sessionId: string, directory: string, text: string, options: { kind?: "work" | "chat"; profileId?: string; model?: string; mode?: "act" | "plan"; goal?: string; skillId?: string; attachments?: string[] } = {}): Promise<RunHandle> {
		if (this.activeRun && this.activeRun !== sessionId) {
			throw userError(`已有任务正在执行（会话 ${this.activeRun.slice(-6)}）。本应用同一时间只允许一个主动执行任务。`);
		}
		const runtime = this.runtime(sessionId, directory);
		if (this.isBusy(sessionId)) throw userError("该会话正在执行任务。");
		runtime.kind = options.kind === "chat" ? "chat" : "work";
		if (this.pendingReload) await this.reloadNow();
		if (this.reloadPromise) await this.reloadPromise;

		await this.ensureSubscription(directory);

		runtime.done = new Promise<void>((resolve) => {
			runtime.resolveDone = resolve;
		});
		runtime.runAbort = new AbortController();
		const currentRun = runtime.runAbort;
		this.activeRun = sessionId;
		this.process.setBusy(true);
		this.setStatus(runtime, "starting");
		this.emitChunk(runtime, "chat_queued_prompt_start", JSON.stringify({ prompt: text }));

		const client = this.client(directory);
		const isChat = options.kind === "chat";
		const guidance = [
			options.goal ? `持续目标：${options.goal}` : "",
			options.skillId ? `本轮用户选择了 Agent Skill ${options.skillId}。请先使用 skill 工具加载它，再执行任务。` : "",
			options.attachments?.length ? `用户附加的本地路径（按工作区和外部目录授权规则读取）：\n${options.attachments.join("\n")}` : "",
		].filter(Boolean).join("\n\n");
		void (async () => {
			try {
				this.setStatus(runtime, "running");
				await call(
					"session.prompt",
					(signal) =>
						client.session.prompt({
							path: { id: sessionId },
							query: dirQuery(directory),
							body: {
								model: { providerID: providerIdFor(options.profileId ?? this.settings.defaultProfileId ?? "default"), modelID: options.model ?? this.settings.model },
								...(isChat ? { agent: "harness-chat", tools: CHAT_DISABLED_TOOLS } : options.mode === "plan" ? { agent: "plan" } : {}),
								...(guidance ? { system: guidance } : {}),
								parts: [{ type: "text", text }],
							} as never,
							signal,
						}) as Promise<SdkResult<unknown>>,
					{ timeoutMs: ENGINE_PROMPT_TIMEOUT_MS },
				);
			} catch (error) {
				// A cancelled request can reject after a new turn has already begun.
				if (runtime.runAbort !== currentRun) return;
				const failure = classifyEngineError(error);
				if (failure.kind === "aborted") {
					this.finishTurn(runtime, "cancelled", null);
				} else {
					this.emitChunk(runtime, "chat_done", JSON.stringify({ reason: "error", text: `${failure.message}${failure.detail ? `（${failure.detail}）` : ""}` }));
					this.finishTurn(runtime, "error", failure);
				}
			}
		})();

		return { sessionId, directory, startedAt: Date.now() };
	}

	private finishTurn(runtime: Runtime, status: ChatSessionStatus, failure: EngineFailure | null): void {
		if (!this.isBusy(runtime.sessionId)) return;
		const reason = status === "cancelled" ? "aborted" : status === "error" ? "error" : "completed";
		if (reason !== "error") {
			this.emitChunk(runtime, "chat_done", JSON.stringify({ reason, text: "" }));
		}
		for (const approval of runtime.approvals) {
			this.emitChunk(runtime, "chat_tool_call_end", JSON.stringify({ toolCallId: approval.toolCallId, toolName: approval.toolName, error: "授权等待已结束" }));
		}
		runtime.approvals = [];
		this.emitApprovals(runtime);
		runtime.runAbort = undefined;
		this.setStatus(runtime, status);
		this.setStatus(runtime, "idle");
		this.activeRun = null;
		this.process.setBusy(false);
		if (failure) this.note(`turn failed for ${runtime.sessionId}: ${failure.kind} ${failure.detail ?? ""}`);
		runtime.resolveDone?.();
		// A provider change that arrived mid-turn takes effect now, between turns.
		if (this.pendingReload) void this.reloadNow().catch(() => {});
	}

	/**
	 * Stop the current turn: ask the engine to cancel first, then — only if the
	 * engine does not react — stop the engine process tree and say so.
	 */
	async stopTask(sessionId: string): Promise<{ cancelled: boolean; forced: boolean; detail: string }> {
		const runtime = this.runtimes.get(sessionId);
		if (!runtime || !this.isBusy(sessionId)) {
			return { cancelled: false, forced: false, detail: "当前没有正在执行的任务。" };
		}
		this.setStatus(runtime, "stopping");
		// Ending an approval wait immediately is part of the contract.
		if (runtime.approvals.length) {
			for (const approval of runtime.approvals) {
				try {
					await this.replyPermission(sessionId, approval.requestId, "reject");
				} catch {}
			}
		}
		try {
			const client = this.client(runtime.directory);
			await call(
				"session.abort",
				(signal) =>
					client.session.abort({ path: { id: sessionId }, query: dirQuery(runtime.directory), signal }) as Promise<SdkResult<unknown>>,
				{ timeoutMs: 10_000 },
			);
		} catch (error) {
			this.note(`abort call failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		const settled = await Promise.race([
			runtime.done.then(() => true),
			Bun.sleep(8000).then(() => false),
		]);
		if (!settled) {
			this.note("abort did not settle in 8s; forcing the engine process tree down (no auto-resend)");
			await this.process.stop(true);
			this.markAllInterrupted("任务被强制停止：引擎未在超时内响应取消请求。");
			return { cancelled: false, forced: true, detail: "引擎未在 8 秒内响应取消，已强制终止引擎进程树。任务已中断，不会自动重发。" };
		}
		return { cancelled: true, forced: false, detail: "已取消当前任务。" };
	}

	async replyPermission(sessionId: string, requestId: string, decision: "allow" | "reject"): Promise<void> {
		const runtime = this.runtimes.get(sessionId);
		if (!runtime) throw userError("会话不存在");
		const approval = runtime.approvals.find((item) => item.requestId === requestId);
		const client = this.client(runtime.directory);
		const response = decision === "allow" ? "once" : "reject";
		await call(
			"permission.reply",
			(signal) =>
				client.postSessionIdPermissionsPermissionId({
					path: { id: sessionId, permissionID: requestId },
					query: dirQuery(runtime.directory),
					body: { response },
					signal,
				}) as Promise<SdkResult<unknown>>,
			{ timeoutMs: 15_000 },
		);
		runtime.approvals = runtime.approvals.filter((item) => item.requestId !== requestId);
		this.emitApprovals(runtime);
		if (approval) this.note(`permission ${approval.toolName} (${requestId}) -> ${decision}`);
	}

	private markAllInterrupted(reason: string): void {
		for (const runtime of this.runtimes.values()) {
			if (!this.isBusy(runtime.sessionId)) continue;
			runtime.interrupted = reason;
			this.emitChunk(runtime, "chat_done", JSON.stringify({ reason: "error", text: reason }));
			this.finishTurn(runtime, "error", null);
		}
	}

	/* ------------------------------------------------------------------ */
	/* Event streaming                                                     */
	/* ------------------------------------------------------------------ */

	private async ensureSubscription(directory: string): Promise<void> {
		const existing = this.subscriptions.get(directory);
		if (existing?.alive) return;
		existing?.abort.abort();
		const abort = new AbortController();
		const state = { abort, attempt: 0, lastEvent: Date.now(), startedAt: Date.now(), alive: true };
		this.subscriptions.set(directory, state);
		void this.runSubscription(directory, state);
	}

	private async runSubscription(directory: string, state: { abort: AbortController; attempt: number; lastEvent: number; alive: boolean }): Promise<void> {
		while (!state.abort.signal.aborted) {
			try {
				const client = this.client(directory);
				const result = (await client.event.subscribe({
					query: dirQuery(directory),
					signal: state.abort.signal,
				})) as { stream: AsyncGenerator<unknown> };
				state.attempt = 0;
				for await (const raw of result.stream) {
					if (state.abort.signal.aborted) break;
					state.lastEvent = Date.now();
					this.dispatch(directory, raw);
				}
				// A clean end of stream still means we lost the subscription.
				if (!state.abort.signal.aborted) throw new Error("event stream closed");
			} catch (error) {
				if (state.abort.signal.aborted) break;
				const delay = SSE_BACKOFF_MS[Math.min(state.attempt, SSE_BACKOFF_MS.length - 1)];
				state.attempt++;
				this.note(`event stream lost (${error instanceof Error ? error.message : String(error)}); resubscribing in ${delay}ms`);
				await Bun.sleep(delay);
				if (state.abort.signal.aborted) break;
				// Resubscribe, then reconcile: the plan forbids re-sending the task,
				// so we read current state and patch the nodes instead.
				await this.resync(directory).catch(() => {});
			}
		}
		state.alive = false;
	}

	private dispatch(directory: string, raw: unknown): void {
		const payload = (((raw as Record<string, unknown>)?.payload ?? raw) as Record<string, unknown>) ?? {};
		const props = (payload.properties ?? {}) as Record<string, unknown>;
		const sessionId = props.sessionID ? String(props.sessionID) : undefined;
		if (!sessionId) return;
		const runtime = this.runtimes.get(sessionId);
		if (!runtime) return;
		if (runtime.directory !== directory) return;
		this.applyEvents(runtime, runtime.normalizer.handle(payload));
	}

	private applyEvents(runtime: Runtime, events: NormalizedEvent[]): void {
		for (const event of events) {
			switch (event.kind) {
				case "text":
					this.emitChunk(runtime, "chat_text", event.text);
					break;
				case "reasoning":
					this.emitChunk(runtime, "chat_reasoning", JSON.stringify({ text: event.text }));
					break;
				case "tool-start":
					if (runtime.status === "starting") this.setStatus(runtime, "running");
					this.emitChunk(
						runtime,
						"chat_tool_call_start",
						JSON.stringify({ toolCallId: event.toolCallId, toolName: event.toolName, input: event.input }),
					);
					break;
				case "tool-update":
					this.emitChunk(
						runtime,
						"chat_tool_call_update",
						JSON.stringify({ toolCallId: event.toolCallId, toolName: event.toolName, update: { stream: event.stream, chunk: event.chunk, detachable: true } }),
					);
					break;
				case "tool-end":
					this.emitChunk(
						runtime,
						"chat_tool_call_end",
						JSON.stringify({
							toolCallId: event.toolCallId,
							toolName: event.toolName,
							input: event.input,
							output: event.output,
							error: event.error,
							durationMs: event.durationMs,
							exitCode: event.exitCode,
						}),
					);
					break;
				case "usage":
					this.emitChunk(
						runtime,
						"chat_usage",
						JSON.stringify({
							inputTokens: event.inputTokens,
							outputTokens: event.outputTokens,
							cacheReadTokens: event.cacheReadTokens,
							cost: event.cost,
						}),
					);
					break;
				case "approval":
					runtime.approvals = [...runtime.approvals, event.item];
					this.emitApprovals(runtime);
					break;
				case "approval-cleared":
					runtime.approvals = runtime.approvals.filter((item) => item.requestId !== event.requestId);
					this.emitApprovals(runtime);
					break;
				case "busy":
					if (runtime.status === "starting") this.setStatus(runtime, "running");
					break;
				case "idle":
					if (this.activeRun === runtime.sessionId) this.finishTurn(runtime, "completed", null);
					break;
				case "session-title":
					this.chunkSink(runtime.sessionId, "chat_session_title", JSON.stringify({ title: event.title }), runtime.chunkIndex++);
					break;
				case "files-changed":
					this.emitChunk(runtime, "chat_files_changed", JSON.stringify({ files: event.files }));
					break;
				case "turn-error":
					if (event.fatal) {
						this.emitChunk(runtime, "chat_done", JSON.stringify({ reason: "error", text: event.message }));
						this.finishTurn(runtime, "error", { kind: "unknown", message: event.message, retryable: false });
					} else {
						this.note(`non-fatal engine error ignored: ${event.message}`);
					}
					break;
			}
		}
	}

	/** After a reconnect, reconcile node state from the engine's own history. */
	private async resync(directory: string): Promise<void> {
		for (const runtime of this.runtimes.values()) {
			if (runtime.directory !== directory) continue;
			if (!this.isBusy(runtime.sessionId)) continue;
			try {
				const nodes = await this.readToolNodes(directory, runtime.sessionId);
				for (const node of nodes) {
					const known = runtime.normalizer.nodeSnapshots().find((n) => n.toolCallId === node.toolCallId);
					if (known && known.phase !== "pending" && known.phase !== "running") continue;
					if (node.phase === "success" || node.phase === "failure") {
						this.emitChunk(
							runtime,
							"chat_tool_call_end",
							JSON.stringify({
								toolCallId: node.toolCallId,
								toolName: node.toolName,
								input: node.input,
								output: node.output,
								error: node.error,
								durationMs: node.startedAt && node.endedAt ? node.endedAt - node.startedAt : undefined,
							}),
						);
						runtime.normalizer.handle({
							type: "message.part.updated",
							properties: {
								part: {
									id: node.toolCallId,
									type: "tool",
									callID: node.toolCallId,
									tool: node.toolName,
									state: {
										status: node.phase === "success" ? "completed" : "error",
										input: node.input,
										output: node.output,
										error: node.error,
										time: { start: node.startedAt, end: node.endedAt },
									},
								},
							},
						});
					}
				}
				this.note(`resynced ${nodes.length} tool nodes for ${runtime.sessionId}`);
			} catch (error) {
				this.note(`resync failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	/* ------------------------------------------------------------------ */
	/* Configuration test                                                  */
	/* ------------------------------------------------------------------ */

	/**
	 * A real, minimal, tool-free request against the configured endpoint.
	 * Deliberately separate from "save" so the two have independent feedback.
	 */
	async testConnection(settings: AppSettings, apiKey: string): Promise<{ ok: boolean; kind: string; message: string; detail?: string; latencyMs: number }> {
		const started = Date.now();
		const base = settings.baseUrl.replace(/\/+$/, "");
		if (!base) return { ok: false, kind: "protocol-mismatch", message: "Base URL 为空。", latencyMs: 0 };
		if (!apiKey) return { ok: false, kind: "auth", message: "未填写 API Key。", latencyMs: 0 };
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(new Error("timeout")), 20_000);
		try {
			if (settings.protocol === "anthropic") {
				const endpoint = `${base}/v1/messages`;
				const res = await fetch(endpoint, {
					method: "POST",
					signal: controller.signal,
					proxy: proxyForUrl(endpoint),
					headers: {
						"content-type": "application/json",
						"x-api-key": apiKey,
						"anthropic-version": "2023-06-01",
					},
					body: JSON.stringify({
						model: settings.model,
						max_tokens: 8,
						messages: [{ role: "user", content: "ping" }],
					}),
				});
				return await interpret(res, "anthropic", started);
			}
			const endpoint = `${base}/chat/completions`;
			const res = await fetch(endpoint, {
				method: "POST",
				signal: controller.signal,
				proxy: proxyForUrl(endpoint),
				headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
				body: JSON.stringify({
					model: settings.model,
					max_tokens: 8,
					messages: [{ role: "user", content: "ping" }],
					// Explicitly the Chat Completions API, never the Responses API.
					stream: false,
				}),
			});
			return await interpret(res, "openai-compatible", started);
		} catch (error) {
			const failure = classifyEngineError(error);
			return { ok: false, kind: failure.kind, message: failure.kind === "engine-timeout" ? "模型服务连接超时。" : failure.message, detail: failure.detail, latencyMs: Date.now() - started };
		} finally {
			clearTimeout(timer);
		}
	}
}

async function interpret(res: Response, protocol: string, started: number): Promise<{ ok: boolean; kind: string; message: string; detail?: string; latencyMs: number }> {
	const latencyMs = Date.now() - started;
	const body = await res.text().catch(() => "");
	if (res.ok) {
		return { ok: true, kind: "ok", message: `连接成功（${protocol}），耗时 ${latencyMs}ms。`, latencyMs };
	}
	if (res.status === 404 && !body.trim()) {
		return { ok: false, kind: "protocol-mismatch", message: "端点没有此协议的接口，请检查 Base URL 与接口协议。", detail: "HTTP 404 (empty response)", latencyMs };
	}
	const failure = classifyEngineError(`HTTP ${res.status}: ${body.slice(0, 400)}`);
	return { ok: false, kind: failure.kind, message: failure.message, detail: failure.detail, latencyMs };
}

function normalizeDiffs(raw: Array<Record<string, unknown>>): FileDiffEntry[] {
	return raw.map((entry) => {
		const patch = String(entry.patch ?? "");
		const status = String(entry.status ?? "unknown");
		return {
			file: String(entry.file ?? ""),
			patch,
			additions: Number(entry.additions ?? 0),
			deletions: Number(entry.deletions ?? 0),
			status: (["added", "modified", "deleted"].includes(status) ? status : "unknown") as FileDiffEntry["status"],
			unavailable: patch ? undefined : "该文件无法以文本差异展示（可能是二进制文件或内容已在引擎外被还原）。",
		};
	});
}

function summarizeToolNames(names: string[]): string {
	const counts = new Map<string, number>();
	for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
	return [...counts.entries()].map(([name, count]) => (count > 1 ? `${name}×${count}` : name)).join(" · ");
}

export function engineVersionLabel(): string {
	return `OpenCode ${ENGINE_VERSION}`;
}

export { engineError };
