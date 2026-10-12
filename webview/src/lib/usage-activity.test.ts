import { expect, test } from "bun:test";
import { activityCalendar, activityLevel } from "./usage-activity";

test("calendar uses local days, groups weeks and includes earlier totals in cumulative view", () => {
	const days = [ { date: "2023-01-01", inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, turns: 1 }, { date: "2024-02-29", inputTokens: 20, outputTokens: 5, cacheReadTokens: 5, turns: 1 }, { date: "2024-03-01", inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, turns: 1 } ];
	const weeks = activityCalendar(days, new Date(2024, 2, 1, 0, 5));
	const cells = weeks.flatMap((week) => week.cells);
	expect(cells.filter((cell) => cell.date === "2024-02-29")).toHaveLength(1);
	expect(cells.find((cell) => cell.date === "2024-03-01")?.cumulative).toBe(140);
	expect(weeks.at(-1)?.tokens).toBe(40);
	expect(cells.filter((cell) => !cell.future).at(-1)?.date).toBe("2024-03-01");
	expect(new Date(`${weeks[0].start}T12:00:00`).getDay()).toBe(0);
	expect(cells.every((cell, index) => index === 0 || cell.date > cells[index - 1].date)).toBe(true);
});

test("empty history and future padding remain empty", () => {
	const weeks = activityCalendar([], new Date(2026, 9, 12));
	expect(weeks.flatMap((week) => week.cells).every((cell) => cell.tokens === 0 && cell.cumulative === 0)).toBe(true);
	expect(activityLevel(0, 0)).toBe(0); expect(activityLevel(5, 10)).toBe(3); expect(activityLevel(10, 10)).toBe(4);
});
