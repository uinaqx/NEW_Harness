/**
 * End-to-end integration test for the harness backend.
 *
 * Starts the real backend (child process) plus a local OpenAI-compatible mock,
 * then drives the *whole* app through the same WebSocket protocol the webview
 * uses. Nothing here touches a real model credential: this proves the plumbing
 * (engine lifecycle, secrets, events, approvals, cancel, diffs, history), and is
 * tracked separately from real-model acceptance in VALIDATION.md.
 *
 * Usage: bun testing/integration-harness.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockProvider } from "./mock-provider";

const BACKEND = join(import.meta.dir, "..", "backend", "src", "index.ts");
const OPENCODE_BIN = join(import.meta.dir, "..", "vendor", "opencode", "bin", "opencode.exe");
const TEST_KEY = "sk-integration-test-key-0123456789";

interface Step {
	name: string;
	ok: boolean;
	detail: string;
}
const steps: Step[] = [];
const notes: string[] = [];
/** Free-form trace of transport traffic, dumped into the report on failure. */
const trace: string[] = [];

function record(name: string, ok: boolean, detail: unknown) {
	const text = typeof detail === "string" ? detail : JSON.stringify(detail);
	steps.push({ name, ok, detail: text.length > 700 ? `${text.slice(0, 700)}…` : text });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${text ? ` — ${text.slice(0, 200)}` : ""}`);
}
function assert(name: string, cond: boolean, detail: unknown) {
	record(name, cond, detail);
	if (!cond) throw new Error(`assertion failed: ${name} (${JSON.stringify(detail)})`);
}
function note(text: string) {
	notes.push(text);
	console.log(`  · ${text}`);
}

/* ------------------------------------------------------------------ */
/* Tiny WS client mirroring the webview transport                      */
/* ------------------------------------------------------------------ */

class HarnessClient {
	private socket: WebSocket | null = null;
	private counter = 0;
	private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	events: Array<{ name: string; payload: Record<string, unknown>; at: number }> = [];

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
					this.events.push({ name: wrapper.name, payload: wrapper.payload, at: Date.now() });
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

	close(): void {
		this.socket?.close();
		this.socket = null;
	}

	invoke<T>(command: string, args: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<T> {
		const socket = this.socket;
		if (!socket) throw new Error("not connected");
		const id = `t_${Date.now()}_${this.counter++}`;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`timed out: ${command}`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					resolve(value as T);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			socket.send(JSON.stringify({ type: "command", id, command, args }));
		});
	}

	/**
	 * Wait for a matching transport event.
	 *
	 * `from` defaults to the current end of the buffer; pass the length captured
	 * *before* a command when the server may emit events ahead of its reply.
	 */
	async waitFor(
		name: string,
		predicate: (payload: Record<string, unknown>) => boolean,
		timeoutMs = 60_000,
		from?: number,
	): Promise<Record<string, unknown>> {
		const start = Date.now();
		let cursor = from ?? this.events.length;
		while (Date.now() - start < timeoutMs) {
			const slice = this.events.slice(cursor);
			cursor = this.events.length;
			for (const event of slice) {
				if (event.name === name && predicate(event.payload)) return event.payload;
			}
			await Bun.sleep(60);
		}
		throw new Error(`timed out waiting for ${name}`);
	}

	/** Collect chat_event chunk streams until chat_done for a session. */
	chunksSince(sessionId: string, cursor: number): Array<{ stream: string; chunk: string }> {
		return this.events
			.slice(cursor)
			.filter((e) => e.name === "chat_event" && String(e.payload.sessionId) === sessionId)
			.map((e) => ({ stream: String(e.payload.stream), chunk: String(e.payload.chunk) }));
	}
}

interface BackendHandle {
	proc: ChildProcess;
	dataDir: string;
	port: number;
	token: string;
	instanceId: string;
	output: () => string;
	stop: () => Promise<void>;
}

async function startBackend(dataDir: string, mockUrl: string, options: { notInstance?: string } = {}): Promise<BackendHandle> {
	const proc = spawn(process.execPath, [BACKEND], {
		env: {
			...process.env,
			HARNESS_DEV: "1",
			HARNESS_DATA_DIR: dataDir,
			HARNESS_OPENCODE_BIN: OPENCODE_BIN,
			MOCK_PROVIDER_URL: mockUrl,
		},
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	let output = "";
	proc.stdout?.on("data", (c: Buffer) => {
		output += c.toString();
	});
	proc.stderr?.on("data", (c: Buffer) => {
		output += c.toString();
	});

	const runtimeFile = join(dataDir, "runtime.json");
	const deadline = Date.now() + 60_000;
	let handshake: Record<string, unknown> | null = null;
	// A hard-killed predecessor leaves its handshake file behind, so we also
	// require the port to answer `/health` and agree on the instance id.
	while (Date.now() < deadline) {
		try {
			const candidate = JSON.parse(await readFile(runtimeFile, "utf8")) as Record<string, unknown>;
			const stale = options.notInstance && String(candidate.instanceId) === options.notInstance;
			if (!stale) {
				const health = (await fetch(`http://127.0.0.1:${candidate.port}/health`).then((r) => r.json())) as Record<string, unknown>;
				if (String(health.instanceId) === String(candidate.instanceId)) {
					handshake = candidate;
					break;
				}
			}
		} catch {
			/* not ready yet */
		}
		await Bun.sleep(200);
	}
	if (!handshake) throw new Error(`backend never published a verifiable handshake.\n${output.slice(-3000)}`);
	return {
		proc,
		dataDir,
		port: Number(handshake.port),
		token: String(handshake.token),
		instanceId: String(handshake.instanceId),
		output: () => output,
		stop: async () => {
			proc.kill();
			await Bun.sleep(1500);
		},
	};
}

