/**
 * Harness backend — the OpenCode event -> Harness event mapper.
 *
 * Written against the *observed* behaviour of the pinned engine
 * (1.18.31), not against its generated `.d.ts`: the runtime emits e.g.
 * `permission.asked` while the type definition says `permission.updated`, and
 * text arrives on `message.part.delta` in addition to `message.part.updated`.
 * See `harness/testing/opencode-event-samples.json` for the raw samples.
 *
 * The mapper is deliberately idempotent: every node is keyed by the engine's
 * stable `callID` / `partID`, so re-delivered or out-of-order events update the
 * existing node instead of creating duplicates.
 */
import type { ToolApprovalRequestItem } from "../../../shared/types";

/** Node lifecycle mirrored from the engine's tool state machine. */
export type ToolPhase = "pending" | "running" | "success" | "failure" | "cancelled";

export interface ToolNodeSnapshot {
	toolCallId: string;
	toolName: string;
	phase: ToolPhase;
	input: unknown;
	output?: string;
	error?: string;
	title?: string;
	startedAt?: number;
	endedAt?: number;
	metadata?: Record<string, unknown>;
	/**
	 * Process exit code when the tool reported one. The engine keeps
	 * `state.status === "completed"` even for a non-zero exit, so this field is
	 * the only reliable signal that a command actually failed.
	 */
	exitCode?: number;
}

export type NormalizedEvent =
	| { kind: "text"; text: string }
	| { kind: "reasoning"; text: string }
	| { kind: "tool-start"; toolCallId: string; toolName: string; input: unknown }
	| { kind: "tool-update"; toolCallId: string; toolName: string; chunk: string; stream: "stdout" | "stderr" }
	| {
			kind: "tool-end";
			toolCallId: string;
			toolName: string;
			input: unknown;
			output?: string;
			error?: string;
			durationMs?: number;
			exitCode?: number;
	  }
	| { kind: "usage"; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cost?: number }
	| { kind: "approval"; item: ToolApprovalRequestItem }
	| { kind: "approval-cleared"; requestId: string; decision: "allow" | "reject" }
	| { kind: "busy" }
	| { kind: "idle" }
	| { kind: "turn-error"; message: string; fatal: boolean }
	| { kind: "files-changed"; files: string[] }
	| { kind: "session-title"; title: string };

