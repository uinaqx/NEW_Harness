/**
 * Harness backend — lifecycle of the bundled OpenCode server child process.
 *
 * Guarantees the plan asks for:
 *  - loopback only, on a dynamically reserved port (never a fixed 3126/4096)
 *  - a random per-launch password; the engine refuses unauthenticated calls
 *  - console window hidden on Windows
 *  - the child is created inside the app's job object (owned by the shell) so
 *    the whole tree dies with the app; we additionally stop only *our* child
 *    (by PID) and never sweep processes by name
 *  - crash detection with a bounded restart policy that never silently
 *    re-sends a prompt
 */
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Subprocess } from "bun";
import { LOOPBACK, ENGINE_START_TIMEOUT_MS, paths } from "../config";
import { resolveOpenCodeBinary, stageEngineForSpawn, type BinaryResolution } from "./binary";
import { ENGINE_VERSION } from "./pin";
import { buildOpenCodeConfig } from "./provider";
import type { AppSettings } from "../app-settings";
import { redactText } from "./errors";

export type EngineState = "stopped" | "starting" | "running" | "crashed" | "failed";

export interface EngineStatus {
	state: EngineState;
	/** Instance identity: proves we are talking to the engine we started. */
	instanceId: string;
	version: string;
	url: string | null;
	port: number | null;
	pid: number | null;
	startedAt: number | null;
	restarts: number;
	lastError: string | null;
	/** Where the binary came from + whether the digest was verified. */
	binary: { path: string; source: string; sha256: string; verified: boolean } | null;
	authMode: "password";
}

type Listener = (status: EngineStatus) => void;

/** Reserve an ephemeral loopback port, then release it for the child to bind. */
export async function reservePort(): Promise<number> {
	const probe = Bun.serve({
		hostname: LOOPBACK,
		port: 0,
		fetch: () => new Response("probe"),
	});
	const port = probe.port ?? 0;
	probe.stop(true);
	if (!port) throw new Error("无法从操作系统获取空闲端口");
	return port;
}

const LOG_RING = 400;

export class EngineProcess {
	private child: Subprocess<"ignore", "pipe", "pipe"> | null = null;
	private state: EngineState = "stopped";
	private url: string | null = null;
	private port: number | null = null;
	private password = "";
	/**
	 * Random per launch as well. The engine defaults the Basic-auth user to
	 * `opencode`, but relying on a published default is needless exposure for a
	 * locally reachable service.
	 */
	private username = "";
	private instanceId = "";
	private startedAt: number | null = null;
	private restarts = 0;
	private lastError: string | null = null;
	private binary: BinaryResolution | null = null;
	private log: string[] = [];
	private listeners = new Set<Listener>();
	private stopping = false;
	private exitCount = 0;
	/**
	 * Increases on every spawn. An exit callback only acts when it still owns the
	 * current generation, so a killed predecessor can never be mistaken for a
	 * crash and trigger a second engine.
	 */
	private generation = 0;
	private lastListening: { generation: number; url: string } | null = null;
	/** Set while a turn is running so we never auto-restart under the user's feet. */
	private busy = false;

