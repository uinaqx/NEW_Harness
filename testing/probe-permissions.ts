/**
 * Permission probe — establishes ground truth for the reported symptom
 * "在同一会话中，部分命令没有再次询问就执行了".
 *
 * This is a *diagnostic*, not yet a test: it prints what the pinned engine
 * actually asks for, per turn, together with an observable filesystem side
 * effect, so we can tell apart:
 *   (a) the engine never asked again,
 *   (b) the engine asked but Harness failed to surface it,
 *   (c) Harness answered with something wider than "once".
 *
 * Usage: bun testing/probe-permissions.ts
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockProvider } from "./mock-provider";

const BACKEND = join(import.meta.dir, "..", "backend", "src", "index.ts");
const OPENCODE_BIN = join(import.meta.dir, "..", "vendor", "opencode", "bin", "opencode.exe");
const TEST_KEY = "sk-permission-probe-000";

class WS {
	private socket: WebSocket | null = null;
	private counter = 0;
	private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	events: Array<{ name: string; payload: Record<string, unknown> }> = [];

	async connect(url: string): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			const socket = new WebSocket(url);
			this.socket = socket;
			socket.onopen = () => resolve();
			socket.onerror = (e) => reject(new Error(`ws error: ${String((e as ErrorEvent).message ?? "")}`));
			socket.onmessage = (event) => {
				const parsed = JSON.parse(String(event.data)) as Record<string, unknown>;
				if (parsed.type === "event") {
					const wrapper = parsed.event as { name: string; payload: Record<string, unknown> };
					this.events.push({ name: wrapper.name, payload: wrapper.payload });
					return;
				}
				const id = String(parsed.id ?? "");
				const waiter = this.pending.get(id);
				if (!waiter) return;
				this.pending.delete(id);
				if (parsed.ok) waiter.resolve(parsed.result);
				else waiter.reject(new Error(String(parsed.error ?? "command failed")));
			};
		});
	}

	invoke<T>(command: string, args: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<T> {
		const socket = this.socket;
		if (!socket) throw new Error("not connected");
		const id = `p_${this.counter++}`;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`timed out: ${command}`)), timeoutMs);
			this.pending.set(id, {
				resolve: (v) => {
					clearTimeout(timer);
					resolve(v as T);
				},
				reject: (e) => {
					clearTimeout(timer);
					reject(e);
				},
			});
			socket.send(JSON.stringify({ type: "command", id, command, args }));
		});
	}

	async waitFor(
		name: string,
		predicate: (p: Record<string, unknown>) => boolean,
		timeoutMs: number,
		from?: number,
	): Promise<Record<string, unknown> | null> {
		const start = Date.now();
		let cursor = from ?? this.events.length;
		while (Date.now() - start < timeoutMs) {
			const slice = this.events.slice(cursor);
			cursor = this.events.length;
			for (const e of slice) if (e.name === name && predicate(e.payload)) return e.payload;
			await Bun.sleep(50);
		}
		return null;
	}
}

async function startBackend(dataDir: string) {
	const proc = spawn(process.execPath, [BACKEND], {
		env: { ...process.env, HARNESS_DEV: "1", HARNESS_DATA_DIR: dataDir, HARNESS_OPENCODE_BIN: OPENCODE_BIN },
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	let output = "";
	proc.stdout?.on("data", (c: Buffer) => (output += c.toString()));
	proc.stderr?.on("data", (c: Buffer) => (output += c.toString()));
	const runtimeFile = join(dataDir, "runtime.json");
	const deadline = Date.now() + 60_000;
	let handshake: Record<string, unknown> | null = null;
	while (Date.now() < deadline) {
		try {
			const candidate = JSON.parse(await readFile(runtimeFile, "utf8")) as Record<string, unknown>;
			const health = (await fetch(`http://127.0.0.1:${candidate.port}/health`).then((r) => r.json())) as Record<string, unknown>;
			if (String(health.instanceId) === String(candidate.instanceId)) {
				handshake = candidate;
				break;
			}
		} catch {
			/* keep waiting */
		}
		await Bun.sleep(200);
	}
	if (!handshake) throw new Error(`backend handshake failed\n${output.slice(-2000)}`);
	return { proc, port: Number(handshake.port), token: String(handshake.token) };
}