/**
 * Write a report, falling back to a timestamped filename when the preferred path
 * is locked by another process (editors, indexers, antivirus).
 */
async function writeReport(name: string, data: unknown): Promise<string> {
	const body = JSON.stringify(data, null, 2);
	const preferred = join(import.meta.dir, name);
	try {
		await writeFile(preferred, body, "utf8");
		return preferred;
	} catch {
		const fallback = join(import.meta.dir, `${name.replace(/\.json$/, "")}-${Date.now()}.json`);
		await writeFile(fallback, body, "utf8");
		return fallback;
	}
}

/** Poll a probe until it yields a value (used for the async engine startup). */async function waitFor<T>(probe: () => Promise<T | null>, timeoutMs: number): Promise<T> {
	const start = Date.now();
	let last: unknown = null;
	while (Date.now() - start < timeoutMs) {
		const value = await probe();
		if (value !== null) return value;
		last = value;
		await Bun.sleep(300);
	}
	throw new Error(`timed out waiting for condition (last=${JSON.stringify(last)})`);
}

async function scanForSecret(root: string, secret: string): Promise<string[]> {	const hits: string[] = [];
	async function walk(dir: string, depth: number) {
		if (depth > 6) return;
		let entries: Awaited<ReturnType<typeof readdir>>;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(full, depth + 1);
				continue;
			}
			if (entry.name.endsWith(".exe") || entry.name.endsWith(".bin")) {
				const info = await stat(full).catch(() => null);
				if (info && info.size > 2_000_000) continue;
			}
			try {
				const text = await readFile(full, "utf8");
				if (text.includes(secret)) hits.push(full);
			} catch {}
		}
	}
	await walk(root, 0);
	return hits;
}

/* ------------------------------------------------------------------ */