	onChange(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(): void {
		const snapshot = this.status();
		for (const listener of this.listeners) {
			try {
				listener(snapshot);
			} catch {}
		}
	}

	status(): EngineStatus {
		return {
			state: this.state,
			instanceId: this.instanceId,
			version: ENGINE_VERSION,
			url: this.url,
			port: this.port,
			pid: this.child?.pid ?? null,
			startedAt: this.startedAt,
			restarts: this.restarts,
			lastError: this.lastError,
			binary: this.binary
				? { path: this.binary.path, source: this.binary.source, sha256: this.binary.sha256, verified: this.binary.verified }
				: null,
			authMode: "password",
		};
	}

	isRunning(): boolean {
		return this.state === "running" && !!this.url;
	}

	getUrl(): string {
		if (!this.url) throw new Error("engine not running");
		return this.url;
	}

	getPassword(): string {
		return this.password;
	}

	/** Basic-auth user for the engine, random per launch. */
	getUsername(): string {
		return this.username;
	}

	setBusy(value: boolean): void {
		this.busy = value;
	}

	/** Redacted, ring-buffered engine output for the diagnostics panel. */
	tailLog(lines = 120): string[] {
		return this.log.slice(-lines);
	}

	private push(line: string, generation?: number): void {
		const clean = redactText(line.replace(/\r/g, "").trimEnd());
		if (!clean) return;
		this.log.push(clean);
		if (this.log.length > LOG_RING) this.log.splice(0, this.log.length - LOG_RING);
		const match = clean.match(/opencode server listening on (https?:\/\/\S+)/);
		if (match && generation !== undefined && generation === this.generation) {
			const url = match[1].replace(/\/$/, "");
			this.lastListening = { generation, url };
			if (this.handshake?.generation === generation) this.handshake.resolve(url);
		}
	}

	/** Pending startup handshake, resolved from the engine's stdout line. */
	private handshake: { generation: number; resolve: (url: string) => void; reject: (error: Error) => void } | null = null;

	private prepareDirs(): void {
		for (const dir of [paths.opencodeConfig(), paths.opencodeData(), paths.opencodeState(), paths.opencodeCache(), paths.logs()]) {
			mkdirSync(dir, { recursive: true });
		}
		// OpenCode discovers global Agent Skills under XDG_CONFIG_HOME/opencode/skills.
		// Preserve any user-edited copy rather than overwriting it on upgrade.
		const candidates = [
			process.env.HARNESS_SKILLS_DIR,
			join(import.meta.dir, "..", "..", "..", "vendor", "skills"),
			join(process.cwd(), "vendor", "skills"),
		].filter((value): value is string => !!value);
		const source = candidates.map((value) => resolve(value)).find((value) => existsSync(join(value, "MANIFEST.json")));
		if (!source) return;
		const manifest = JSON.parse(readFileSync(join(source, "MANIFEST.json"), "utf8")) as { skills: Array<{ name: string }> };
		const target = join(paths.opencodeConfig(), "opencode", "skills");
		mkdirSync(target, { recursive: true });
		for (const item of manifest.skills) {
			if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.name)) continue;
			const from = join(source, item.name);
			const to = join(target, item.name);
			if (existsSync(join(from, "SKILL.md")) && !existsSync(to)) cpSync(from, to, { recursive: true });
		}
	}

	private environment(config: ReturnType<typeof buildOpenCodeConfig>): Record<string, string> {
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(process.env)) {
			if (typeof value === "string") env[key] = value;
		}
		// Inline config: the API key stays in this child's environment and is
		// never written to a config file the engine could persist.
		env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
		env.OPENCODE_SERVER_PASSWORD = this.password;
		env.OPENCODE_SERVER_USERNAME = this.username;
		env.OPENCODE_DISABLE_AUTOUPDATE = "1";
		env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS = "1";
		env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "1";
		env.OPENCODE_DISABLE_SHARE = "1";
		// Permission sources, measured against the pinned engine (1.18.31, see
		// testing/verify-permissions.ts): the inline config wins. A project-local
		// `opencode.json` that grants `bash: "allow"` does NOT suppress the
		// approval, so `OPENCODE_DISABLE_PROJECT_CONFIG` is deliberately NOT set —
		// it would also discard the project's AGENTS.md instructions, which a
		// coding assistant is supposed to honour.
		// Isolate every engine-side directory under the app data dir.
		env.XDG_CONFIG_HOME = paths.opencodeConfig();
		env.XDG_DATA_HOME = paths.opencodeData();
		env.XDG_STATE_HOME = paths.opencodeState();
		env.XDG_CACHE_HOME = paths.opencodeCache();
		// The child must never be treated as a detached daemon.
		delete env.OPENCODE_SERVER_URL;
		return env;
	}

	async start(settings: AppSettings, apiKey: string, options: { force?: boolean; profileKeys?: Record<string, string> } = {}): Promise<EngineStatus> {
		if (this.state === "running") return this.status();
		if (this.state === "starting") throw new Error("引擎正在启动中");
		this.stopping = false;
		this.state = "starting";
		this.lastError = null;
		this.instanceId = `eng_${randomBytes(8).toString("hex")}`;
		this.password = randomBytes(24).toString("base64url");
		this.username = `harness-${randomBytes(6).toString("hex")}`;
		this.emit();

		this.binary = stageEngineForSpawn(resolveOpenCodeBinary(options.force));
		this.prepareDirs();
		const port = await reservePort();
		const config = buildOpenCodeConfig({ settings, apiKey, profileKeys: options.profileKeys });

		const args = ["serve", `--hostname=${LOOPBACK}`, `--port=${port}`, "--print-logs", "--log-level=INFO"];
		this.push(`[spawn] ${this.binary.path} ${args.join(" ")} (port ${port}, binary ${this.binary.verified ? "hash-verified" : "UNVERIFIED"})`);

		const generation = ++this.generation;
		this.lastListening = null;
		const child = Bun.spawn({
			cmd: [this.binary.path, ...args],
			cwd: process.cwd(),
			env: this.environment(config),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			// Hide the console window on Windows (CREATE_NO_WINDOW).
			windowsHide: true,
			onExit: (_proc, code, signal) => {
				if (generation !== this.generation) {
					this.push(`[exit] stale child generation=${generation} code=${code} (ignored)`);
					return;
				}
				this.exitCount++;
				this.push(`[exit] code=${code} signal=${signal} restarts=${this.restarts} busy=${this.busy}`);
				if (this.stopping) {
					this.state = "stopped";
					this.url = null;
					this.emit();
					return;
				}
				this.url = null;
				this.state = "crashed";
				this.lastError = `引擎进程退出（code=${code}）。当前任务已中断，不会自动重发。`;
				this.emit();
				void this.maybeRestart(settings, apiKey, options.profileKeys);
			},
		});
		this.child = child;
		this.port = port;
		this.startedAt = Date.now();
		void this.drain(child.stdout, "out", generation);
		void this.drain(child.stderr, "err", generation);

		try {
			const url = await this.awaitHandshake(child, port, generation);
			this.url = url;
			this.state = "running";
			this.push(`[ready] ${url} instance=${this.instanceId}`);
			this.emit();
			return this.status();
		} catch (error) {
			this.lastError = redactText(error instanceof Error ? error.message : String(error));
			this.state = "failed";
			this.push(`[startup-failed] ${this.lastError}`);
			await this.stop();
			this.state = "failed";
			this.emit();
			throw error;
		}
	}

	private async drain(stream: ReadableStream<Uint8Array> | undefined, channel: "out" | "err", generation: number): Promise<void> {
		if (!stream) return;
		const decoder = new TextDecoder();
		const reader = stream.getReader();
		let buffer = "";
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) this.push(`[${channel}] ${line}`, generation);
			}
			if (buffer.trim()) this.push(`[${channel}] ${buffer}`, generation);
		} catch {}
	}

	/**
	 * The engine announces its real address on stdout
	 * (`opencode server listening on http://127.0.0.1:<port>`). That line is the
	 * startup handshake: we only proceed once the advertised port matches the one
	 * we reserved, so a different process squatting the port cannot impersonate it.
	 */
	private awaitHandshake(child: Subprocess, port: number, generation: number): Promise<string> {
		const expected = `http://${LOOPBACK}:${port}`;
		return new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => {
				if (this.handshake?.generation === generation) this.handshake = null;
				reject(
					new Error(
						`引擎在 ${ENGINE_START_TIMEOUT_MS / 1000} 秒内没有完成启动握手。` +
							`最近日志：\n${this.log.slice(-10).join("\n")}`,
					),
				);
			}, ENGINE_START_TIMEOUT_MS);
			void child.exited.then(() => {
				clearTimeout(timer);
				if (this.handshake?.generation === generation) {
					this.handshake = null;
					reject(new Error(`引擎在握手完成前退出。最近日志：\n${this.log.slice(-10).join("\n")}`));
				}
			});
			this.handshake = {
				generation,
				resolve: (url) => {
					clearTimeout(timer);
					if (this.handshake?.generation === generation) this.handshake = null;
					if (url !== expected) {
						reject(new Error(`引擎上报的地址 ${url} 与预留端口不一致（期望 ${expected}）。`));
						return;
					}
					resolve(url);
				},
				reject,
			};
			// A line that arrived before subscription is valid only for this child.
			if (this.lastListening?.generation === generation) this.handshake.resolve(this.lastListening.url);
		});
	}

	private async maybeRestart(settings: AppSettings, apiKey: string, profileKeys?: Record<string, string>): Promise<void> {
		// A turn in flight is never resumed automatically: the plan forbids
		// re-sending user messages or commands behind the user's back.
		if (this.busy || this.stopping) return;
		if (this.restarts >= 3) {
			this.lastError = `引擎连续异常退出 ${this.restarts} 次，已停止自动重启。请查看诊断日志。`;
			this.emit();
			return;
		}
		this.restarts++;
		this.push(`[restart] attempt ${this.restarts} after unexpected exit`);
		await Bun.sleep(600);
		if (this.stopping || this.busy) return;
		try {
			await this.start(settings, apiKey, { profileKeys });
		} catch (error) {
			this.lastError = redactText(error instanceof Error ? error.message : String(error));
			this.emit();
		}
	}

	/**
	 * Stop the engine. Only our own child (and its tree) is touched — we never
	 * enumerate processes by name, so an independently installed `opencode`
	 * belonging to the user is left alone.
	 */
	async stop(force = false): Promise<void> {
		const child = this.child;
		// Invalidate the child's generation first so its exit callback cannot be
		// mistaken for a crash and spawn a replacement behind our back.
		this.generation++;
		this.stopping = true;
		if (!child) {
			this.child = null;
			this.url = null;
			this.port = null;
			this.state = "stopped";
			this.emit();
			return;
		}
		const pid = child.pid;
		try {
			if (process.platform === "win32") {
				// Snapshot file locking is unreliable while the child lives.
				const killer = Bun.spawn({
					cmd: ["taskkill", "/pid", String(pid), "/T", ...(force ? ["/F"] : [])],
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
					windowsHide: true,
				});
				await killer.exited;
			} else {
				child.kill(force ? "SIGKILL" : "SIGTERM");
			}
		} catch {}
		try {
			child.kill();
		} catch {}
		await Promise.race([child.exited, Bun.sleep(4000)]);
		this.child = null;
		this.url = null;
		this.port = null;
		this.state = "stopped";
		this.emit();
	}

	/** Restart with a fresh port/password (used by the settings "restart engine" action). */
	async restart(settings: AppSettings, apiKey: string, force = false, profileKeys?: Record<string, string>): Promise<EngineStatus> {
		await this.stop(true);
		this.restarts = 0;
		return this.start(settings, apiKey, { force, profileKeys });
	}
}

export function writeEngineLogHeader(status: EngineStatus): void {
	try {
		writeFileSync(
			paths.engineLog(),
			`# harness engine log - ${new Date().toISOString()}\n` +
				`# version=${status.version} url=${status.url ?? "-"} pid=${status.pid ?? "-"}\n` +
				`# binary=${status.binary?.path ?? "-"} verified=${status.binary?.verified ?? false}\n`,
			{ encoding: "utf8", flag: "w" },
		);
	} catch {}
}
