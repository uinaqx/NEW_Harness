/** Real-provider regression in an isolated data directory; credentials stay DPAPI protected. */
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { InstalledClient } from "./installed-client";

const root = resolve(import.meta.dir, "..");
const source = join(process.env.LOCALAPPDATA!, "Harness", "data");
const dataDir = await mkdtemp(join(tmpdir(), "harness-character-"));
const client = new InstalledClient();
const checks: Array<{ name: string; ok: boolean; detail?: unknown }> = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
	checks.push({ name, ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${typeof detail === "string" ? `: ${detail}` : ""}`);
	if (!ok) throw new Error(name);
};
let child: ReturnType<typeof Bun.spawn> | undefined;
let error: string | undefined;
let protocol = "";
let model = "";
try {
	const settings = JSON.parse(await readFile(join(source, "app-settings.json"), "utf8"));
	const protocolOverride = process.argv.find((arg) => arg.startsWith("--protocol="))?.slice("--protocol=".length);
	const endpointOverride = process.argv.find((arg) => arg.startsWith("--base-url="))?.slice("--base-url=".length);
	if (protocolOverride && endpointOverride) {
		if (protocolOverride !== "anthropic" && protocolOverride !== "openai-compatible") throw new Error("Invalid test protocol");
		const profile = settings.profiles.find((item: any) => item.id === settings.defaultProfileId);
		profile.protocol = settings.protocol = protocolOverride;
		profile.baseUrl = settings.baseUrl = endpointOverride;
	}
	settings.themePreset = "fairy";
	settings.lastWorkspace = "";
	await writeFile(join(dataDir, "app-settings.json"), JSON.stringify(settings));
	if (existsSync(join(source, "credentials.bin"))) await cp(join(source, "credentials.bin"), join(dataDir, "credentials.bin"));
	if (existsSync(join(source, "credentials"))) await cp(join(source, "credentials"), join(dataDir, "credentials"), { recursive: true });
	const binary = process.argv[2]?.startsWith("--") ? undefined : process.argv[2];
	child = Bun.spawn({ cmd: binary ? [resolve(binary)] : [process.execPath, join(root, "backend", "src", "index.ts")], cwd: root, env: { ...process.env, HARNESS_DEV: "1", HARNESS_DATA_DIR: dataDir, HARNESS_OPENCODE_BIN: join(root, "vendor", "opencode", "bin", "opencode.exe") }, stdout: "ignore", stderr: "ignore", stdin: "ignore", windowsHide: true });
	let connected = false;
	for (let attempt = 0; attempt < 100; attempt++) {
		try { await client.connect(dataDir); connected = true; break; } catch { await Bun.sleep(200); }
	}
	check("isolated backend starts", connected);
	const state = await client.invoke("get_model_settings");
	protocol = state.settings.protocol;
	model = state.settings.model;
	check("saved protected credential is available", state.settings.hasApiKey);
	for (const theme of ["fairy", "klee"] as const) {
		await client.invoke("save_model_settings", { themePreset: theme });
		const { session } = await client.invoke("create_session", { kind: "chat" });
		for (const [index, prompt] of ["你是谁？请用你自己的语气简单介绍自己。", "你好！用你自己的语气告诉我你会怎样帮助我，不超过两句话。", "请用 Markdown 回答：一个加粗的小标题，下面两条简短列表。介绍你的特点。"].entries()) {
			const cursor = client.events.length;
			await client.invoke("chat_session_command", { action: "send", sessionId: session.id, prompt });
			let completion: any;
			const deadline = Date.now() + 180000;
			while (Date.now() < deadline) {
				completion = client.events.slice(cursor).find((event) => event.name === "chat_event" && event.payload.sessionId === session.id && event.payload.stream === "chat_done");
				if (completion) break;
				await Bun.sleep(100);
			}
			check(`${theme} turn ${index + 1} completes`, !!completion && JSON.parse(completion.payload.chunk).reason === "completed");
			const events = client.events.slice(cursor).filter((event) => event.name === "chat_event" && event.payload.sessionId === session.id);
			const answer = events.filter((event) => event.payload.stream === "chat_text").map((event) => event.payload.chunk).join("");
			check(`${theme} turn ${index + 1} answer arrives without refresh`, answer.trim().length > 0, answer);
			check(`${theme} turn ${index + 1} has no internal English analysis`, !/let me|i should|i need to|syntax ok|opencode|作为.*编程助手|只是.*风格参考/i.test(answer));
			if (index === 0) check(`${theme} introduces the selected identity`, answer.includes(theme === "fairy" ? "Fairy" : "可莉"));
			if (index === 0) check(`${theme} uses the requested user address`, theme === "fairy" ? answer.includes("主人") : /荣誉骑士|旅行者/.test(answer), answer);
			if (index === 2) check(`${theme} returns real Markdown`, /\*\*[^*]+\*\*/.test(answer) && /(?:^|\n)\s*[-*]\s+/.test(answer));
			const history = (await client.invoke("read_session_messages", { sessionId: session.id })).messages;
			const last = history.filter((message: any) => message.role === "assistant").at(-1);
			check(`${theme} turn ${index + 1} stream matches stored final answer`, last?.content.trim() === answer.trim());
		}
		const workspace = join(dataDir, "work-fixture", theme);
		await mkdir(workspace, { recursive: true });
		await writeFile(join(workspace, "greeting.txt"), "LOCAL_WORK_READ_OK\n");
		const { session: work } = await client.invoke("create_session", { workspaceRoot: workspace, kind: "work" });
		const cursor = client.events.length;
		await client.invoke("chat_session_command", { action: "send", sessionId: work.id, prompt: "请读取 greeting.txt，再以你自己的角色语气简单介绍你是谁并原样引用文件里的标记。不要修改文件或执行命令。" });
		let completion: any;
		const deadline = Date.now() + 180000;
		while (Date.now() < deadline) {
			completion = client.events.slice(cursor).find((event) => event.name === "chat_event" && event.payload.sessionId === work.id && event.payload.stream === "chat_done");
			if (completion) break;
			await Bun.sleep(100);
		}
		check(`${theme} Work reading turn completes`, !!completion && JSON.parse(completion.payload.chunk).reason === "completed");
		const events = client.events.slice(cursor).filter((event) => event.name === "chat_event" && event.payload.sessionId === work.id);
		const answer = events.filter((event) => event.payload.stream === "chat_text").map((event) => event.payload.chunk).join("");
		check(`${theme} Work result keeps role identity`, answer.includes(theme === "fairy" ? "Fairy" : "可莉") && answer.includes("LOCAL_WORK_READ_OK"), answer);
		check(`${theme} Work result uses the requested user address`, theme === "fairy" ? answer.includes("主人") : /荣誉骑士|旅行者/.test(answer), answer);
		check(`${theme} Work reading emits a real canvas step`, events.some((event) => event.payload.stream === "chat_tool_call_end" && JSON.parse(event.payload.chunk).toolName === "read"));
		check(`${theme} Work answer does not leak English thoughts`, !/let me|i should|i need to|syntax ok|opencode/i.test(answer));
	}
} catch (caught) {
	error = caught instanceof Error ? caught.message : String(caught);
	console.log(`Character acceptance failed: ${error}`);
} finally {
	try { await client.invoke("engine_stop"); } catch {}
	client.close();
	if (child) {
		const kill = Bun.spawn(["taskkill", "/PID", String(child.pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore", windowsHide: true });
		await kill.exited;
		await child.exited;
	}
	// Delete only the known protected credential copies, never the user's store.
	await rm(join(dataDir, "credentials.bin"), { force: true });
	await rm(join(dataDir, "credentials"), { recursive: true, force: true });
	const version = (await Bun.file(join(root, "package.json")).json()).version;
	const out = join(root, "delivery", "qa", version);
	await mkdir(out, { recursive: true });
	await writeFile(join(out, `character-replies-${protocol || "unconfigured"}-report.json`), JSON.stringify({ at: new Date().toISOString(), protocol, model, passed: !error && checks.every((item) => item.ok), checks, error }, null, 2));
}
process.exit(error ? 1 : 0);
