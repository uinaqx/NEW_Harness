/**
 * Event sampler for the pinned OpenCode build.
 *
 * Runs one full scripted conversation (write tool -> allow, bash tool -> reject,
 * final text) while recording the first full payload seen for every event type.
 * Output is written to testing/opencode-event-samples.json and is the empirical
 * contract the harness event mapper is written against.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockProvider } from "./mock-provider";

const BIN = join(import.meta.dir, "..", "vendor", "opencode", "bin", "opencode.exe");

const root = await mkdtemp(join(tmpdir(), "harness-sample-"));
const workspace = join(root, "project");
const cfg = {
	$schema: "https://opencode.ai/config.json",
	model: "harnessmock/mock-model",
	provider: {
		harnessmock: {
			npm: "@ai-sdk/openai-compatible",
			name: "Harness Mock",
			options: { baseURL: "", apiKey: "mock" },
			models: { "mock-model": { id: "mock-model", name: "Mock", tool_call: true, limit: { context: 100000, output: 8000 } } },
		},
	},
	permission: { edit: "ask", bash: "ask" },
	lsp: false,
	formatter: false,
	plugin: [],
	autoupdate: false,
	share: "disabled",
};
const mock = startMockProvider({ port: 0 });
cfg.provider.harnessmock.options.baseURL = `${mock.url}/v1`;
await mkdir(workspace, { recursive: true });
await mkdir(join(root, "cfg", "opencode"), { recursive: true });
await writeFile(join(root, "cfg", "opencode", "opencode.json"), JSON.stringify(cfg), "utf8");

const PORT = 45991;
const proc = spawn(BIN, ["serve", "--hostname=127.0.0.1", `--port=${PORT}`], {
	cwd: workspace,
	env: {
		...process.env,
		OPENCODE_CONFIG: join(root, "cfg", "opencode", "opencode.json"),
		OPENCODE_CONFIG_CONTENT: JSON.stringify(cfg),
		XDG_STATE_HOME: join(root, "state"),
		XDG_CONFIG_HOME: join(root, "cfg"),
		XDG_CACHE_HOME: join(root, "cache"),
		XDG_DATA_HOME: join(root, "data"),
	},
	stdio: ["ignore", "pipe", "pipe"],
	windowsHide: true,
});
proc.stdout.on("data", () => {});
proc.stderr.on("data", () => {});

const base = `http://127.0.0.1:${PORT}`;
const dir = encodeURIComponent(workspace);
let ready = false;
for (let i = 0; i < 150; i++) {
	try {
		if ((await fetch(`${base}/path?directory=${dir}`)).ok) {
			ready = true;
			break;
		}
	} catch {}
	await Bun.sleep(200);
}
if (!ready) throw new Error("server never became ready");
console.log("server ready on", base);

const samples = new Map<string, unknown>();
const counts = new Map<string, number>();
const order: string[] = [];
const sseAbort = new AbortController();
const sseDone = (async () => {
	try {
		const r = await fetch(`${base}/event?directory=${dir}`, { signal: sseAbort.signal, headers: { accept: "text/event-stream" } });
		const reader = r.body!.pipeThrough(new TextDecoderStream()).getReader();
		let buf = "";
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buf += value;
			const chunks = buf.split("\n\n");
			buf = chunks.pop() ?? "";
			for (const chunk of chunks) {
				const dataLine = chunk.split("\n").find((l) => l.startsWith("data:"));
				if (!dataLine) continue;
				try {
					const parsed = JSON.parse(dataLine.slice(5).trim()) as { type?: string; properties?: unknown };
					const type = String(parsed.type ?? "?");
					counts.set(type, (counts.get(type) ?? 0) + 1);
					if (!samples.has(type)) {
						samples.set(type, parsed);
						order.push(type);
					}
				} catch {}
			}
		}
	} catch {}
})();

/** Answer the next unseen permission request for this session. */
async function nextPermission(sessionID: string, seen: Set<string>) {
	const start = Date.now();
	while (Date.now() - start < 30_000) {
		for (const [type, sample] of samples) {
			if (type !== "permission.asked" && type !== "permission.updated") continue;
			const p = (sample as { properties?: Record<string, unknown> }).properties ?? {};
			const pid = String(p.id);
			if (String(p.sessionID) !== sessionID || seen.has(pid)) continue;
			seen.add(pid);
			return p;
		}
		await Bun.sleep(80);
	}
	return null;
}

