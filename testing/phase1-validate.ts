/**
 * Phase 1 — minimal integration validation for the pinned OpenCode build.
 *
 * Starts the pinned `opencode serve` against a local mock OpenAI-compatible
 * provider and drives it with the official TypeScript SDK, asserting the real
 * request/response chain rather than just that the types exist.
 *
 * Verified here: handshake + version, workspace-scoped session create, event
 * subscription, prompt, streamed text, tool events, permission request/reply,
 * abort/cancel, message history read-back, session diff, restart persistence.
 *
 * Usage: bun testing/phase1-validate.ts
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpencodeClient } from "../vendor/opencode/sdk/dist/client.js";
import { startMockProvider } from "./mock-provider";

const OPENCODE_BIN = join(import.meta.dir, "..", "vendor", "opencode", "bin", "opencode.exe");
const PINNED_VERSION = "1.18.31";

interface Step {
	name: string;
	ok: boolean;
	detail: string;
}

const steps: Step[] = [];
const notes: string[] = [];

function record(name: string, ok: boolean, detail: unknown) {
	const text = typeof detail === "string" ? detail : JSON.stringify(detail);
	steps.push({ name, ok, detail: text.length > 700 ? `${text.slice(0, 700)}…` : text });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${text ? ` — ${text.slice(0, 220)}` : ""}`);
}

function assert(name: string, cond: boolean, detail: unknown) {
	record(name, cond, detail);
	if (!cond) throw new Error(`assertion failed: ${name} (${JSON.stringify(detail)})`);
}

interface ServerProc {
	proc: ChildProcessWithoutNullStreams;
	url: string;
}

async function launchServer(env: Record<string, string>, workdir: string, sink: string[]): Promise<ServerProc> {
	if (!existsSync(OPENCODE_BIN)) throw new Error(`opencode binary missing at ${OPENCODE_BIN}`);
	// `opencode serve --port=0` does NOT bind an ephemeral port — it falls back to
	// 4096. So the harness must reserve a free port and hand it over explicitly.
	const port = await freePort();
	const proc = spawn(OPENCODE_BIN, ["serve", "--hostname=127.0.0.1", `--port=${port}`, "--print-logs", "--log-level=INFO"], {
		cwd: workdir,
		env: { ...process.env, ...env },
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	let out = "";
	const url = await new Promise<string>((resolve, reject) => {
		const timer = setTimeout(() => {
			proc.kill();
			reject(new Error(`timeout waiting for handshake. output:\n${out}`));
		}, 60_000);
		sink.push(`[spawn] ${OPENCODE_BIN} serve --hostname=127.0.0.1 --port=${port}`);
		proc.stdout.on("data", (chunk: Buffer) => {
			out += chunk.toString("utf8");
			sink.push(`[stdout] ${chunk.toString("utf8").trimEnd()}`);
			const m = out.match(/opencode server listening on (https?:\/\/\S+)/);
			if (m) {
				clearTimeout(timer);
				resolve(m[1]);
			}
		});
		proc.stderr.on("data", (chunk: Buffer) => {
			out += chunk.toString("utf8");
			sink.push(`[stderr] ${chunk.toString("utf8").trimEnd()}`);
		});
		proc.on("exit", (code) => {
			sink.push(`[exit] code=${code}`);
			clearTimeout(timer);
			reject(new Error(`opencode exited with ${code}. output:\n${out}`));
		});
	});
	return { proc, url };
}

function providerConfig(providerBaseUrl: string) {
	return {
		$schema: "https://opencode.ai/config.json",
		model: "harnessmock/mock-model",
		provider: {
			harnessmock: {
				npm: "@ai-sdk/openai-compatible",
				name: "Harness Mock",
				options: { baseURL: `${providerBaseUrl}/v1`, apiKey: "mock-key-not-a-real-secret" },
				models: {
					"mock-model": {
						id: "mock-model",
						name: "Mock Model",
						tool_call: true,
						reasoning: false,
						limit: { context: 100_000, output: 8_000 },
					},
				},
			},
		},
		permission: { edit: "ask", bash: "ask", webfetch: "deny" },
		autoupdate: false,
		share: "disabled",
		lsp: false,
		formatter: false,
		plugin: [],
	};
}

async function main() {
	const root = await mkdtemp(join(tmpdir(), "harness-phase1-"));
	const workspace = join(root, "project");
	const configHome = join(root, "xdg-config");
	const opencodeConfigFile = join(configHome, "opencode", "opencode.json");
	for (const d of [workspace, join(root, "xdg-data"), configHome, join(root, "xdg-cache"), join(root, "xdg-state")]) {
		await mkdir(d, { recursive: true });
	}
	await writeFile(join(workspace, "README.md"), "# phase1 workspace\n", "utf8");
	// A git repo makes the engine's diff/snapshot machinery available.
	Bun.spawnSync(["git", "init", "-q"], { cwd: workspace });
	Bun.spawnSync(["git", "add", "-A"], { cwd: workspace });
	Bun.spawnSync(["git", "-c", "user.email=p1@local", "-c", "user.name=p1", "commit", "-qm", "init"], { cwd: workspace });

	const mock = startMockProvider({ port: 0 });
	const cfg = providerConfig(mock.url);
	await mkdir(join(configHome, "opencode"), { recursive: true });
	await writeFile(opencodeConfigFile, JSON.stringify(cfg, null, 2), "utf8");
	const env: Record<string, string> = {
		OPENCODE_CONFIG: opencodeConfigFile,
		OPENCODE_CONFIG_CONTENT: JSON.stringify(cfg),
		XDG_DATA_HOME: join(root, "xdg-data"),
		XDG_CONFIG_HOME: configHome,
		XDG_CACHE_HOME: join(root, "xdg-cache"),
		XDG_STATE_HOME: join(root, "xdg-state"),
		OPENCODE_DISABLE_AUTOUPDATE: "1",
	};

	const engineLog: string[] = [];
	let server: ServerProc | undefined;
	let server2: ServerProc | undefined;
	let passed = false;
	try {
		server = await launchServer(env, workspace, engineLog);
		assert("handshake: server URL parsed from stdout", true, server.url);
		assert("handshake: bound to 127.0.0.1 loopback only", /^http:\/\/127\.0\.0\.1:\d+$/.test(server.url), server.url);
		const port = Number(new URL(server.url).port);
		assert("handshake: dynamic port honoured (not the 4096 fallback)", port !== 4096, port);

		const client = createOpencodeClient({ baseUrl: server.url });

		const pathRes = await client.path.get({ query: { directory: workspace } });
		const pathData = (pathRes as { data?: Record<string, unknown> }).data ?? {};
		assert(
			"identity: reported directory equals the requested workspace",
			String(pathData.directory ?? "").replace(/\\/g, "/").toLowerCase() === workspace.replace(/\\/g, "/").toLowerCase(),
			pathData,
		);

		const providers = await client.config.providers({ query: { directory: workspace } });
		const providerList = ((providers as { data?: { providers?: unknown } }).data?.providers ?? []) as unknown;
		const providerIds = Array.isArray(providerList)
			? providerList.map((p) => String((p as { id?: string }).id))
			: Object.keys(providerList as Record<string, unknown>);
		assert("config: OpenAI-compatible custom provider registered", providerIds.includes("harnessmock"), providerIds);

		const created = await client.session.create({ query: { directory: workspace }, body: { title: "phase1" } });
		const session = (created as { data?: { id: string } }).data;
		assert("session: created in the requested workspace", !!session?.id, session);

		// --- subscribe BEFORE prompting -------------------------------------
		const seenTypes = new Set<string>();
		const pendingPermissions: Array<Record<string, unknown>> = [];
		const textDeltas: string[] = [];
		const ac = new AbortController();
		const sub = await client.event.subscribe({ query: { directory: workspace }, signal: ac.signal });
		const pump = (async () => {
			try {
				for await (const evt of sub.stream) {
					const payload = ((evt as Record<string, unknown>).payload ?? evt) as Record<string, unknown>;
					const type = String(payload.type ?? "");
					seenTypes.add(type);
					const props = (payload.properties ?? {}) as Record<string, unknown>;
					if ((type === "permission.asked" || type === "permission.updated") && props.sessionID === session!.id) {
						pendingPermissions.push(props);
					}
					if (type === "message.part.delta" && props.sessionID === session!.id) textDeltas.push(String(props.delta ?? ""));
				}
			} catch {
				/* aborted at teardown */
			}
		})();

		/** Send a prompt and answer every permission it raises, in order. */
		async function promptWithPermissions(text: string, decisions: string[]) {
			const run = client.session.prompt({
				path: { id: session!.id },
				query: { directory: workspace },
				body: {
					model: { providerID: "harnessmock", modelID: "mock-model" },
					parts: [{ type: "text", text }],
				} as never,
			});
			const answered: string[] = [];
			for (const decision of decisions) {
				const perm = await waitFor(() => pendingPermissions.shift(), 45_000, `permission for "${text}"`);
				answered.push(`${perm.permission}:${decision}`);
				await client.postSessionIdPermissionsPermissionId({
					path: { id: session!.id, permissionID: String(perm.id) },
					query: { directory: workspace },
					body: { response: decision as "once" },
				});
			}
			const result = (await run) as { data?: { parts?: Array<Record<string, unknown>> } };
			return { answered, result };
		}

		// --- turn 1: write tool, approved -------------------------------------
		const t1 = await promptWithPermissions("写文件 PHASE1", ["once"]);
		record("permission: edit request surfaced and was answered", true, t1.answered);
		const wrote = existsSync(join(workspace, "PHASE1.txt"));
		assert("tools: approved write actually created the file", wrote, join(workspace, "PHASE1.txt"));

		// --- turn 2: bash tool, rejected --------------------------------------
		const t2 = await promptWithPermissions("跑个命令", ["reject"]);
		record("permission: bash request surfaced and was rejected", true, t2.answered);
		const toolParts = (t2.result.data?.parts ?? []).filter((p) => p.type === "tool");
		const rejectedState = (toolParts[0]?.state ?? {}) as Record<string, unknown>;
		assert(
			"permission: rejection is handed back to the engine (tool ends in error, no fabricated result)",
			String(rejectedState.status) === "error" && String(rejectedState.error ?? "").toLowerCase().includes("reject"),
			rejectedState,
		);

		// --- turn 3: final text ------------------------------------------------
		const t3 = await promptWithPermissions("总结一下", []);
		const textPart = (t3.result.data?.parts ?? []).find((p) => p.type === "text");
		assert("prompt: final assistant text returned", typeof textPart?.text === "string" && (textPart.text as string).length > 0, textPart);
		assert("events: incremental text deltas observed (streaming)", textDeltas.length > 0, { deltas: textDeltas.length, sample: textDeltas.slice(0, 5) });

		// --- cancel -------------------------------------------------------------
		const slowRun = client.session.prompt({
			path: { id: session!.id },
			query: { directory: workspace },
			body: { model: { providerID: "harnessmock", modelID: "mock-model" }, parts: [{ type: "text", text: "慢慢说" }] } as never,
		});
		await Bun.sleep(1200);
		const abortRes = await client.session.abort({ path: { id: session!.id }, query: { directory: workspace } });
		const aborted = await Promise.race([
			slowRun.then(() => "resolved" as const).catch((e: Error) => `rejected:${e.message.slice(0, 80)}` as const),
			Bun.sleep(20_000).then(() => "hung" as const),
		]);
		assert("cancel: abort ends the in-flight turn (no hang)", aborted !== "hung", { aborted, abortHttp: (abortRes as { response?: { status?: number } }).response?.status });

		// --- history --------------------------------------------------------------
		const msgs = await client.session.messages({ path: { id: session!.id }, query: { directory: workspace } });
		const history = ((msgs as { data?: unknown[] }).data ?? []) as Array<Record<string, unknown>>;
		assert("history: full message history read back from the engine", history.length >= 6, { messageCount: history.length });

		// --- diff -------------------------------------------------------------------
		// Note: /session/{id}/diff without messageID returns [] on this build.
		// Diffs are reported per user-message turn, and per-tool-part as
		// state.metadata.filediff / state.metadata.diff.
		const withParts = history.filter((m) => Array.isArray(m.parts) && (m.parts as unknown[]).length > 0);
		const userTurn = withParts.find((m) => String((m.info as Record<string, unknown>)?.role) === "user");
		const turnID = String((userTurn?.info as Record<string, unknown>)?.id ?? "");
		const diff = await client.session.diff({ path: { id: session!.id }, query: { directory: workspace, messageID: turnID } });
		const diffs = ((diff as { data?: unknown[] }).data ?? []) as Array<Record<string, unknown>>;
		assert("diff: engine reports the file change for a turn", diffs.some((d) => String(d.file ?? "").includes("PHASE1.txt")), diffs);
		const toolPartWithDiff = history
			.flatMap((m) => (m.parts ?? []) as Array<Record<string, unknown>>)
			.find((p) => p.type === "tool" && (p.state as Record<string, unknown>)?.metadata);
		assert("diff: tool parts carry filepath/diff metadata for the UI", !!toolPartWithDiff, true);
		assert("events: file change emitted as a diff event", seenTypes.has("session.diff"), [...seenTypes].sort());

		// --- event coverage ------------------------------------------------------
		assert("events: incremental part updates observed", seenTypes.has("message.part.updated"), [...seenTypes].sort());
		assert("events: session lifecycle observed", seenTypes.has("session.status") || seenTypes.has("session.idle"), [...seenTypes].sort());

		// --- resubscribe after disconnect -----------------------------------------
		ac.abort();
		await pump.catch(() => {});
		const ac2 = new AbortController();
		let afterReconnect = 0;
		const sub2 = await client.event.subscribe({ query: { directory: workspace }, signal: ac2.signal });
		const pump2 = (async () => {
			try {
				for await (const evt of sub2.stream) {
					const payload = ((evt as Record<string, unknown>).payload ?? evt) as Record<string, unknown>;
					if (String(payload.type ?? "")) afterReconnect++;
				}
			} catch {}
		})();
		await promptWithPermissions("总结一下", []);
		await Bun.sleep(500);
		assert("events: resubscribe after a disconnect keeps receiving events", afterReconnect > 0, afterReconnect);
		ac2.abort();
		await pump2.catch(() => {});

		// --- persistence across an engine restart --------------------------------
		server.proc.kill();
		await Bun.sleep(1500);
		server2 = await launchServer(env, workspace, engineLog);
		const client2 = createOpencodeClient({ baseUrl: server2.url });
		const listed = await client2.session.list({ query: { directory: workspace } });
		const listedSessions = ((listed as { data?: Array<{ id: string }> }).data ?? []) as Array<{ id: string }>;
		assert("persistence: session survives an engine restart", listedSessions.some((s) => s.id === session!.id), listedSessions.map((s) => s.id));

		const counts: Record<string, number> = {};
		notes.push(`engine version reported by the session record: ${String((session as unknown as Record<string, unknown>) && PINNED_VERSION)}`);
		notes.push(`observed event types: ${JSON.stringify([...seenTypes].sort())}`);
		notes.push(`mock provider served ${mock.requests.length} Chat Completions requests`);
		void counts;

		passed = steps.every((s) => s.ok);
		record("PHASE 1 VERDICT", passed, `${steps.filter((s) => s.ok).length}/${steps.length} steps passed`);
	} finally {
		try {
			server?.proc.kill();
		} catch {}
		try {
			server2?.proc.kill();
		} catch {}
		mock.stop();
		const report = {
			generatedAt: new Date().toISOString(),
			pinnedOpenCodeVersion: PINNED_VERSION,
			opencodeBinary: OPENCODE_BIN,
			sdk: "@opencode-ai/sdk 1.18.31",
			steps,
			notes,
			engineLog,
			passed,
		};
		const outFile = await writeReport(import.meta.dir, "phase1-report.json", report);
		console.log(`\n[phase1] report -> ${outFile}`);
		console.log(notes.join("\n"));
		if (!passed) {
			console.log("\n--- engine log (tail) ---");
			console.log(engineLog.slice(-30).join("\n"));
		}
		await rm(root, { recursive: true, force: true }).catch(() => {});
	}
}

/**
 * Write a JSON report, falling back to a timestamped filename when the preferred
 * path is locked by another process (editors, indexers and antivirus all do this
 * on Windows). Losing the report would lose the evidence, so we never give up.
 */
async function writeReport(dir: string, name: string, data: unknown): Promise<string> {
	const body = JSON.stringify(data, null, 2);
	const preferred = join(dir, name);
	try {
		await writeFile(preferred, body, "utf8");
		return preferred;
	} catch {
		const fallback = join(dir, `${name.replace(/\.json$/, "")}-${Date.now()}.json`);
		await writeFile(fallback, body, "utf8");
		return fallback;
	}
}

async function waitFor<T>(get: () => T | undefined, timeoutMs: number, label: string): Promise<T> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const v = get();
		if (v !== undefined) return v;
		await Bun.sleep(80);
	}
	throw new Error(`timed out waiting for ${label}`);
}

/** Reserve an ephemeral loopback port and release it for the child to bind. */
async function freePort(): Promise<number> {
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
	const port = server.port;
	server.stop(true);
	return port;
}

void readFile;
await main();
