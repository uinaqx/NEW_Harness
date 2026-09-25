/**
 * Raw engine permission probe — talks to the pinned OpenCode SDK directly,
 * WITHOUT any Harness adapter code.
 *
 * Purpose: decide whether the observed "second command was not asked about"
 * comes from the engine's own permission policy or from the Harness
 * normaliser dropping the event. Every SSE event is printed verbatim, so both
 * halves can be inspected.
 *
 * Usage: HARNESS_DATA_DIR=<temp> bun testing/probe-raw-permissions.ts
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockProvider } from "./mock-provider";

const ROOT = join(import.meta.dir, "..");

const { createOpencodeClient } = await import(join(ROOT, "vendor/opencode/sdk/dist/client.js"));
const { buildOpenCodeConfig, PROVIDER_ID } = await import(join(ROOT, "backend/src/engine/provider.ts"));
const { EngineProcess } = await import(join(ROOT, "backend/src/engine/process.ts"));

const OPENCODE_BIN = join(ROOT, "vendor/opencode/bin/opencode.exe");

interface Event {
	type: string;
	properties?: Record<string, unknown>;
}

async function main() {
	const root = await mkdtemp(join(tmpdir(), "harness-raw-perm-"));
	process.env.HARNESS_DATA_DIR = join(root, "data");

	const workspace = join(root, "ws");
	await Bun.write(join(workspace, "README.md"), "# raw workspace\n");

	const mock = startMockProvider({});
	const eng = new EngineProcess();
	const settings = {
		version: 1 as const,
		protocol: "openai-compatible" as const,
		baseUrl: `${mock.url}/v1`,
		model: "mock-model",
		lastWorkspace: "",
		autoApproveEdits: false,
		autoApproveCommands: false,
		theme: "dark" as const,
	};
	const status = await eng.start(settings, "sk-raw-probe", { force: true });
	console.log(`engine up: ${status.url}`);

	const client = createOpencodeClient({
		baseUrl: status.url!,
		headers: { authorization: `Basic ${Buffer.from(`${eng.getUsername()}:${eng.getPassword()}`).toString("base64")}` },
	});
	const dir = { directory: workspace };

	const seen: string[] = [];
	let permissionAsks = 0;
	const pendingPerms = new Set<string>();

	async function subscribe() {
		const result = (await client.event.subscribe({ query: dir })) as { stream: AsyncGenerator<unknown> };
		void (async () => {
			for await (const raw of result.stream) {
				const payload = (((raw as Record<string, unknown>).payload ?? raw) as Record<string, unknown>) ?? {};
				const ev = payload as Event;
				const type = String(ev.type ?? "");
				seen.push(type);
				if (type.startsWith("permission.")) {
					const props = ev.properties ?? {};
					console.log(`    [event] ${type} id=${String(props.id ?? "-")} perm=${String(props.permission ?? "-")} patterns=${JSON.stringify(props.patterns ?? [])}`);
					if (type === "permission.asked") {
						permissionAsks++;
						pendingPerms.add(String(props.id ?? ""));
					}
				}
			}
		})();
	}
	await subscribe();

	const created = (await client.session.create({ query: dir, body: { title: "raw probe" } })) as { data?: Record<string, unknown> };
	const sessionId = String(created.data?.id ?? "");
	console.log(`session ${sessionId}`);

	async function askAndRun(prompt: string, decision: "once" | "reject") {
		console.log(`\n--- turn: ${prompt} (decision=${decision}) ---`);
		const before = permissionAsks;
		const seenBefore = seen.length;
		void (client.session.prompt({
			path: { id: sessionId },
			query: dir,
			body: { model: { providerID: PROVIDER_ID, modelID: "mock-model" }, parts: [{ type: "text", text: prompt }] },
		}) as Promise<unknown>);

		// Wait for an ask (bounded), then answer every ask we saw this turn.
		const deadline = Date.now() + 20_000;
		let answered = false;
		while (Date.now() < deadline) {
			const pending_now = [...pendingPerms];
			if (pending_now.length) {
				for (const id of pending_now) {
					pendingPerms.delete(id);
					await client.postSessionIdPermissionsPermissionId({
						path: { id: sessionId, permissionID: id },
						query: dir,
						body: { response: decision },
					});
					console.log(`    -> replied ${decision} to ${id.slice(0, 8)}`);
					answered = true;
				}
			}
			if (answered && Date.now() > deadline - 15_000) break;
			await Bun.sleep(100);
		}
		await Bun.sleep(1500);
		console.log(`    permission.asked this turn: ${permissionAsks - before}`);
		console.log(`    events this turn: ${[...new Set(seen.slice(seenBefore))].join(", ")}`);
	}

	await askAndRun("命令甲", "once");
	console.log(`    alpha.txt exists: ${existsSync(join(workspace, "alpha.txt"))}`);
	await askAndRun("失败命令", "once");
	await askAndRun("命令乙", "once");
	console.log(`    beta.txt exists: ${existsSync(join(workspace, "beta.txt"))}`);
	await askAndRun("失败命令", "once");
	await askAndRun("命令甲", "once");

	console.log(`\nworkspace: ${(await readdir(workspace)).join(", ")}`);
	console.log(`total permission.asked: ${permissionAsks}`);

	mock.stop();
	await eng.stop(true);
	process.exit(0);
}

main().catch((error) => {
	console.error("raw probe failed:", error);
	process.exit(1);
});