async function replyPermission(sessionID: string, permissionID: string, decision: string) {
	const res = await fetch(`${base}/session/${sessionID}/permissions/${permissionID}?directory=${dir}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ response: decision }),
	});
	return { status: res.status, body: (await res.text()).slice(0, 300) };
}

const created = await fetch(`${base}/session?directory=${dir}`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ title: "sample" }),
});
const session = (await created.json()) as { id: string };
console.log("session", session.id);

const seenPermissions = new Set<string>();
async function prompt(text: string, decisions: string[], timeoutMs = 60_000) {
	const ac = new AbortController();
	const t = setTimeout(() => ac.abort(), timeoutMs);
	const run = fetch(`${base}/session/${session.id}/message?directory=${dir}`, {
		method: "POST",
		signal: ac.signal,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ model: { providerID: "harnessmock", modelID: "mock-model" }, parts: [{ type: "text", text }] }),
	}).then(async (r) => ({ status: r.status, body: await r.json() }));
	try {
		// Answer every permission this prompt raises, in order.
		for (const decision of decisions) {
			const perm = await nextPermission(session.id, seenPermissions);
			if (!perm) break;
			const reply = await replyPermission(session.id, String(perm.id), decision);
			console.log(`  permission(${perm.permission}) -> ${decision}: HTTP ${reply.status}`);
		}
		const result = await run;
		return result;
	} finally {
		clearTimeout(t);
		ac.abort();
	}
}

console.log("=== turn 1: write tool, allow ===");
console.log("turn1 status", (await prompt("写一个文件", ["once"])).status);
console.log("=== turn 2: bash tool, reject ===");
console.log("turn2 status", (await prompt("跑个命令", ["reject"])).status);
console.log("=== turn 3: edit tool, allow (exercises diff metadata) ===");
console.log("turn3 status", (await prompt("改文件", ["once"])).status);
console.log("=== turn 4: bash exit 7 (non-zero exit code) ===");
console.log("turn4 status", (await prompt("失败命令", ["once"])).status);
console.log("=== turn 5: plain text ===");
console.log("turn5 status", (await prompt("总结一下", [])).status);

await Bun.sleep(1000);

// Message + part shapes.
const msgs = await fetch(`${base}/session/${session.id}/message?directory=${dir}`).then((r) => r.json());
const diffs = await fetch(`${base}/session/${session.id}/diff?directory=${dir}`).then((r) => r.json());
const status = await fetch(`${base}/session/status?directory=${dir}`).then((r) => r.json());

const partTypes = new Map<string, unknown>();
for (const m of msgs as Array<Record<string, unknown>>) {
	for (const part of ((m.parts ?? []) as Array<Record<string, unknown>>)) {
		const t = String(part.type ?? "?");
		if (!partTypes.has(t)) partTypes.set(t, { messageRole: m.info ? (m.info as Record<string, unknown>).role : undefined, part });
	}
}

sseAbort.abort();
await sseDone.catch(() => {});
proc.kill();
mock.stop();

const report = {
	generatedAt: new Date().toISOString(),
	opencodeVersion: "1.18.31",
	eventTypeCounts: Object.fromEntries([...counts].sort((a, b) => b[1] - a[1])),
	eventSamples: Object.fromEntries(order.map((t) => [t, samples.get(t)])),
	partSamples: Object.fromEntries(partTypes),
	messageCount: (msgs as unknown[]).length,
	messageSamples: (msgs as unknown[]).slice(0, 3),
	diffSamples: diffs,
	sessionStatusShape: status,
	mockRequests: mock.requests.length,
};
await writeFile(join(import.meta.dir, "opencode-event-samples.json"), JSON.stringify(report, null, 2), "utf8");
console.log("event types:", JSON.stringify(report.eventTypeCounts));
console.log("part types:", JSON.stringify([...partTypes.keys()]));
console.log("messages:", report.messageCount, "diffs:", JSON.stringify(diffs).slice(0, 300));
console.log("wrote testing/opencode-event-samples.json");
await Bun.sleep(200);
process.exit(0);
