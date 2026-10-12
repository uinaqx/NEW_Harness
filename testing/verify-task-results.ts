/** Real model + non-Git file delivery. Only protected credential copies and isolated fixtures are used. */
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { InstalledClient } from "./installed-client";

const root = resolve(import.meta.dir, "..");
const source = join(process.env.LOCALAPPDATA!, "Harness", "data");
const dataDir = await mkdtemp(join(tmpdir(), "harness-task-result-"));
const workspace = join(dataDir, "non-git-project");
const client = new InstalledClient();
const checks: Array<{ name: string; ok: boolean; detail?: unknown }> = [];
const check = (name: string, ok: boolean, detail?: unknown) => { checks.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}`); if (!ok) throw new Error(name); };
let child: ReturnType<typeof Bun.spawn> | undefined;
let error: string | undefined;
try {
	const settings = JSON.parse(await readFile(join(source, "app-settings.json"), "utf8"));
	settings.themePreset = "klee";
	settings.fullAccess = true;
	settings.lastWorkspace = "";
	await writeFile(join(dataDir, "app-settings.json"), JSON.stringify(settings));
	if (existsSync(join(source, "credentials.bin"))) await cp(join(source, "credentials.bin"), join(dataDir, "credentials.bin"));
	if (existsSync(join(source, "credentials"))) await cp(join(source, "credentials"), join(dataDir, "credentials"), { recursive: true });
	await mkdir(workspace, { recursive: true });
	const binary = process.argv[2];
	child = Bun.spawn({ cmd: binary ? [resolve(binary)] : [process.execPath, join(root, "backend", "src", "index.ts")], cwd: root, env: { ...process.env, HARNESS_DEV: "1", HARNESS_DATA_DIR: dataDir, HARNESS_OPENCODE_BIN: join(root, "vendor", "opencode", "bin", "opencode.exe") }, stdout: "ignore", stderr: "ignore", stdin: "ignore", windowsHide: true });
	let connected = false;
	for (let attempt = 0; attempt < 100; attempt++) { try { await client.connect(dataDir); connected = true; break; } catch { await Bun.sleep(200); } }
	check("isolated backend starts", connected);
	const { session } = await client.invoke("create_session", { workspaceRoot: workspace, kind: "work" });
	for (const [index, prompt] of [
		"请仅在当前临时项目内创建一个原生 JavaScript 计数器网页 counter.html，提供加一按钮和计数显示；同时写一个简短的 README.md 说明打开方法。实际保存文件，不需联网或安装依赖。",
		"请仅修改 counter.html，加入归零按钮。读取现有文件后再修改，保留加一功能，不要修改 README.md。不需联网或安装依赖。",
	].entries()) {
		const cursor = client.events.length;
		await client.invoke("chat_session_command", { action: "send", sessionId: session.id, prompt });
		let done: any;
		const deadline = Date.now() + 240000;
		while (Date.now() < deadline) { done = client.events.slice(cursor).find((event) => event.name === "chat_event" && event.payload.sessionId === session.id && event.payload.stream === "chat_done"); if (done) break; await Bun.sleep(150); }
		const completion = done ? JSON.parse(done.payload.chunk) : {};
		check(`round ${index + 1} completes`, completion.reason === "completed");
		const events = client.events.slice(cursor).filter((event) => event.name === "chat_event" && event.payload.sessionId === session.id);
		const answer = events.filter((event) => event.payload.stream === "chat_text").map((event) => event.payload.chunk).join("");
		check(`round ${index + 1} gives final feedback without full-file source`, answer.trim().length > 0 && !/<!doctype html|<html[\s>]|```(?:html|javascript|js)\s*[\s\S]{300}/i.test(answer), { answerCharacters: answer.length });
		check(`round ${index + 1} retains Klee voice and user address`, /荣誉骑士|旅行者/.test(answer));
		const diffs = completion.diffs ?? [];
		check(`round ${index + 1} hands off the file collection with completion`, diffs.some((diff: any) => diff.file === "counter.html" && diff.additions > 0 && diff.patch.length > 0), diffs.map((diff: any) => ({ file: diff.file, additions: diff.additions, deletions: diff.deletions })));
		if (index === 0) check("new HTML and README are both in the collection", diffs.length === 2 && diffs.some((diff: any) => diff.file === "README.md"));
		else check("next round excludes the earlier README", diffs.length === 1 && diffs[0].file === "counter.html");
		const loaded = await client.invoke("list_session_diffs", { sessionId: session.id, latestTurn: true });
		check(`round ${index + 1} reload matches the completion collection`, JSON.stringify(loaded.diffs) === JSON.stringify(diffs));
		const preview = await client.invoke("read_workspace_file", { sessionId: session.id, file: "counter.html" });
		check(`round ${index + 1} changed file opens with live HTML preview`, preview.content.includes("<html") && typeof preview.previewUrl === "string" && (await fetch(preview.previewUrl)).ok);
	}
} catch (caught) { error = caught instanceof Error ? caught.message : String(caught); console.log(`Acceptance failed: ${error}`); }
finally {
	try { await client.invoke("engine_stop"); } catch {}
	client.close();
	if (child) { const kill = Bun.spawn(["taskkill", "/PID", String(child.pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore", windowsHide: true }); await kill.exited; await child.exited; }
	await rm(join(dataDir, "credentials.bin"), { force: true });
	await rm(join(dataDir, "credentials"), { recursive: true, force: true });
	const version = (await Bun.file(join(root, "package.json")).json()).version;
	const out = join(root, "delivery", "qa", version);
	await mkdir(out, { recursive: true });
	await writeFile(join(out, "task-results-real-report.json"), JSON.stringify({ at: new Date().toISOString(), passed: !error, checks, error }, null, 2));
}
process.exit(error ? 1 : 0);
