import type { ChatMessage } from "@/lib/chat-schema";

export const NODE_WIDTH = 184;
export const NODE_GAP = 32;

export function executionCapacity(width: number): number {
	return Math.max(1, Math.floor((Math.max(0, width - 32) + NODE_GAP) / (NODE_WIDTH + NODE_GAP)));
}

/** A node is "terminal" once the engine has finished with it. */
function isLiveNode(message: ChatMessage): boolean {
	const phase = message.meta?.phase;
	if (phase === "running" || phase === "pending") return true;
	// Older chunks only set hookEventName; treat a started-but-unfinished node as live.
	return message.meta?.hookEventName === "tool_call_start";
}

/**
 * Drop the oldest finished nodes once the track overflows the available width.
 * Nodes that are still executing, or that are waiting for an authorisation
 * decision, are never evicted — the plan requires their entry points to stay
 * reachable.
 */
export function pruneExecutionMessages(messages: ChatMessage[], capacity: number, protectedToolCallIds: string[] = []): ChatMessage[] {
	const steps = messages.filter((message) => message.role === "tool");
	let excess = Math.max(0, steps.length - Math.max(1, capacity));
	if (!excess) return messages;
	const keepLive = (message: ChatMessage) => isLiveNode(message) || (!!message.meta?.toolCallId && protectedToolCallIds.includes(message.meta.toolCallId));
	const kept = messages.filter((message) => {
		if (excess && message.role === "tool" && !keepLive(message)) {
			excess--;
			return false;
		}
		return true;
	});
	return kept.length === messages.length ? messages : kept;
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
