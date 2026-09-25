import type { ChatMessage } from "@/lib/chat-schema";

export const TRACE_ROW_HEIGHT = 34;

/** The trace is vertical. Reserve room for its heading and any approval prompts. */
export function executionCapacity(height: number, approvals = 0): number {
	return Math.max(1, Math.floor((Math.max(0, height) - 58 - approvals * 68) / TRACE_ROW_HEIGHT));
}

/** Never replay a previous turn's tool nodes in the live trace. */
export function currentTurnSteps(messages: ChatMessage[]): ChatMessage[] {
	const lastUser = messages.findLastIndex((message) => message.role === "user");
	return messages.slice(lastUser + 1).filter((message) => message.role === "tool");
}

/** A node is "terminal" once the engine has finished with it. */
function isLiveNode(message: ChatMessage): boolean {
	const phase = message.meta?.phase;
	if (phase === "running" || phase === "pending") return true;
	// Older chunks only set hookEventName; treat a started-but-unfinished node as live.
	return message.meta?.hookEventName === "tool_call_start";
}

/**
 * Drop the oldest finished nodes once the trace exceeds the available height.
 * Nodes that are still executing, or that are waiting for an authorisation
 * decision, are never evicted — the plan requires their entry points to stay
 * reachable.
 */
export function pruneExecutionMessages(messages: ChatMessage[], capacity: number, protectedToolCallIds: string[] = []): ChatMessage[] {
	const steps = currentTurnSteps(messages);
	let excess = Math.max(0, steps.length - Math.max(1, capacity));
	if (!excess) return messages;
	const currentIds = new Set(steps.map((message) => message.id));
	const keepLive = (message: ChatMessage) => isLiveNode(message) || (!!message.meta?.toolCallId && protectedToolCallIds.includes(message.meta.toolCallId));
	const kept = messages.filter((message) => {
		if (excess && currentIds.has(message.id) && !keepLive(message)) {
			excess--;
			return false;
		}
		return true;
	});
	return kept.length === messages.length ? messages : kept;
}

/** A short, safe label derived from the engine's real input, for the trace row. */
export function executionDescription(message: ChatMessage): string {
	const payload = executionPayload(message);
	const input = payload.input;
	if (input && typeof input === "object" && !Array.isArray(input)) {
		const record = input as Record<string, unknown>;
		for (const key of ["description", "filePath", "path", "command", "pattern", "query", "url", "name"]) {
			const value = record[key];
			if (typeof value === "string" && value.trim()) return value.replace(/\s+/g, " ").trim().slice(0, 180);
		}
	}
	return message.meta?.title?.trim() || "查看执行详情";
}

export function executionPayload(message: ChatMessage): { input?: unknown; result?: unknown; output?: unknown; error?: string; exitCode?: number; isError?: boolean } {
	try {
		return JSON.parse(message.content);
	} catch {
		return {};
	}
}

export function executionFailed(value: unknown): boolean {
	if (Array.isArray(value)) return value.some(executionFailed);
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	if (typeof record.exitCode === "number" && record.exitCode !== 0) return true;
	return Boolean(record.error || record.isError || record.success === false) || executionFailed(record.output) || executionFailed(record.result);
}

/** Human label for a node's outcome, including the engine's exit code. */
export function executionOutcome(message: ChatMessage, running: boolean, interrupted: boolean, awaitingApproval: boolean): string {
	if (awaitingApproval) return "等待授权";
	if (running) return "执行中";
	if (interrupted) return "已中断";
	const payload = executionPayload(message);
	if (typeof payload.exitCode === "number" && payload.exitCode !== 0) return `失败 · 退出码 ${payload.exitCode}`;
	if (executionFailed(payload)) return "失败";
	return "已结束";
}
