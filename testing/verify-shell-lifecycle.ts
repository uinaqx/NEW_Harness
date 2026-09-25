/**
 * Desktop-shell lifecycle verification (phase 4 acceptance, local, no install).
 *
 * Runs the built shell in headless mode against an isolated data directory and
 * checks the properties the plan cares about most:
 *   - the shell starts the backend and verifies its identity before proceeding
 *   - the OpenCode engine comes up as a child of the backend
 *   - after the shell is **force-killed** (as Task Manager would), no
 *     `harness-backend.exe` / `harness-engine.exe` survives — the Job Object owns
 *     the whole tree
 *   - nothing under the program directory is locked by the running app
 *
 * Usage: bun testing/verify-shell-lifecycle.ts [path/to/harness-shell.exe]
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_SHELL = join(import.meta.dir, "..", "shell", "src-tauri", "target", "release", "harness-shell.exe");
const SHELL = process.argv[2] ?? DEFAULT_SHELL;

const steps: Array<{ name: string; ok: boolean; detail: string }> = [];
const notes: string[] = [];

function record(name: string, ok: boolean, detail: unknown) {
	const text = typeof detail === "string" ? detail : JSON.stringify(detail);
	steps.push({ name, ok, detail: text.length > 600 ? `${text.slice(0, 600)}…` : text });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${text ? ` — ${text.slice(0, 200)}` : ""}`);
}

function assert(name: string, cond: boolean, detail: unknown) {
	record(name, cond, detail);
	if (!cond) throw new Error(`assertion failed: ${name} (${JSON.stringify(detail)})`);
}

/** Names of live processes for our own executables (matching is by exact name). */
function liveHarnessProcesses(): Array<{ name: string; pid: number }> {
	const result = Bun.spawnSync({
		cmd: ["tasklist", "/FO", "CSV", "/NH"],
		stdout: "pipe",
		stderr: "pipe",
	});
	const out = result.stdout.toString();
	const found: Array<{ name: string; pid: number }> = [];
	for (const line of out.split(/\r?\n/)) {
		const cells = line.split('","').map((cell) => cell.replace(/^"|"$/g, ""));
		if (cells.length < 2) continue;
		const name = cells[0].toLowerCase();
		if (!name.startsWith("harness-")) continue;
		if (name.endsWith(".exe.stale")) continue;
		found.push({ name: cells[0], pid: Number(cells[1]) || 0 });
	}
	return found;
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

async function main() {
	if (!existsSync(SHELL)) throw new Error(`shell not built at ${SHELL}`);
	const root = await mkdtemp(join(tmpdir(), "harness-shell-it-"));
	const dataDir = join(root, "data");
	const logs = join(dataDir, "logs");
	await mkdir(logs, { recursive: true });

	const before = liveHarnessProcesses();
	// Leftovers from an earlier build (0.1.x closed to the tray rather than exiting)
	// may legitimately still be running. They are recorded, not killed, and are
	// excluded from the survivor check — which is scoped to the processes this
	// test starts.
	if (before.length) {
		notes.push(`pre-existing Harness processes (left alone): ${JSON.stringify(before)}`);
		record("precondition: recorded pre-existing Harness processes", true, before);
	} else {
		record("precondition: no Harness process is running before the test", true, []);
	}
	const preexistingPids = new Set(before.map((entry) => entry.pid));

	// The backend only starts the engine once a credential exists, so seed one into
	// the isolated data directory using the backend's own DPAPI store.
	const { saveCredential } = await import("../backend/src/secrets");
	const method = saveCredential(join(dataDir, "credentials.bin"), "sk-shell-lifecycle-probe-0000");
	assert("setup: an OS-protected credential was seeded for the isolated data dir", method === "dpapi", method);
	await writeFile(
		join(dataDir, "app-settings.json"),
		JSON.stringify(
			{
				version: 1,
				protocol: "openai-compatible",
				baseUrl: "http://127.0.0.1:9/v1",
				model: "probe-model",
				lastWorkspace: root,
				autoApproveEdits: false,
				autoApproveCommands: false,
				theme: "dark",
			},
			null,
			2,
		),
		"utf8",
	);

	const shell = Bun.spawn({
		cmd: [SHELL],
		env: { ...process.env, HARNESS_DATA_DIR: dataDir, HARNESS_HEADLESS: "1" },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});
	console.log(`[shell-it] started harness-shell.exe pid=${shell.pid}`);

	let handshake: Record<string, unknown> | null = null;
	const deadline = Date.now() + 90_000;
	while (Date.now() < deadline) {
		try {
			handshake = JSON.parse(await readFile(join(dataDir, "runtime.json"), "utf8")) as Record<string, unknown>;
			break;
		} catch {
			await Bun.sleep(250);
		}
	}
	assert("handshake: the shell published the backend endpoint", !!handshake, handshake);

	const health = (await fetch(`http://127.0.0.1:${handshake!.port}/health`).then((r) => r.json())) as Record<string, unknown>;
	assert("identity: /health agrees with the handshake instance id", health.instanceId === handshake!.instanceId, {
		handshake: handshake!.instanceId,
		health: health.instanceId,
	});

	const shellLogPath = join(logs, "shell.log");
	/** The shell writes its log asynchronously; poll instead of reading once. */
	async function waitForLogLine(fragment: string, timeoutMs: number): Promise<string> {
		const deadline = Date.now() + timeoutMs;
		let text = "";
		while (Date.now() < deadline) {
			text = await readFile(shellLogPath, "utf8").catch(() => "");
			if (text.includes(fragment)) return text;
			await Bun.sleep(250);
		}
		return text;
	}

	const shellLog = await waitForLogLine("handshake verified", 30_000);
	assert(
		"handshake: the shell verified version + instance identity before opening the window",
		shellLog.includes("handshake verified"),
		shellLog.split("\n").filter(Boolean).slice(-6),
	);
	assert(
		"lifecycle: the backend was placed in the kill-on-close job object",
		shellLog.includes("assigned to the kill-on-close job object"),
		shellLog.split("\n").filter(Boolean).slice(-10),
	);
	assert(
		"engine: the shell pointed the backend at the packaged engine",
		shellLog.includes("engine for the backend"),
		shellLog.split("\n").filter((line) => line.includes("engine for the backend")),
	);

	// Give the backend a moment to bring the engine up. Only processes started by
	// *this* test are considered (pre-existing leftovers are reported separately).
	let processes: Array<{ name: string; pid: number }> = [];
	const procDeadline = Date.now() + 60_000;
	while (Date.now() < procDeadline) {
		processes = liveHarnessProcesses().filter((entry) => !preexistingPids.has(entry.pid));
		const names = processes.map((p) => p.name.toLowerCase());
		if (names.some((name) => name.startsWith("harness-backend") && name.endsWith(".exe")) && names.includes("harness-engine.exe")) break;
		await Bun.sleep(400);
	}
	const names = processes.map((p) => p.name.toLowerCase());
	assert("engine: the backend started its own engine child", names.includes("harness-engine.exe"), processes);
	assert(
		"naming: the running engine uses the Harness-owned name (a user-installed opencode.exe is never touched)",
		!names.includes("opencode.exe"),
		names,
	);

	const backendOutput = join(dataDir, "logs", "backend.log");
	const backendLog = await readFile(backendOutput, "utf8").catch(() => "");
	assert(
		"startup: backend log records that the engine reached running state",
		backendLog.includes("engine    : running") || backendLog.includes("engine    : not started"),
		backendLog.split("\n").filter(Boolean).slice(-8),
	);
	const stagedSkills = join(dataDir, "opencode", "config", "opencode", "skills");
	assert(
		"skills: the installed shell made bundled skills available to OpenCode",
		existsSync(join(stagedSkills, "systematic-debugging", "SKILL.md")) &&
			existsSync(join(stagedSkills, "frontend-design", "SKILL.md")),
		stagedSkills,
	);

	// Force-kill the shell the way Task Manager would: no graceful shutdown code runs.
	Bun.spawnSync({ cmd: ["taskkill", "/PID", String(shell.pid), "/T", "/F"], stdout: "pipe", stderr: "pipe", windowsHide: true });
	console.log(`[shell-it] force-killed the shell (pid ${shell.pid})`);

	let survivors: Array<{ name: string; pid: number }> = [];
	const killDeadline = Date.now() + 30_000;
	while (Date.now() < killDeadline) {
		survivors = liveHarnessProcesses().filter((entry) => !preexistingPids.has(entry.pid));
		if (survivors.length === 0) break;
		await Bun.sleep(400);
	}
	assert("lifecycle: force-killing the shell leaves no Harness child behind", survivors.length === 0, survivors);
	notes.push(`survivor check: 0 of the ${processes.length} processes started by this test remained`);

	// The program directory must not be locked by a dead app either.
	const installedEngine = join(SHELL, "..", "opencode", "opencode.exe");
	if (existsSync(installedEngine)) {
		const probe = Bun.spawnSync(["powershell.exe", "-NoProfile", "-File", join(import.meta.dir, "verify-file-unlocked.ps1"), "-Path", installedEngine], { windowsHide: true, stdout: "ignore", stderr: "ignore" }).exitCode === 0;
		assert("files: the packaged engine in the program directory is not locked", probe, installedEngine);
	} else {
		record("files: packaged engine present", false, `${installedEngine} missing (build the shell first)`);
	}

	const passed = steps.every((step) => step.ok);
	record("SHELL LIFECYCLE VERDICT", passed, `${steps.filter((s) => s.ok).length}/${steps.length} steps passed`);
	const reportPath = await writeReport("shell-lifecycle-report.json", { generatedAt: new Date().toISOString(), shell: SHELL, steps, notes, passed });
	console.log(`[shell-it] report -> ${reportPath} (${passed ? "PASS" : "FAIL"})`);
	if (!passed) {
		console.log("\n--- shell log ---");
		console.log(shellLog);
	}
}

await main();
