/**
 * Permission regression suite — runs against the real backend through the same
 * WebSocket transport the webview uses, with a mock provider driving the tool
 * calls. It proves the whole chain (config -> engine -> Harness -> UI events)
 * rather than one layer in isolation.
 *
 * Every approval assertion is backed by an observable filesystem side effect,
 * so "the command did not run" is a fact, not an inference from an event stream.
 *
 * Usage: bun testing/verify-permissions.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockProvider, shellWriteCommand } from "./mock-provider";

const BACKEND = join(import.meta.dir, "..", "backend", "src", "index.ts");
const OPENCODE_BIN = join(import.meta.dir, "..", "vendor", "opencode", "bin", "opencode.exe");
const TEST_KEY = "sk-permission-verify-000";

interface Step {
	name: string;
	ok: boolean;
	detail: string;
}
const steps: Step[] = [];
const notes: string[] = [];

function record(name: string, ok: boolean, detail: unknown) {
	const text = typeof detail === "string" ? detail : JSON.stringify(detail);
	steps.push({ name, ok, detail: text.length > 600 ? `${text.slice(0, 600)}…` : text });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${text ? ` — ${text.slice(0, 160)}` : ""}`);
}
function note(text: string) {
	notes.push(text);
	console.log(`  · ${text}`);
}

class HarnessClient {
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
		const id = `v_${this.counter++}`;
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

interface BackendHandle {
	proc: ChildProcess;
	dataDir: string;
	port: number;
	token: string;
	stop: () => Promise<void>;
}

async function startBackend(dataDir: string): Promise<BackendHandle> {
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
			/* not ready */
		}
		await Bun.sleep(200);
	}
	if (!handshake) throw new Error(`backend never published a verifiable handshake.\n${output.slice(-2000)}`);
	return {
		proc,
		dataDir,
		port: Number(handshake.port),
		token: String(handshake.token),
		stop: async () => {
			proc.kill();
			await Bun.sleep(1200);
		},
	};
}

