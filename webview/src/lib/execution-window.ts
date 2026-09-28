import type { ChatMessage } from "@/lib/chat-schema";

export const TRACE_ROW_HEIGHT = 34;

/** The trace is vertical. Reserve room for its heading and any approval prompts. */
export function executionCapacity(height: number, approvals = 0): number {
	return Math.min(6, Math.max(1, Math.floor((Math.max(0, height) - 90 - approvals * 68) / TRACE_ROW_HEIGHT)));
}

/** Finished steps move into the horizontal archive; live/approval steps stay in the main trace. */
export function splitExecutionSteps(messages: ChatMessage[], capacity = 6, protectedIds: string[] = []) {
	const steps = currentTurnSteps(messages);
	let excess = Math.max(0, steps.length - Math.min(6, Math.max(1, capacity)));
	const archived: ChatMessage[] = [];
	const current: ChatMessage[] = [];
	for (const step of steps) {
		if (excess > 0 && !isLiveNode(step) && !protectedIds.includes(step.meta?.toolCallId ?? "")) { archived.push(step); excess--; }
		else current.push(step);
	}
	return { archived, current };
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
	if (message.meta?.stepIntent) return message.meta.stepIntent;
	const payload = executionPayload(message);
	const input = payload.input;
	if (input && typeof input === "object" && !Array.isArray(input)) {
		const record = input as Record<string, unknown>;
		for (const key of ["description", "filePath", "path", "command", "pattern", "query", "url", "name"]) {
			const value = record[key];
			if (typeof value === "string" && value.trim()) return `${executionExplanation(message)} · ${value.replace(/\s+/g, " ").trim().slice(0, 180)}`;
		}
	}
	return message.meta?.title?.trim() ? `${executionExplanation(message)} · ${message.meta.title.trim()}` : executionExplanation(message);
}

export function executionExplanation(message: ChatMessage): string {
	const name = message.meta?.toolName?.toLowerCase() ?? "";
	if (message.meta?.messageKind === "reasoning") return "分析问题与下一步行动";
	if (/^read$/.test(name)) return "阅读文件内容";
	if (/edit|patch/.test(name)) return "修改文件代码";
	if (/write/.test(name)) return "写入文件内容";
	if (/bash|dash|shell|command/.test(name)) return "执行命令或测试";
	if (/grep|search/.test(name)) return "搜索相关内容";
	if (/glob|list/.test(name)) return "查找项目文件";
	if (/task/.test(name)) return "处理子任务";
	if (/skill/.test(name)) return "加载所选技能";
	if (/todo/.test(name)) return "更新任务计划";
	if (/web|fetch/.test(name)) return "获取网页内容";
	if (/question/.test(name)) return "等待用户补充信息";
	return "处理当前步骤";
}

export function executionMetrics(message: ChatMessage): { readLines?: number; additions?: number; deletions?: number } {
	if (message.meta?.phase !== "success" || executionFailed(executionPayload(message))) return {};
	const name = message.meta?.toolName ?? "";
	const meta = message.meta?.toolMetadata ?? {};
	const payload = executionPayload(message);
	const output = message.meta?.toolOutput || (typeof payload.output === "string" ? payload.output : "");
	if (/^read$/i.test(name)) {
		if (typeof meta.linesRead === "number") return { readLines: meta.linesRead };
		const numbered = output.split("\n").filter((line) => /^\s*\d+\s*[:|]/.test(line));
		if (numbered.length) return { readLines: numbered.length };
		const body = output.match(/<(?:content|file)>\n?([\s\S]*?)<\/(?:content|file)>/i)?.[1];
		if (body !== undefined) return { readLines: body.trimEnd() ? body.trimEnd().split("\n").length : 0 };
		return {};
	}
	if (/edit|write|patch/i.test(name)) {
		const diff = meta.filediff as Record<string, unknown> | undefined;
		if (typeof diff?.additions === "number" && typeof diff.deletions === "number") return { additions: diff.additions, deletions: diff.deletions };
		const patch = typeof meta.diff === "string" ? meta.diff : typeof diff?.patch === "string" ? diff.patch : undefined;
		if (patch) return { additions: patch.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).length, deletions: patch.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---")).length };
	}
	return {};
}

export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	return seconds < 60 ? `${seconds}秒` : seconds < 3600 ? `${Math.floor(seconds / 60)}分${seconds % 60}秒` : `${Math.floor(seconds / 3600)}小时${Math.floor(seconds % 3600 / 60)}分`;
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
