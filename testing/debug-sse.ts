/** Focused debug: raw SSE + raw prompt against the pinned opencode server. */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockProvider } from "./mock-provider";

const BIN = join(import.meta.dir, "..", "vendor", "opencode", "bin", "opencode.exe");

const root = await mkdtemp(join(tmpdir(), "harness-dbg-"));
const workspace = join(root, "project");
const cfg = {
	model: "harnessmock/mock-model",
	provider: {
		harnessmock: {
			npm: "@ai-sdk/openai-compatible",
			name: "Harness Mock",
			options: { baseURL: "", apiKey: "k" },
			models: { "mock-model": { id: "mock-model", name: "Mock", tool_call: true, limit: { context: 100000, output: 8000 } } },
		},
	},
	permission: { edit: "ask", bash: "ask" },
	lsp: false,
	formatter: false,
	plugin: [],
	autoupdate: false,
};
const mock = startMockProvider({ port: 0 });
cfg.provider.harnessmock.options.baseURL = `${mock.url}/v1`;
await mkdir(workspace, { recursive: true });
await mkdir(join(root, "cfg", "opencode"), { recursive: true });
await writeFile(join(root, "cfg", "opencode", "opencode.json"), JSON.stringify(cfg), "utf8");

const proc = spawn(BIN, ["serve", "--hostname=127.0.0.1", "--port=45990", "--print-logs", "--log-level=INFO"], {
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
const logs: string[] = [];
proc.stdout.on("data", (c: Buffer) => logs.push(`[o] ${c.toString()}`));
proc.stderr.on("data", (c: Buffer) => logs.push(`[e] ${c.toString()}`));
proc.on("exit", (c) => logs.push(`[exit] ${c}`));

const base = "http://127.0.0.1:45990";
const dir = encodeURIComponent(workspace);
for (let i = 0; i < 100; i++) {
	try {
		const r = await fetch(`${base}/path?directory=${dir}`);
		if (r.ok) break;
	} catch {}
	await Bun.sleep(200);
}
console.log("server ready");

// 1. raw SSE
const sseAbort = new AbortController();
const sseEvents: string[] = [];
const sse = fetch(`${base}/event?directory=${dir}`, { signal: sseAbort.signal, headers: { accept: "text/event-stream" } })
	.then(async (r) => {
		console.log("SSE status", r.status, r.headers.get("content-type"));
		const reader = r.body!.pipeThrough(new TextDecoderStream()).getReader();
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			for (const line of value.split("\n")) {
				if (line.startsWith("data:")) sseEvents.push(line.slice(5).trim());
			}
		}
	})
	.catch((e: Error) => console.log("SSE error:", e.message, (e as { cause?: unknown }).cause));

await Bun.sleep(800);
console.log("events so far:", sseEvents.length, sseEvents.slice(0, 3).map((s) => s.slice(0, 120)));

// 2. create session
const created = await fetch(`${base}/session?directory=${dir}`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ title: "dbg" }),
});
const session = (await created.json()) as { id: string };
console.log("session", session.id);

// 3. prompt, and while waiting, watch the SSE + poll messages
const promptPromise = fetch(`${base}/session/${session.id}/message?directory=${dir}`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ model: { providerID: "harnessmock", modelID: "mock-model" }, parts: [{ type: "text", text: "写文件" }] }),
})
	.then(async (r) => console.log("prompt status", r.status, (await r.text()).slice(0, 400)))
	.catch((e: Error) => console.log("prompt error:", e.message, JSON.stringify((e as { cause?: unknown }).cause)));

for (let i = 0; i < 12; i++) {
	await Bun.sleep(1000);
	const types = new Map<string, number>();
	for (const s of sseEvents) {
		try {
			const t = String(JSON.parse(s).type ?? "?");
			types.set(t, (types.get(t) ?? 0) + 1);
		} catch {}
	}
	const perm = await fetch(`${base}/session/${session.id}/message?directory=${dir}`).then((r) => r.status);
	console.log(`t=${i + 1}s sse=${sseEvents.length} types=${JSON.stringify([...types])} msgsStatus=${perm}`);
	if ([...types.keys()].some((k) => k.includes("permission"))) break;
}

console.log("--- engine log tail ---");
console.log(logs.join("").split("\n").slice(-25).join("\n"));
sseAbort.abort();
proc.kill();
mock.stop();
await Bun.sleep(300);
process.exit(0);