async function main() {
	const root = await mkdtemp(join(tmpdir(), "harness-perm-verify-"));
	const dataDir = join(root, "data");
	const workspace = join(root, "ws");
	await Bun.write(join(workspace, "README.md"), "# permission workspace\n");

	const mock = startMockProvider({});
	const backend = await startBackend(dataDir);
	const client = new HarnessClient();
	await client.connect(`ws://127.0.0.1:${backend.port}/transport?token=${backend.token}`);

	await client.invoke("save_model_settings", {
		protocol: "openai-compatible",
		baseUrl: `${mock.url}/v1`,
		model: "mock-model",
		apiKey: TEST_KEY,
	});
	await client.invoke("engine_start", {});
	for (let i = 0; i < 200; i++) {
		const st = await client.invoke<Record<string, unknown>>("engine_status");
		if (st.state === "running") break;
		await Bun.sleep(300);
	}
	const created = await client.invoke<{ session: { id: string } }>("create_session", { workspaceRoot: workspace });
	const sessionId = created.session.id;

	async function run(prompt: string, decision: "allow" | "reject" | null): Promise<{ approvals: string[]; toolNames: string[]; ms: number }> {
		const cursor = client.events.length;
		const started = Date.now();
		await client.invoke("chat_session_command", { action: "send", sessionId, prompt });
		const found = await client.waitFor(
			"tool_approval_state",
			(p) => String(p.sessionId) === sessionId && ((p.approvals ?? []) as unknown[]).length > 0,
			decision ? 30_000 : 8_000,
			cursor,
		);
		const list = ((found?.approvals ?? []) as Array<Record<string, unknown>>) ?? [];
		const names = list.map((a) => String(a.toolName));
		if (decision) {
			for (const item of list) {
				await client.invoke("resolve_tool_approval", { sessionId, requestId: String(item.requestId), decision });
			}
		}
		await client.waitFor("chat_event", (p) => String(p.sessionId) === sessionId && String(p.stream) === "chat_done", 60_000, cursor);
		return { approvals: names, toolNames: names, ms: Date.now() - started };
	}

	/* --- 1. defaults ask -------------------------------------------------- */
	const t1 = await run("写文件 A", "allow");
	record("默认配置：写文件会请求授权", t1.approvals.length === 1 && t1.approvals[0] === "write", t1.approvals);
	record("允许后写文件确实执行（文件已创建）", existsSync(join(workspace, "PHASE1.txt")), join(workspace, "PHASE1.txt"));

	const t2 = await run(`CMD:${shellWriteCommand("perm-a.txt", "a")}`, "allow");
	record("默认配置：执行命令会请求授权", t2.approvals.length === 1 && t2.approvals[0] === "bash", t2.approvals);
	record("允许后命令确实执行（标记文件已创建）", existsSync(join(workspace, "perm-a.txt")), join(workspace, "perm-a.txt"));

	/* --- 2. "once" must not widen scope ---------------------------------- */
	const t3 = await run(`CMD:${shellWriteCommand("perm-b.txt", "b")}`, "allow");
	record("同一会话下第二条不同命令仍然请求授权", t3.approvals.length === 1, t3.approvals);
	record("第二条命令也已执行", existsSync(join(workspace, "perm-b.txt")), "perm-b.txt");

	const t4 = await run(`CMD:${shellWriteCommand("perm-a.txt", "a")}`, "allow");
	record("「允许本次」不会让同一条命令下次免授权", t4.approvals.length === 1, t4.approvals);

	/* --- 3. rejection really prevents execution -------------------------- */
	const before = (await readdir(workspace)).sort();
	const t5 = await run(`CMD:${shellWriteCommand("denied.txt", "nope")}`, "reject");
	record("拒绝授权：仍然只产生一次询问", t5.approvals.length === 1, t5.approvals);
	const after = (await readdir(workspace)).sort();
	record("拒绝后命令确实没有执行（标记文件不存在）", !existsSync(join(workspace, "denied.txt")), { before, after });

	/* --- 4. stopping while an approval is pending ends the wait ---------- */
	const stopCursor = client.events.length;
	const stopStart = Date.now();
	await client.invoke("chat_session_command", { action: "send", sessionId, prompt: `CMD:${shellWriteCommand("stopped.txt", "s")}` });
	const pendingApproval = await client.waitFor(
		"tool_approval_state",
		(p) => String(p.sessionId) === sessionId && ((p.approvals ?? []) as unknown[]).length > 0,
		30_000,
		stopCursor,
	);
	if (!pendingApproval) {
		record("等待授权时停止任务：先出现等待中的授权", false, "no approval surfaced");
	} else {
		const stopped = await client.invoke<{ cancelled: boolean; forced: boolean; detail: string }>("chat_session_command", {
			action: "stop",
			sessionId,
		});
		const settled = await client.waitFor(
			"chat_session_status",
			(p) => String(p.sessionId) === sessionId && ["idle", "cancelled", "error"].includes(String(p.status)),
			20_000,
			stopCursor,
		);
		const elapsed = Date.now() - stopStart;
		record("等待授权时停止任务：停止被确认", stopped.cancelled || stopped.forced, stopped);
		record(`等待授权时停止任务：立即结束（${elapsed}ms < 20s）`, !!settled && elapsed < 20_000, { elapsed, status: settled?.status });
		await Bun.sleep(2500);
		record("等待授权时停止任务：命令未执行（标记文件不存在）", !existsSync(join(workspace, "stopped.txt")), "stopped.txt");
	}

	/* --- 5. settings really flow through --------------------------------- */
	await client.invoke("save_model_settings", { autoApproveCommands: true });
	const reloadDeadline = Date.now() + 60_000;
	while (Date.now() < reloadDeadline) {
		const st = await client.invoke<Record<string, unknown>>("engine_status");
		if (st.state === "running") break;
		await Bun.sleep(400);
	}
	await Bun.sleep(1500);
	const t6 = await run(`CMD:${shellWriteCommand("auto.txt", "auto")}`, null);
	record("开启「命令自动批准」后不再询问（证明设置确实生效）", t6.approvals.length === 0, t6.approvals);
	record("自动批准的命令已执行", existsSync(join(workspace, "auto.txt")), "auto.txt");
	await client.invoke("save_model_settings", { autoApproveCommands: false });

	/* --- 6. the one upstream exception, stated precisely ------------------ */
	note(
		"已知上游行为：以 shell 内建 `exit` 开头的裸命令（exit / exit 7 / EXIT 7 / exit /b 4）" +
			"引擎不发起授权询问；含 exit 的复合命令（如 `exit 7 && echo x`）仍会询问。" +
			"该命令只能结束引擎自己的持久 shell，不触及用户文件、进程或网络。最小复现见 VALIDATION.md。",
	);

	const passed = steps.every((s) => s.ok);
	const report = {
		generatedAt: new Date().toISOString(),
		mode: "mock provider (never a real model credential)",
		steps,
		notes,
        recentEvents: client.events.slice(-45),
        mockRequests: mock.requests.map((r) => ({model:r.model, messages:r.messages})),
		passed,
	};
	const outFile = join(import.meta.dir, `permission-verify-report-${Date.now()}.json`);
	await Bun.write(outFile, JSON.stringify(report, null, 2));
	console.log(`\n[perm] ${steps.filter((s) => s.ok).length}/${steps.length} steps passed → ${outFile}`);

	mock.stop();
	await backend.stop();
	process.exit(passed ? 0 : 1);
}

main().catch((error) => {
	console.error("permission suite failed:", error);
	process.exit(1);
});
