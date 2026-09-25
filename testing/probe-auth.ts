/** How does the pinned build authenticate when OPENCODE_SERVER_PASSWORD is set? */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BIN = join(import.meta.dir, "..", "vendor", "opencode", "bin", "opencode.exe");
const root = await mkdtemp(join(tmpdir(), "harness-auth-"));
const workspace = join(root, "project");
await mkdir(workspace, { recursive: true });
await mkdir(join(root, "cfg", "opencode"), { recursive: true });
await writeFile(join(root, "cfg", "opencode", "opencode.json"), JSON.stringify({ plugin: [], lsp: false, formatter: false }), "utf8");

const PASSWORD = "harness-secret-abc123";
const PORT = 45994;
const proc = spawn(BIN, ["serve", "--hostname=127.0.0.1", `--port=${PORT}`], {
	cwd: workspace,
	env: {
		...process.env,
		OPENCODE_SERVER_PASSWORD: PASSWORD,
		OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: [], lsp: false, formatter: false }),
		XDG_STATE_HOME: join(root, "state"),
		XDG_CONFIG_HOME: join(root, "cfg"),
		XDG_CACHE_HOME: join(root, "cache"),
		XDG_DATA_HOME: join(root, "data"),
	},
	stdio: ["ignore", "pipe", "pipe"],
	windowsHide: true,
});
proc.stdout.on("data", (c: Buffer) => process.stdout.write(`[o] ${c.toString()}`));
proc.stderr.on("data", () => {});

const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 150; i++) {
	try {
		if ((await fetch(`${base}/path`)).status !== 0) break;
	} catch {}
	await Bun.sleep(200);
}

const attempts: Array<[string, Record<string, string>]> = [
	["no auth", {}],
	["bearer", { authorization: `Bearer ${PASSWORD}` }],
	["basic user:pass", { authorization: `Basic ${btoa(`opencode:${PASSWORD}`)}` }],
	["basic pass:", { authorization: `Basic ${btoa(`${PASSWORD}:`)}` }],
	["x-opencode-password", { "x-opencode-password": PASSWORD }],
];
for (const [label, headers] of attempts) {
	try {
		const r = await fetch(`${base}/path`, { headers });
		console.log(`${label}: ${r.status} ${(await r.text()).slice(0, 120)}`);
	} catch (e) {
		console.log(`${label}: error ${(e as Error).message}`);
	}
}

// Does /event honour the same auth?
for (const [label, headers] of [
	["SSE no auth", { accept: "text/event-stream" }],
	["SSE bearer", { accept: "text/event-stream", authorization: `Bearer ${PASSWORD}` }],
] as Array<[string, Record<string, string>]>) {
	try {
		const ac = new AbortController();
		const r = await fetch(`${base}/event`, { headers, signal: ac.signal });
		console.log(`${label}: ${r.status}`);
		ac.abort();
	} catch (e) {
		console.log(`${label}: error ${(e as Error).message}`);
	}
}

proc.kill();
await Bun.sleep(200);
process.exit(0);
