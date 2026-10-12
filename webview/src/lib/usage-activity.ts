import type { UsageDay } from "@shared/types";

export type ActivityMode = "daily" | "weekly" | "cumulative";
export const dayTokens = (day?: UsageDay) => day ? day.inputTokens + day.outputTokens + day.cacheReadTokens : 0;
export function dateKey(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Local calendar days at noon avoid UTC offsets and daylight-saving gaps. */
export function activityCalendar(days: UsageDay[], now = new Date()) {
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
	const start = new Date(today); start.setDate(start.getDate() - 364); start.setDate(start.getDate() - start.getDay());
	const lookup = new Map(days.map((day) => [day.date, day]));
	let cumulative = days.filter((day) => day.date < dateKey(start)).reduce((sum, day) => sum + dayTokens(day), 0);
	const weeks = [];
	for (const cursor = new Date(start); cursor <= today;) {
		const cells = [];
		for (let row = 0; row < 7; row++) {
			const date = dateKey(cursor), future = cursor > today;
			const day = lookup.get(date), tokens = future ? 0 : dayTokens(day);
			cumulative += tokens;
			cells.push({ date, tokens, cumulative, turns: day?.turns ?? 0, month: cursor.getMonth() + 1, future });
			cursor.setDate(cursor.getDate() + 1);
		}
		weeks.push({ cells, tokens: cells.reduce((sum, cell) => sum + cell.tokens, 0), start: cells[0].date, end: cells.findLast((cell) => !cell.future)?.date ?? cells[0].date });
	}
	return weeks;
}
export function activityLevel(value: number, max: number): number {
	return value <= 0 || max <= 0 ? 0 : Math.min(4, Math.max(1, Math.ceil(Math.sqrt(value / max) * 4)));
}
