/** Where does the engine expose file diffs for a session? */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockProvider } from "./mock-provider";

const BIN = join(import.meta.dir, "..", "vendor", "opencode", "bin", "opencode.exe");
const root = await mkdtemp(join(tmpdir(), "harness-diff-"));
const workspace = join(root, "project");
const cfg: Record<string, unknown> = {
	model: "harnessmock/mock-model",
	provider: {
		harnessmock: {
			npm: "@ai-sdk/openai-compatible",
			name: "Mock",
			options: { baseURL: "", apiKey: "m" },
			models: { "mock-model": { id: "mock-model", name: "Mock", tool_call: true, limit: { context: 100000, output: 8000 } } },
		},
	},
	permission: { edit: "allow", bash: "allow" },
	lsp: false,
	formatter: false,
	plugin: [],
	snapshot: true,
	share: "disabled",
};
const mock = startMockProvider({ port: 0 });
(cfg.provider as Record<string, Record<string, Record<string, string>>>).harnessmock.options.baseURL = `${mock.url}/v1`;
await mkdir(workspace, { recursive: true });
await mkdir(join(root, "cfg", "opencode"), { recursive: true });
await writeFile(join(root, "cfg", "opencode", "opencode.json"), JSON.stringify(cfg), "utf8");
await writeFile(join(workspace, "README.md"), "# phase1 workspace\n", "utf8");
Bun.spawnSync(["git", "init", "-q"], { cwd: workspace });
Bun.spawnSync(["git", "add", "-A"], { cwd: workspace });
Bun.spawnSync(["git", "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "init"], { cwd: workspace });

const PORT = 45993;
const proc = spawn(BIN, ["serve", "--hostname=127.0.0.1", `--port=${PORT}`], {
	cwd: workspace,
	env: {
		...process.env,
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
for (let i = 0; i < 150; i++) {
	try {
		if ((await fetch(`${base}/path?directory=${dir}`)).ok) break;
	} catch {}
	await Bun.sleep(200);
}
const created = await fetch(`${base}/session?directory=${dir}`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ title: "diff" }),
}).then((r) => r.json() as Promise<{ id: string }>);
const sid = created.id;

await fetch(`${base}/session/${sid}/message?directory=${dir}`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ model: { providerID: "harnessmock", modelID: "mock-model" }, parts: [{ type: "text", text: "写文件" }] }),
});
await Bun.sleep(1500);
await fetch(`${base}/session/${sid}/message?directory=${dir}`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ model: { providerID: "harnessmock", modelID: "mock-model" }, parts: [{ type: "text", text: "改文件" }] }),
});
await Bun.sleep(2000);

const msgs = (await fetch(`${base}/session/${sid}/message?directory=${dir}`).then((r) => r.json())) as Array<Record<string, unknown>>;
console.log("=== tool parts ===");
for (const m of msgs) {
	for (const p of ((m.parts ?? []) as Array<Record<string, unknown>>)) {
		if (p.type !== "tool") continue;
		console.log(JSON.stringify(p, null, 1).slice(0, 2000));
		console.log("---");
	}
}
console.log("=== session.diff (no messageID) ===");
console.log(JSON.stringify(await fetch(`${base}/session/${sid}/diff?directory=${dir}`).then((r) => r.json())).slice(0, 800));
for (const m of msgs) {
	const info = m.info as Record<string, unknown>;
	const r = await fetch(`${base}/session/${sid}/diff?directory=${dir}&messageID=${info.id}`).then((x) => x.json());
	if (JSON.stringify(r) !== "[]" && JSON.stringify(r) !== "{}") {
		console.log(`=== session.diff messageID=${info.id} (${info.role}) ===`);
		console.log(JSON.stringify(r).slice(0, 1200));
	}
}
console.log("=== vcs.get ===");
console.log(JSON.stringify(await fetch(`${base}/vcs?directory=${dir}`).then((r) => r.json())).slice(0, 500));
console.log("=== session.get summary ===");
console.log(JSON.stringify(await fetch(`${base}/session/${sid}?directory=${dir}`).then((r) => r.json())).slice(0, 900));

proc.kill();
mock.stop();
await Bun.sleep(200);
process.exit(0);
