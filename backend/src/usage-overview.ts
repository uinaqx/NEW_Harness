import type { UsageDay, UsageOverviewPayload } from "../../shared/types";

type RawMessage = { info?: Record<string, any>; parts?: Array<Record<string, any>> };
const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
export function localDate(timestamp: number): string {
	const date = new Date(timestamp);
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export function emptyUsageOverview(sessions = 0): UsageOverviewPayload {
	return { sessions, turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, unavailableSessions: 0, truncatedSessions: 0, workTurns: 0, chatTurns: 0, toolCalls: 0, totalDurationMs: 0, longestTurnMs: 0, days: [], skills: [], models: [] };
}

/** Each assistant message is counted once, not once per step-finish/tool part. */
export function collectSessionUsage(raw: RawMessage[], kind: "work" | "chat"): UsageOverviewPayload {
	const result = emptyUsageOverview();
	const days = new Map<string, UsageDay>();
	const skills = new Map<string, number>();
	const models = new Map<string, { id: string; replies: number; tokens: number }>();
	const users = new Map<string, { start: number; end: number }>();
	const seenMessages = new Set<string>();
	const seenTools = new Set<string>();
	let currentUser = "";
	const dayAt = (timestamp: number) => {
		const key = localDate(timestamp);
		if (!days.has(key)) days.set(key, { date: key, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, turns: 0 });
		return days.get(key)!;
	};
	for (const entry of raw.slice().sort((a, b) => count(a.info?.time?.created) - count(b.info?.time?.created))) {
		const info = entry.info ?? {};
		const id = String(info.id ?? "");
		if (id && seenMessages.has(id)) continue;
		if (id) seenMessages.add(id);
		const created = count(info.time?.created);
		if (info.role === "user") {
			currentUser = id;
			users.set(id, { start: created, end: 0 });
			continue;
		}
		if (info.role !== "assistant") continue;
		const input = count(info.tokens?.input), output = count(info.tokens?.output), cache = count(info.tokens?.cache?.read);
		result.inputTokens += input; result.outputTokens += output; result.cacheReadTokens += cache;
		if (created) { const day = dayAt(created); day.inputTokens += input; day.outputTokens += output; day.cacheReadTokens += cache; }
		const parts = entry.parts ?? [];
		const tools = parts.filter((part) => part.type === "tool");
		const completed = count(info.time?.completed);
		if (completed && !info.error && info.finish !== "tool-calls" && (info.finish || !tools.length)) {
			const turn = users.get(String(info.parentID ?? currentUser));
			if (turn) turn.end = Math.max(turn.end, completed);
		}
		const modelId = String(info.modelID ?? "未知模型");
		const model = models.get(modelId) ?? { id: modelId, replies: 0, tokens: 0 };
		model.tokens += input + output + cache;
		if (completed) model.replies++;
		models.set(modelId, model);
		for (const part of tools) {
			const toolId = String(part.callID ?? part.id ?? "");
			if (toolId && seenTools.has(toolId)) continue;
			if (toolId) seenTools.add(toolId);
			result.toolCalls++;
			if (part.tool === "skill" && part.state?.status === "completed") {
				const skill = String(part.state?.input?.name ?? "").trim();
				if (skill) skills.set(skill, (skills.get(skill) ?? 0) + 1);
			}
		}
	}
	for (const turn of users.values()) {
		if (!turn.end) continue;
		result.turns++;
		if (turn.start) dayAt(turn.start).turns++;
		const duration = turn.start ? Math.max(0, turn.end - turn.start) : 0;
		result.totalDurationMs += duration;
		result.longestTurnMs = Math.max(result.longestTurnMs, duration);
	}
	result[kind === "chat" ? "chatTurns" : "workTurns"] = result.turns;
	result.days = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
	result.skills = [...skills].map(([id, calls]) => ({ id, calls })).sort((a, b) => b.calls - a.calls || a.id.localeCompare(b.id));
	result.models = [...models.values()].sort((a, b) => b.tokens - a.tokens || a.id.localeCompare(b.id));
	return result;
}

export function mergeUsageOverview(target: UsageOverviewPayload, source: UsageOverviewPayload): void {
	for (const key of ["turns", "inputTokens", "outputTokens", "cacheReadTokens", "workTurns", "chatTurns", "toolCalls", "totalDurationMs"] as const) target[key] += source[key];
	target.longestTurnMs = Math.max(target.longestTurnMs, source.longestTurnMs);
	for (const day of source.days) {
		const existing = target.days.find((item) => item.date === day.date);
		if (existing) for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "turns"] as const) existing[key] += day[key];
		else target.days.push({ ...day });
	}
	for (const skill of source.skills) { const existing = target.skills.find((item) => item.id === skill.id); if (existing) existing.calls += skill.calls; else target.skills.push({ ...skill }); }
	for (const model of source.models) { const existing = target.models.find((item) => item.id === model.id); if (existing) { existing.tokens += model.tokens; existing.replies += model.replies; } else target.models.push({ ...model }); }
}