async function main() {
	const root = await mkdtemp(join(tmpdir(), "harness-perm-probe-"));
	const dataDir = join(root, "data");
	const workspace = join(root, "ws");
	await Bun.write(join(workspace, "README.md"), "# probe workspace\n");

	const mock = startMockProvider({});
	const backend = await startBackend(dataDir);
	const client = new WS();
	await client.connect(`ws://127.0.0.1:${backend.port}/transport?token=${backend.token}`);
	await client.invoke("save_model_settings", {
		protocol: "openai-compatible",
		baseUrl: `${mock.url}/v1`,
		model: "mock-model",
		apiKey: TEST_KEY,
	});
	await client.invoke("engine_start", {});
	for (let i = 0; i < 200; i++) {
		const st = (await client.invoke<Record<string, unknown>>("engine_status")) as Record<string, unknown>;
		if (st.state === "running") break;
		await Bun.sleep(300);
	}
	const created = await client.invoke<{ session: { id: string } }>("create_session", { workspaceRoot: workspace });
	const sessionId = created.session.id;

	interface Outcome {
		prompt: string;
		approvals: Array<Record<string, unknown>>;
		toolEnds: string[];
	}
	const outcomes: Outcome[] = [];

	async function turn(prompt: string, decision: "allow" | "reject", waitApprovalMs: number): Promise<Outcome> {
		const cursor = client.events.length;
		await client.invoke("chat_session_command", { action: "send", sessionId, prompt });
		let approvals: Array<Record<string, unknown>> = [];
		if (waitApprovalMs > 0) {
			const found = await client.waitFor(
				"tool_approval_state",
				(p) => String(p.sessionId) === sessionId && ((p.approvals ?? []) as unknown[]).length > 0,
				waitApprovalMs,
				cursor,
			);
			approvals = ((found?.approvals ?? []) as Array<Record<string, unknown>>) ?? [];
			for (const item of approvals) {
				await client.invoke("resolve_tool_approval", {
					sessionId,
					requestId: String(item.requestId),
					decision,
				});
			}
		}
		await client.waitFor("chat_event", (p) => String(p.sessionId) === sessionId && String(p.stream) === "chat_done", 60_000, cursor);
		const toolEnds = client.events
			.slice(cursor)
			.filter((e) => e.name === "chat_event" && String(e.payload.stream) === "chat_tool_call_end")
			.map((e) => String(e.payload.chunk).slice(0, 200));
		const outcome: Outcome = { prompt, approvals, toolEnds };
		outcomes.push(outcome);
		return outcome;
	}

	function report(label: string, o: Outcome) {
		console.log(`\n--- ${label}: prompt="${o.prompt}" ---`);
		console.log(`    approvals surfaced: ${o.approvals.length}`);
		for (const a of o.approvals) {
			console.log(`      · tool=${a.toolName} perm=${JSON.stringify(a.input ?? {}).slice(0, 160)}`);
		}
		for (const t of o.toolEnds) console.log(`      tool-end: ${t}`);
	}

	console.log("=== phase A: distinct bash commands in one session ===");
	report("A1", await turn("命令甲", "allow", 30_000));
	console.log(`    alpha.txt exists after ALLOW: ${existsSync(join(workspace, "alpha.txt"))}`);
	report("A2", await turn("命令乙", "allow", 30_000));
	console.log(`    beta.txt exists after ALLOW: ${existsSync(join(workspace, "beta.txt"))}`);
	report("A3", await turn("命令甲 again", "allow", 30_000));

	console.log("\n=== phase B: file writes ===");
	report("B1", await turn("写文件 X", "allow", 30_000));
	report("B2", await turn("再写文件 X", "allow", 30_000));

	console.log("\n=== phase C: reject must not execute ===");
	const before = (await readdir(workspace)).sort();
	report("C1", await turn("命令丙", "reject", 30_000));
	const after = (await readdir(workspace)).sort();
	console.log(`    workspace ${before.join(",")} -> ${after.join(",")}`);
	console.log(`    gamma.txt created after REJECT: ${existsSync(join(workspace, "gamma.txt"))}`);

	console.log("\n=== phase D: edits ===");
	report("D1", await turn("改文件", "allow", 30_000));

	console.log("\n=== phase E: reproduce the previously reported sequence ===");
	// Prior report: "write -> bash echo -> bash exit 7 (second bash NOT asked)".
	report("E1", await turn("跑个命令", "allow", 30_000));
	report("E2", await turn("失败命令", "allow", 30_000));
	report("E3", await turn("命令甲", "allow", 30_000));

	const files = await readdir(workspace);
	console.log(`\nworkspace contents: ${files.join(", ")}`);

	const summary = outcomes.map((o) => ({ prompt: o.prompt, approvals: o.approvals.length }));
	console.log(`\nSUMMARY ${JSON.stringify(summary)}`);

	mock.stop();
	backend.proc.kill();
	process.exit(0);
}

main().catch((error) => {
	console.error("probe failed:", error);
	process.exit(1);
});