async function main() {
	if (!existsSync(OPENCODE_BIN)) throw new Error(`missing engine binary at ${OPENCODE_BIN}`);
	const root = await mkdtemp(join(tmpdir(), "harness-it-"));
	const dataDir = join(root, "data");
	const workspace = join(root, "project");
	await mkdir(workspace, { recursive: true });
	await writeFile(join(workspace, "README.md"), "# integration workspace\n", "utf8");
	Bun.spawnSync(["git", "init", "-q"], { cwd: workspace });
	Bun.spawnSync(["git", "add", "-A"], { cwd: workspace });
	Bun.spawnSync(["git", "-c", "user.email=i@t", "-c", "user.name=i", "commit", "-qm", "init"], { cwd: workspace });

	const mock = startMockProvider({ port: 0 });
	console.log(`[it] mock provider ${mock.url}`);
	let backend: BackendHandle | undefined;
	let second: BackendHandle | undefined;
	let client: HarnessClient | undefined;
	let client2: HarnessClient | undefined;
	let passed = false;
	try {
		backend = await startBackend(dataDir, mock.url);

		/* --- health + identity --------------------------------------------- */
		const health = (await fetch(`http://127.0.0.1:${backend.port}/health`).then((r) => r.json())) as Record<string, unknown>;
		assert("health: `/health` reports ok", health.ok === true, health);
		assert("health: instance identity matches the handshake", health.instanceId === backend.instanceId, {
			handshake: backend.instanceId,
			health: health.instanceId,
		});
		assert("health: port is dynamic, not a fixed 3126/4096", backend.port !== 3126 && backend.port !== 4096, backend.port);

		/* --- transport auth -------------------------------------------------- */
		const unauth = await new Promise<string>((resolve) => {
			const socket = new WebSocket(`ws://127.0.0.1:${backend!.port}/transport`);
			socket.onopen = () => {
				socket.close();
				resolve("opened");
			};
			socket.onerror = () => resolve("rejected");
			socket.onclose = () => resolve("rejected");
		});
		assert("auth: WebSocket without the launch token is refused", unauth === "rejected", unauth);

		client = new HarnessClient();
		await client.connect(`ws://127.0.0.1:${backend.port}/transport?token=${backend.token}`);

		const ping = await client.invoke<{ version: string }>("ping");
		assert("transport: authenticated command round-trip", !!ping.version, ping);

		const appInfo = await client.invoke<Record<string, unknown>>("get_app_info");
		assert("identity: app reports the pinned engine version", String(appInfo.engineVersion) === "1.18.31", appInfo);
		assert("secrets: credentials are OS protected", appInfo.credentialsOsProtected === true, appInfo.credentialsOsProtected);

		/* --- settings + credential ------------------------------------------- */
		const saved = await client.invoke<{ settings: Record<string, unknown> }>("save_model_settings", {
			protocol: "openai-compatible",
			baseUrl: `${mock.url}/v1/`,
			model: "mock-model",
			apiKey: TEST_KEY,
		});
		assert("settings: saved and the trailing slash is normalised", saved.settings.baseUrl === `${mock.url}/v1`, saved.settings);
		assert("settings: the response carries a mask, never the key", saved.settings.apiKey === "" && typeof saved.settings.apiKeyMask === "string", saved.settings);

		const reread = await client.invoke<{ settings: Record<string, unknown> }>("get_model_settings");
		assert("settings: reading back never returns the key", reread.settings.apiKey === "" && !!reread.settings.hasApiKey, reread.settings);
		note(`key mask shown to the UI: ${String(reread.settings.apiKeyMask)}`);

		const test = await client.invoke<Record<string, unknown>>("test_model_connection", {});
		assert("settings: connection test hits the endpoint for real", test.ok === true, test);

		const badTest = await client.invoke<Record<string, unknown>>("test_model_connection", {
			apiKey: "sk-wrong-key-000000000000",
			baseUrl: "http://127.0.0.1:1/v1",
		});
		assert("settings: a broken endpoint is reported as a network failure", badTest.ok === false && badTest.kind === "network", badTest);

		const settingsFile = await readFile(join(dataDir, "app-settings.json"), "utf8");
		assert("secrets: the API key is absent from app-settings.json", !settingsFile.includes(TEST_KEY), settingsFile.slice(0, 200));
		const credFile = await readFile(join(dataDir, "credentials.bin"), "utf8");
		assert("secrets: the key is absent from credentials.bin (DPAPI blob)", !credFile.includes(TEST_KEY), credFile.slice(0, 120));

		/* --- engine ---------------------------------------------------------- */
		// No credential existed at boot, so nothing was started: the engine comes
		// up on demand. Exercise the explicit start command here.
		await client.invoke("engine_start", {});
		const engineStatus = await waitFor(async () => {
			const status = await client.invoke<Record<string, unknown>>("engine_status");
			return status.state === "running" ? status : null;
		}, 60_000);
		assert("engine: running on a loopback dynamic port", engineStatus.state === "running" && String(engineStatus.url).includes("127.0.0.1"), engineStatus);
		assert("engine: binary hash verified against the pin", (engineStatus.binary as Record<string, unknown>)?.verified === true, engineStatus.binary);
		const stagedSkills = await readdir(join(dataDir, "opencode", "config", "opencode", "skills"), { withFileTypes: true });
		assert("skills: 20 bundled skills staged for OpenCode discovery", stagedSkills.filter((entry) => entry.isDirectory()).length === 20 && existsSync(join(dataDir, "opencode", "config", "opencode", "skills", "systematic-debugging", "SKILL.md")), stagedSkills.map((entry) => entry.name));
		const engineLog = await client.invoke<{ text: string }>("engine_diagnostics");
		assert("engine: diagnostics available", engineLog.text.includes("instance") && engineLog.text.includes("opencode"), engineLog.text.slice(0, 120));

		/* --- session + approvals -------------------------------------------- */
		const created = await client.invoke<{ session: { id: string } }>("create_session", { workspaceRoot: workspace });
		const sessionId = created.session.id;
		assert("session: created in the requested workspace", !!sessionId, sessionId);
		const projectList = await client.invoke<{ projects: Array<{ id: string; workspaceRoot: string }> }>("list_projects");
		const project = projectList.projects.find((item) => item.workspaceRoot === workspace);
		assert("projects: session workspace becomes a project", !!project, projectList.projects);
		await client.invoke("rename_project", { projectId: project!.id, name: "测试项目" });
		const renamedProjects = await client.invoke<{ projects: Array<{ name?: string }> }>("list_projects");
		assert("projects: custom name persists", renamedProjects.projects.some((item) => item.name === "测试项目"), renamedProjects.projects);
		await client.invoke("rename_session", { sessionId, title: "自定义对话" });
		await client.invoke("pin_session", { sessionId, pinned: true });
		const navigation = await client.invoke<{ sessions: Array<{ id: string; title: string; pinned: boolean }> }>("list_sessions");
		assert("sessions: rename and pin appear in navigation", navigation.sessions.some((item) => item.id === sessionId && item.title === "自定义对话" && item.pinned), navigation.sessions);
		await client.invoke("update_session_config", { sessionId, config: { mode: "plan", model: "mock-model" }, goal: "保持测试文件可读" });
		const planConfig = await client.invoke<{ session: { config: { mode: string; goal?: string } } }>("get_session", { sessionId });
		assert("sessions: plan mode and goal persist", planConfig.session.config.mode === "plan" && planConfig.session.config.goal === "保持测试文件可读", planConfig.session.config);
		await client.invoke("update_session_config", { sessionId, config: { mode: "act" } });

		type PromptOutcome = { chunks: Array<{ stream: string; chunk: string }>; approvals: string[]; done: Record<string, unknown> };
		async function runPrompt(text: string, decision: "allow" | "reject", expectApproval: boolean, options: Record<string, unknown> = {}): Promise<PromptOutcome> {
			const cursor = client.events.length;
			const ack = await client.invoke<Record<string, unknown>>("chat_session_command", { action: "send", sessionId, prompt: text, ...options });
			trace.push(`send "${text}" -> ${JSON.stringify(ack)}`);
			const approvals: string[] = [];
			if (expectApproval) {
				const approval = await client.waitFor(
					"tool_approval_state",
					(p) => {
						const list = (p.approvals ?? []) as Array<Record<string, unknown>>;
						return String(p.sessionId) === sessionId && list.length > 0;
					},
					60_000,
					cursor,
				);
				const list = (approval.approvals ?? []) as Array<Record<string, unknown>>;
				for (const item of list) {
					approvals.push(String(item.toolName));
					await client.invoke("resolve_tool_approval", {
						sessionId,
						requestId: String(item.requestId),
						decision,
					});
				}
			}
			const done = await client.waitFor(
				"chat_event",
				(p) => String(p.sessionId) === sessionId && String(p.stream) === "chat_done",
				60_000,
				cursor,
			);
			return { chunks: client.chunksSince(sessionId, cursor), approvals, done: (done ?? {}) as Record<string, unknown> };
		}

		// Verification snapshots are captured even if a later assertion fails.
		trace.push(`engine: ${JSON.stringify(await client.invoke("engine_status"))}`);

		const turn1 = await runPrompt("写文件 PHASE1", "allow", true);
		assert("approval: write asked for permission and was allowed", turn1.approvals.length === 1 && turn1.approvals[0] !== "", turn1.approvals);
		const wrote = existsSync(join(workspace, "PHASE1.txt"));
		assert("canvas: tool-start/tool-end chunks streamed for the write", wrote, join(workspace, "PHASE1.txt"));
		assert(
			"canvas: node ids are the engine's stable call ids",
			turn1.chunks.some((c) => c.stream === "chat_tool_call_start" && c.chunk.includes("toolCallId")),
			turn1.chunks.map((c) => c.stream).slice(0, 12),
		);
		assert(
			"canvas: text streamed incrementally",
			turn1.chunks.filter((c) => c.stream === "chat_text").length >= 1,
			turn1.chunks.filter((c) => c.stream === "chat_text").length,
		);
		assert(
			"canvas: usage reported",
			turn1.chunks.some((c) => c.stream === "chat_usage"),
			turn1.chunks.filter((c) => c.stream === "chat_usage").length,
		);

		const turn2 = await runPrompt("跑个命令", "reject", true);
		const toolEnd = turn2.chunks.filter((c) => c.stream === "chat_tool_call_end");
		assert("approval: rejecting hands the decision to the engine", turn2.approvals.length === 1, turn2.approvals);
		assert(
			"tools: rejection surfaces as a failed node with the engine's reason",
			toolEnd.some((c) => c.chunk.toLowerCase().includes("reject")),
			toolEnd.map((c) => c.chunk.slice(0, 160)),
		);

		const turn3 = await runPrompt("改文件", "allow", true);
		assert("approval: an edit in the same session still asks and can be allowed", turn3.approvals.length === 1, turn3.approvals);

		/* --- changing settings between turns ---------------------------------- */
		// Turning command auto-approval on must not interrupt anything, and must be
		// picked up by the *next* turn (the engine resolves models from the config
		// it booted with, so the adapter restarts it between turns).
		const beforeReload = String((await client.invoke<Record<string, unknown>>("engine_status")).instanceId);
		await client.invoke("save_model_settings", { autoApproveCommands: true });
		const midRun = String((await client.invoke<Record<string, unknown>>("engine_status")).instanceId);
		assert("settings: saving mid-run keeps the engine that is in use", midRun === beforeReload, { beforeReload, midRun });
		const reloaded = await waitFor(async () => {
			const status = await client.invoke<Record<string, unknown>>("engine_status");
			return status.instanceId !== beforeReload && status.state === "running" ? status : null;
		}, 60_000);
		assert("settings: provider changes are applied by restarting the engine between turns", reloaded.instanceId !== beforeReload, {
			before: beforeReload,
			after: reloaded.instanceId,
		});

		const turn4 = await runPrompt("失败命令", "allow", false);
		const failedEnd = turn4.chunks.filter((c) => c.stream === "chat_tool_call_end");
		const parsed = failedEnd.map((c) => JSON.parse(c.chunk) as Record<string, unknown>);
		assert(
			"tools: a non-zero exit code is judged as a failure (not reported as success)",
			parsed.some((p) => p.exitCode === 7 && String(p.error ?? "").includes("7")),
			parsed,
		);
		note(`non-zero-exit tool end payload: ${failedEnd.at(-1)?.chunk.slice(0, 300) ?? "none"}`);
		await runPrompt("检查技能", "allow", false, { skillId: "systematic-debugging", attachments: [join(workspace, "README.md")] });
		const skillRequest = mock.requests.at(-1);
		const skillMessages = JSON.stringify(skillRequest?.messages ?? []);
		assert("skills: selected skill and attachment reach the real engine prompt", skillMessages.includes("systematic-debugging") && skillMessages.includes("README.md"), skillMessages.slice(-500));
		const toolNames = Array.isArray(skillRequest?.tools)
			? skillRequest.tools.map((item: { function?: { name?: string } }) => item.function?.name ?? "")
			: Object.keys((skillRequest?.tools ?? {}) as Record<string, unknown>);
		assert("skills: OpenCode advertises the native skill tool and bundled skill", toolNames.includes("skill") && skillMessages.includes("<name>systematic-debugging</name>"), { toolNames, listed: skillMessages.includes("<name>systematic-debugging</name>") });
		const secondChat = await client.invoke<{ session: { id: string } }>("create_session", { workspaceRoot: workspace, model: "mock-model-alt" });
		const siblingSessions = await client.invoke<{ sessions: Array<{ workspaceRoot: string }> }>("list_sessions");
		assert("projects: one folder supports multiple conversations", siblingSessions.sessions.filter((item) => item.workspaceRoot === workspace).length >= 2, siblingSessions.sessions.map((item) => item.workspaceRoot));
		const siblingCursor = client.events.length;
		await client.invoke("chat_session_command", { action: "send", sessionId: secondChat.session.id, prompt: "普通问候" });
		await client.waitFor("chat_event", (payload) => payload.sessionId === secondChat.session.id && payload.stream === "chat_done", 60_000, siblingCursor);
		assert("models: a conversation uses its selected model", mock.requests.at(-1)?.model === "mock-model-alt", mock.requests.at(-1)?.model);
		await runPrompt("继续检查", "allow", false);
		assert("models: switching back restores the first conversation's model", mock.requests.at(-1)?.model === "mock-model", mock.requests.at(-1)?.model);

		/* --- multiple APIs and projectless Chat mode -------------------------- */
		const unsavedProfileTest = await client.invoke<{ ok: boolean; kind: string }>("test_model_connection", {
			profileId: "", protocol: "openai-compatible", baseUrl: `${mock.url}/v1`, model: "mock-model-third",
		});
		assert("profiles: a new API cannot borrow the default profile's saved key", !unsavedProfileTest.ok && unsavedProfileTest.kind === "auth", unsavedProfileTest);
		const profileSaved = await client.invoke<{ profileId: string }>("save_model_profile", {
			name: "第二接口", protocol: "openai-compatible", baseUrl: `${mock.url}/v1`, models: "mock-model-third\nmock-model-fourth", apiKey: TEST_KEY,
		});
		const profileId = profileSaved.profileId;
		const profileSettings = await client.invoke<{ settings: { profiles: Array<{ id: string; models: string[]; hasApiKey: boolean }> } }>("get_model_settings");
		assert("profiles: multiple named APIs and models are available without exposing keys", profileSettings.settings.profiles.length === 2 && profileSettings.settings.profiles.some((item) => item.id === profileId && item.hasApiKey && item.models.length === 2), profileSettings.settings.profiles);
		const chatCreated = await client.invoke<{ session: { id: string; config: { kind: string; enableTools: boolean; workspaceRoot: string } } }>("create_session", { kind: "chat", profileId, model: "mock-model-third" });
		const chatId = chatCreated.session.id;
		assert("chat: session needs no project directory and tools are disabled", chatCreated.session.config.kind === "chat" && chatCreated.session.config.enableTools === false && !chatCreated.session.config.workspaceRoot.startsWith(workspace), chatCreated.session.config);
		const chatProjects = await client.invoke<{ projects: Array<{ workspaceRoot: string }> }>("list_projects");
		assert("chat: private conversation is not listed as a project", !chatProjects.projects.some((item) => item.workspaceRoot === chatCreated.session.config.workspaceRoot), chatProjects.projects);
		const chatCursor = client.events.length;
		await client.invoke("chat_session_command", { action: "send", sessionId: chatId, prompt: "普通问候" });
		await client.waitFor("chat_event", (payload) => payload.sessionId === chatId && payload.stream === "chat_done", 60_000, chatCursor);
		const chatRequest = mock.requests.at(-1);
		assert("chat: selected API and model are used", chatRequest?.model === "mock-model-third", chatRequest?.model);
		assert("chat: provider request advertises no tools", !Array.isArray(chatRequest?.tools) || chatRequest.tools.length === 0, chatRequest?.tools ?? "none");
		const chatWriteCursor = client.events.length;
		await client.invoke("chat_session_command", { action: "send", sessionId: chatId, prompt: "写文件 PHASE1" });
		await client.waitFor("chat_event", (payload) => payload.sessionId === chatId && payload.stream === "chat_done", 60_000, chatWriteCursor);
		const chatWriteEvents = client.chunksSince(chatId, chatWriteCursor);
		assert("chat: even an unsolicited model write call cannot create a file", !existsSync(join(chatCreated.session.config.workspaceRoot, "PHASE1.txt")) && !chatWriteEvents.some((item) => item.stream === "chat_tool_call_start"), chatWriteEvents.map((item) => item.stream));
		const blockedAttachment = await client.invoke("chat_session_command", { action: "send", sessionId: chatId, prompt: "读文件", attachments: [join(workspace, "README.md")] }).then(() => false).catch(() => true);
		assert("chat: backend rejects file attachments", blockedAttachment, blockedAttachment);
		const blockedApproval = await client.invoke("resolve_tool_approval", { sessionId: chatId, requestId: "fake", decision: "allow" }).then(() => false).catch(() => true);
		assert("chat: backend refuses tool approvals", blockedApproval, blockedApproval);
		const blockedPlan = await client.invoke("update_session_config", { sessionId: chatId, config: { mode: "plan" } }).then(() => false).catch(() => true);
		assert("chat: plan/tool mode cannot be enabled", blockedPlan, blockedPlan);
		const chatList = await client.invoke<{ sessions: Array<{ id: string; kind: string }> }>("list_sessions");
		assert("chat: navigation retains its own session kind", chatList.sessions.some((item) => item.id === chatId && item.kind === "chat"), chatList.sessions.filter((item) => item.id === chatId));

		/* --- diffs ----------------------------------------------------------- */
		const diffs = await client.invoke<{ diffs: Array<Record<string, unknown>> }>("list_session_diffs", { sessionId });
		assert(
			"diff: both changed files are reported by the engine",
			diffs.diffs.some((d) => String(d.file).includes("PHASE1.txt")) && diffs.diffs.some((d) => String(d.file).includes("README.md")),
			diffs.diffs.map((d) => d.file),
		);

		/* --- transcript ------------------------------------------------------- */
		const transcript = await client.invoke<{ messages: Array<Record<string, unknown>> }>("read_session_messages", { sessionId });
		const roles = transcript.messages.map((m) => String(m.role));
		assert("history: user and assistant messages are reconstructed", roles.includes("user") && roles.includes("assistant"), roles);
		assert("history: tool output is summarised, not dumped", roles.includes("status") && !roles.includes("tool"), roles);

		/* --- cancel + delete rules --------------------------------------------- */
		const nodes = await client.invoke<{ nodes: Array<Record<string, unknown>> }>("read_session_nodes", { sessionId });
		assert("canvas: stored tool nodes are retrievable for inspection", nodes.nodes.length >= 2, nodes.nodes.map((n) => n.toolName));

		const slowCursor = client.events.length;
		await client.invoke("chat_session_command", { action: "send", sessionId, prompt: "慢慢说" });
		await client.waitFor(
			"chat_session_status",
			(p) => String(p.sessionId) === sessionId && String(p.status) === "running",
			30_000,
			slowCursor,
		);
		const deleteWhileRunning = await client
			.invoke("delete_session", { sessionId })
			.then(() => "accepted")
			.catch((e: Error) => `rejected:${e.message}`);
		assert("sessions: deleting a running session is refused", deleteWhileRunning.startsWith("rejected:"), deleteWhileRunning);

		const secondSend = await client
			.invoke("chat_session_command", { action: "send", sessionId, prompt: "再来一次" })
			.then(() => "accepted")
			.catch((e: Error) => `rejected:${e.message}`);
		assert("tasks: a second concurrent task in the app is refused", secondSend.startsWith("rejected:"), secondSend);

		const stopped = await client.invoke<{ cancelled: boolean; forced: boolean; detail: string }>("chat_session_command", {
			action: "stop",
			sessionId,
		});
		assert("cancel: stopping the task is acknowledged", stopped.cancelled || stopped.forced, stopped);
		const afterStop = await client.waitFor(
			"chat_session_status",
			(p) => String(p.sessionId) === sessionId && ["idle", "cancelled"].includes(String(p.status)),
			30_000,
			slowCursor,
		);
		assert("cancel: the session returns to idle after a stop", ["idle", "cancelled"].includes(String(afterStop.status)), afterStop);
		const throwaway = await client.invoke<{ session: { id: string } }>("create_session", { workspaceRoot: workspace, title: "临时会话" });
		const deleted = await client.invoke<{ removed: boolean }>("delete_session", { sessionId: throwaway.session.id });
		assert("sessions: an idle session deletes cleanly", deleted.removed === true, deleted);
		const afterDelete = await client.invoke<{ sessions: Array<Record<string, unknown>> }>("list_sessions");
		assert(
			"sessions: the deleted session disappears from the list",
			!afterDelete.sessions.some((s) => String(s.id) === throwaway.session.id),
			afterDelete.sessions.map((s) => s.id),
		);

		/* --- restart persistence ---------------------------------------------- */
		const staleHandshake = JSON.parse(await readFile(join(dataDir, "runtime.json"), "utf8")) as Record<string, unknown>;
		await backend.stop();
		const staleAlive = await fetch(`http://127.0.0.1:${staleHandshake.port}/health`)
			.then(() => true)
			.catch(() => false);
		assert(
			"lifecycle: after the app dies its handshake is stale and the port is dead (identity probe would reject it)",
			staleAlive === false,
			{ port: staleHandshake.port, staleAlive },
		);
		second = await startBackend(dataDir, mock.url, { notInstance: String(staleHandshake.instanceId) });
		client2 = new HarnessClient();
		await client2.connect(`ws://127.0.0.1:${second.port}/transport?token=${second.token}`);
		const listed = await client2.invoke<{ sessions: Array<Record<string, unknown>> }>("list_sessions");
		assert("persistence: the session survives a full app restart", listed.sessions.some((s) => String(s.id) === sessionId), listed.sessions.map((s) => s.id));
		const transcript2 = await client2.invoke<{ messages: Array<Record<string, unknown>> }>("read_session_messages", { sessionId });
		assert("persistence: transcript is still readable after restart", transcript2.messages.length > 0, transcript2.messages.length);
		const settings2 = await client2.invoke<{ settings: Record<string, unknown> }>("get_model_settings");
		assert("persistence: settings and key survive a restart", settings2.settings.hasApiKey === true && settings2.settings.model === "mock-model", settings2.settings);
		const lazyEngine = await waitFor(async () => {
			const status = await client2.invoke<Record<string, unknown>>("engine_status");
			return status.state === "running" ? status : null;
		}, 60_000);
		assert(
			"lifecycle: with a stored credential the engine comes up by itself on launch",
			lazyEngine.state === "running" && lazyEngine.instanceId !== engineStatus.instanceId,
			{ before: engineStatus.instanceId, after: lazyEngine.instanceId },
		);

		/* --- secret scan ------------------------------------------------------- */
		const leaks = await scanForSecret(dataDir, TEST_KEY);
		assert("secrets: no plaintext key anywhere under the data directory", leaks.length === 0, leaks);

		/* --- process cleanup --------------------------------------------------- */
		const enginePid = Number((await client2.invoke<Record<string, unknown>>("engine_status")).pid ?? 0);
		await second.stop();
		let alive = false;
		for (let i = 0; i < 25; i++) {
			try {
				process.kill(enginePid, 0);
				alive = true;
				await Bun.sleep(200);
			} catch {
				alive = false;
				break;
			}
		}
		assert("lifecycle: the engine child exits with the backend (no leftover daemon)", !alive, { enginePid, alive });

		client.close();
		client2.close();
		passed = steps.every((s) => s.ok);
		record("INTEGRATION VERDICT", passed, `${steps.filter((s) => s.ok).length}/${steps.length} steps passed`);
	} finally {
		try {
			await backend?.stop();
		} catch {}
		try {
			await second?.stop();
		} catch {}
		mock.stop();
		const reportPath = await writeReport("integration-report.json", {
			generatedAt: new Date().toISOString(),
			mode: "mock-provider (not a real model)",
			steps,
			notes,
			mockRequests: mock.requests.length,
			trace,
			engineDiagnostics: (backend?.output() ?? "").split("\n").slice(-120),
			allEvents: (client?.events ?? []).map((e) => `${e.name}: ${JSON.stringify(e.payload).slice(0, 220)}`),
			chatEvents: (client?.events ?? [])
				.filter((e) => e.name === "chat_event")
				.map((e) => `${e.payload.stream}: ${String(e.payload.chunk).slice(0, 180)}`),
			backendOutput: (backend?.output() ?? "").split("\n").slice(-120),
			passed,
		});
		if (!passed) {
			console.log("\n--- failing steps ---");
			for (const step of steps.filter((s) => !s.ok)) console.log(`  ${step.name}: ${step.detail}`);
			console.log("\n--- backend output (tail) ---");
			console.log((backend?.output() ?? "").split("\n").slice(-45).join("\n"));
		}
		console.log(`\n[it] report -> ${reportPath}  (${passed ? "PASS" : "FAIL"})`);
		if (passed) await rm(root, { recursive: true, force: true }).catch(() => {});
		else console.log(`[it] kept failing run artefacts at ${root}`);
	}
}

await main();
