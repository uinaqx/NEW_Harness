/** Read-only smoke test against the installed app; never logs transcripts or credentials. */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { InstalledClient } from "./installed-client";
import type { UsageOverviewPayload } from "../shared/types";

const root = resolve(import.meta.dir, "..");
const version = (await Bun.file(join(root, "package.json")).json()).version;
const client = new InstalledClient();
const checks: Array<{ name: string; ok: boolean }> = [];
const check = (name: string, ok: boolean) => { checks.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"} ${name}`); if (!ok) throw new Error(name); };
try {
	const health = await client.connect();
	check("installed backend serves the current version", health.ok && health.appVersion === version);
	const pong = await client.invoke("ping");
	check("installed authenticated transport responds", pong.version === version);
	const usage = await client.invoke("get_usage_overview") as UsageOverviewPayload;
	check("installed personal overview returns real activity and skill arrays", Array.isArray(usage.days) && Array.isArray(usage.skills) && Array.isArray(usage.models));
	check("daily totals match all retained Token records", (["inputTokens", "outputTokens", "cacheReadTokens"] as const).every((key) => usage.days.reduce((sum, day) => sum + day[key], 0) === usage[key]));
	check("Work and Chat rounds add up", usage.turns === usage.workTurns + usage.chatTurns);
	check("calendar dates use sorted local calendar keys", usage.days.every((day, index) => /^\d{4}-\d{2}-\d{2}$/.test(day.date) && (index === 0 || day.date > usage.days[index - 1].date)));
	const out = join(root, "delivery", "qa", version);
	await mkdir(out, { recursive: true });
	await writeFile(join(out, "installed-overview-report.json"), JSON.stringify({ version, at: new Date().toISOString(), passed: true, checks, summary: { sessions: usage.sessions, turns: usage.turns, days: usage.days.length, skills: usage.skills.length, unavailable: usage.unavailableSessions, truncated: usage.truncatedSessions } }, null, 2));
} finally { client.close(); }