/** Pull a numeric exit code out of a tool's metadata, when present. */
function readExitCode(metadata: Record<string, unknown> | undefined): number | undefined {
	if (!metadata) return undefined;
	for (const key of ["exit", "exitCode", "exit_code", "code"]) {
		const value = metadata[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
	return undefined;
}

/** Build the one-line explanation shown on the approval card. */
function describePermission(permission: string, metadata: unknown, patterns: string[]): string {
	const meta = (metadata ?? {}) as Record<string, unknown>;
	const filepath = typeof meta.filepath === "string" ? meta.filepath : "";
	const command = typeof meta.command === "string" ? meta.command : "";
	const url = typeof meta.url === "string" ? meta.url : "";
	if (permission === "bash" && command) return `命令：${command}`;
	if (filepath) return `${permission === "edit" ? "修改文件" : "访问路径"}：${filepath}`;
	if (url) return `访问网络：${url}`;
	if (patterns.length) return `${permission}：${patterns.join("、")}`;
	return `需要授权：${permission}`;
}

/** Errors the engine reports that are not about the user's turn. */
function isIncidentalError(name: string, message: string): boolean {
	if (/skill|frontmatter|yaml/i.test(message)) return true;
	if (/^UnknownError$/i.test(name) && !/model|provider|api|quota|rate/i.test(message)) return true;
	return false;
}

const FATAL_ERROR_NAMES = new Set([
	"ProviderAuthError",
	"ApiError",
	"MessageOutputLengthError",
	"MessageAbortedError",
	"ProviderModelNotFoundError",
	"ContextOverflowError",
]);

export interface NormalizerOptions {
	sessionId: string;
}

export class EventNormalizer {
	private readonly sessionId: string;
	/** partID -> accumulated streamed text (dedupes delta + updated). */
	private textByPart = new Map<string, string>();
	/** partID -> accumulated reasoning text. */
	private reasoningByPart = new Map<string, string>();
	/** callID -> last known node snapshot. */
	private tools = new Map<string, ToolNodeSnapshot>();
	/** callID -> tool name seen on the tool part (permissions reference callID). */
	private toolNames = new Map<string, string>();
	/** assistant messageID -> whether usage was already reported. */
	private usageReported = new Set<string>();
	/** requestIDs we have already surfaced an approval for. */
	private seenPermissions = new Set<string>();
	private changedFiles = new Set<string>();

	constructor(options: NormalizerOptions) {
		this.sessionId = options.sessionId;
	}

	/** Latest snapshot of every tool node, ordered by start time. */
	nodeSnapshots(): ToolNodeSnapshot[] {
		return [...this.tools.values()].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
	}

	changedFileList(): string[] {
		return [...this.changedFiles];
	}

	handle(payload: Record<string, unknown>): NormalizedEvent[] {
		const type = String(payload.type ?? "");
		const props = (payload.properties ?? {}) as Record<string, unknown>;
		const out: NormalizedEvent[] = [];

		switch (type) {
			case "session.created":
			case "session.updated": {
				const info = props.info as Record<string, unknown> | undefined;
				const title = typeof info?.title === "string" ? info.title : undefined;
				if (title && title !== "Untitled") out.push({ kind: "session-title", title });
				break;
			}
			case "message.updated": {
				const info = (props.info ?? {}) as Record<string, unknown>;
				const messageId = String(info.id ?? "");
				const role = String(info.role ?? "");
				if (role === "assistant") {
					const error = info.error as Record<string, unknown> | undefined;
					if (error) {
						const name = String(error.name ?? "UnknownError");
						const data = (error.data ?? {}) as Record<string, unknown>;
						const message = String(data.message ?? name);
						out.push({
							kind: "turn-error",
							message,
							fatal: FATAL_ERROR_NAMES.has(name) || !isIncidentalError(name, message),
						});
					}
					const tokens = info.tokens as Record<string, unknown> | undefined;
					if (tokens && !this.usageReported.has(messageId)) {
						this.usageReported.add(messageId);
						const cache = (tokens.cache ?? {}) as Record<string, unknown>;
						out.push({
							kind: "usage",
							inputTokens: Number(tokens.input ?? 0) || undefined,
							outputTokens: Number(tokens.output ?? 0) || undefined,
							cacheReadTokens: Number(cache.read ?? 0) || undefined,
							cost: typeof info.cost === "number" ? info.cost : undefined,
						});
					}
				}
				break;
			}
			case "message.part.updated": {
				const part = (props.part ?? {}) as Record<string, unknown>;
				out.push(...this.handlePart(part));
				break;
			}
			case "message.part.delta": {
				const field = String(props.field ?? "");
				const delta = String(props.delta ?? "");
				const partId = String(props.partID ?? "");
				if (!delta || !partId) break;
				if (field === "reasoning") {
					this.reasoningByPart.set(partId, (this.reasoningByPart.get(partId) ?? "") + delta);
					out.push({ kind: "reasoning", text: delta });
				} else if (field === "text") {
					this.textByPart.set(partId, (this.textByPart.get(partId) ?? "") + delta);
					out.push({ kind: "text", text: delta });
				}
				break;
			}
			case "permission.asked":
			case "permission.updated": {
				const requestId = String(props.id ?? "");
				const sessionId = String(props.sessionID ?? this.sessionId);
				if (!requestId || this.seenPermissions.has(requestId)) break;
				if (sessionId && sessionId !== this.sessionId) break;
				this.seenPermissions.add(requestId);
				const tool = (props.tool ?? {}) as Record<string, unknown>;
				const callId = String(tool.callID ?? requestId);
				const permission = String(props.permission ?? "unknown");
				const patterns = Array.isArray(props.patterns) ? props.patterns.map((p) => String(p)) : [];
				out.push({
					kind: "approval",
					item: {
						requestId,
						sessionId: this.sessionId,
						createdAt: new Date().toISOString(),
						toolCallId: callId,
						toolName: this.toolNames.get(callId) ?? permission,
						summary: describePermission(permission, props.metadata, patterns),
						input: {
							permission,
							patterns,
							always: props.always,
							metadata: props.metadata,
						},
					},
				});
				break;
			}
			case "permission.replied": {
				const requestId = String(props.requestID ?? props.permissionID ?? "");
				if (!requestId) break;
				this.seenPermissions.delete(requestId);
				const reply = String(props.reply ?? props.response ?? "");
				out.push({ kind: "approval-cleared", requestId, decision: reply === "reject" ? "reject" : "allow" });
				break;
			}
			case "session.status": {
				const status = (props.status ?? {}) as Record<string, unknown>;
				const kind = String(status.type ?? "");
				if (kind === "busy" || kind === "retry") out.push({ kind: "busy" });
				break;
			}
			case "session.idle": {
				if (!props.sessionID || String(props.sessionID) === this.sessionId) out.push({ kind: "idle" });
				break;
			}
			case "session.error": {
				const sessionId = props.sessionID ? String(props.sessionID) : "";
				const error = (props.error ?? {}) as Record<string, unknown>;
				const name = String(error.name ?? "UnknownError");
				const data = (error.data ?? {}) as Record<string, unknown>;
				const message = String(data.message ?? name);
				if (sessionId && sessionId !== this.sessionId) break;
				if (isIncidentalError(name, message)) {
					// e.g. a malformed skill file elsewhere on the machine — log only.
					out.push({ kind: "turn-error", message, fatal: false });
					break;
				}
				out.push({ kind: "turn-error", message, fatal: FATAL_ERROR_NAMES.has(name) || !sessionId });
				break;
			}
			case "file.edited": {
				const file = String(props.file ?? "");
				if (file) {
					this.changedFiles.add(file);
					out.push({ kind: "files-changed", files: [file] });
				}
				break;
			}
			case "session.diff": {
				const diff = (props.diff ?? []) as Array<Record<string, unknown>>;
				const files = diff.map((d) => String(d.file ?? "")).filter(Boolean);
				for (const f of files) this.changedFiles.add(f);
				if (files.length) out.push({ kind: "files-changed", files });
				break;
			}
			default:
				break;
		}
		return out;
	}

	private handlePart(part: Record<string, unknown>): NormalizedEvent[] {
		const out: NormalizedEvent[] = [];
		const partType = String(part.type ?? "");
		const partId = String(part.id ?? "");

		if (partType === "text") {
			const text = String(part.text ?? "");
			const seen = this.textByPart.get(partId) ?? "";
			if (text.length > seen.length && text.startsWith(seen)) {
				const suffix = text.slice(seen.length);
				this.textByPart.set(partId, text);
				if (suffix) out.push({ kind: "text", text: suffix });
			}
			return out;
		}

		if (partType === "reasoning") {
			const text = String(part.text ?? "");
			const seen = this.reasoningByPart.get(partId) ?? "";
			if (text.length > seen.length && text.startsWith(seen)) {
				const suffix = text.slice(seen.length);
				this.reasoningByPart.set(partId, text);
				if (suffix) out.push({ kind: "reasoning", text: suffix });
			}
			return out;
		}

		if (partType !== "tool") return out;

		const callId = String(part.callID ?? "");
		const toolName = String(part.tool ?? "tool");
		if (!callId) return out;
		this.toolNames.set(callId, toolName);

		const state = (part.state ?? {}) as Record<string, unknown>;
		const status = String(state.status ?? "pending");
		const input = state.input ?? {};
		const time = (state.time ?? {}) as Record<string, unknown>;
		const startedAt = typeof time.start === "number" ? time.start : undefined;
		const endedAt = typeof time.end === "number" ? time.end : undefined;
		const previous = this.tools.get(callId);

		const metadata = (state.metadata ?? {}) as Record<string, unknown>;
		const exitCode = readExitCode(metadata);
		// A command that exits non-zero still comes back as `completed` from the
		// engine: the only honest signal is the exit code in metadata.
		const failedByExit = status === "completed" && exitCode !== undefined && exitCode !== 0;
		const failureReason = failedByExit ? `命令以非零退出码 ${exitCode} 结束` : undefined;

		const next: ToolNodeSnapshot = {
			toolCallId: callId,
			toolName,
			phase:
				status === "error" || failedByExit
					? "failure"
					: status === "completed"
						? "success"
						: status === "running"
							? "running"
							: "pending",
			input,
			output: typeof state.output === "string" ? state.output : previous?.output,
			error: typeof state.error === "string" ? state.error : (failureReason ?? previous?.error),
			title: typeof state.title === "string" ? state.title : previous?.title,
			startedAt: startedAt ?? previous?.startedAt ?? Date.now(),
			endedAt,
			metadata,
			exitCode: exitCode ?? previous?.exitCode,
		};
		this.tools.set(callId, next);

		if (!previous) {
			out.push({ kind: "tool-start", toolCallId: callId, toolName, input });
		}

		if (status === "completed") {
			if (previous?.phase !== "success" && previous?.phase !== "failure") {
				out.push({
					kind: "tool-end",
					toolCallId: callId,
					toolName,
					input,
					output: next.output ?? "",
					error: failureReason,
					durationMs: endedAt && next.startedAt ? endedAt - next.startedAt : undefined,
					exitCode,
				});
			}
		} else if (status === "error") {
			if (previous?.phase !== "failure") {
				out.push({
					kind: "tool-end",
					toolCallId: callId,
					toolName,
					input,
					output: next.output,
					error: next.error ?? "tool failed",
					durationMs: endedAt && next.startedAt ? endedAt - next.startedAt : undefined,
					exitCode,
				});
			}
		}
		return out;
	}
}
