/**
 * Characterises which bash commands the pinned engine asks permission for.
 *
 * Each command gets its OWN session so an approval can never leak from one
 * probe to the next. Harness code is not involved apart from the mock provider:
 * this measures the engine's own permission policy.
 *
 * Usage: bun testing/probe-bash-matrix.ts
 */
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockProvider } from "./mock-provider";

const ROOT = join(import.meta.dir, "..");
const { createOpencodeClient } = await import(join(ROOT, "vendor/opencode/sdk/dist/client.js"));
const { buildOpenCodeConfig, PROVIDER_ID } = await import(join(ROOT, "backend/src/engine/provider.ts"));
const { EngineProcess } = await import(join(ROOT, "backend/src/engine/process.ts"));
void buildOpenCodeConfig;

const COMMANDS = [
	"exit",
	" exit 7",
	"exit7",
	"EXIT 7",
	"exit 7 && echo joined",
	"echo joint && exit 3",
	"echo after-exit mention",
	"cmd /c exit 9",
	"(exit 5)",
	"exit /b 4",
];

async function main() {
	const root = await mkdtemp(join(tmpdir(), "harness-bash-matrix-"));
	process.env.HARNESS_DATA_DIR = join(root, "data");
	const workspace = join(root, "ws");
	await Bun.write(join(workspace, "README.md"), "# matrix workspace\n");

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
	const status = await eng.start(settings, "sk-bash-matrix", { force: true });
	const client = createOpencodeClient({
		baseUrl: status.url!,
		headers: { authorization: `Basic ${Buffer.from(`${eng.getUsername()}:${eng.getPassword()}`).toString("base64")}` },
	});
	const dir = { directory: workspace };

	let asks = 0;
	const pendingPerms = new Set<string>();
	const result = (await client.event.subscribe({ query: dir })) as { stream: AsyncGenerator<unknown> };
	void (async () => {
		for await (const raw of result.stream) {
			const payload = (((raw as Record<string, unknown>).payload ?? raw) as Record<string, unknown>) ?? {};
			if (String(payload.type) === "permission.asked") {
				asks++;
				pendingPerms.add(String((payload.properties as Record<string, unknown>)?.id ?? ""));
			}
		}
	})();

	const rows: Array<{ command: string; asked: string; note: string }> = [];
	for (const command of COMMANDS) {
		const created = (await client.session.create({ query: dir, body: { title: command } })) as { data?: Record<string, unknown> };
		const sessionId = String(created.data?.id ?? "");
		const before = asks;
		pendingPerms.clear();
		void (client.session.prompt({
			path: { id: sessionId },
			query: dir,
			body: { model: { providerID: PROVIDER_ID, modelID: "mock-model" }, parts: [{ type: "text", text: `CMD:${command}` }] },
		}) as Promise<unknown>);
		const deadline = Date.now() + 15_000;
		while (Date.now() < deadline) {
			const list = [...pendingPerms];
			if (list.length) {
				for (const id of list) {
					pendingPerms.delete(id);
					await client.postSessionIdPermissionsPermissionId({
						path: { id: sessionId, permissionID: id },
						query: dir,
						body: { response: "once" },
					});
				}
				break;
			}
			await Bun.sleep(80);
		}
		await Bun.sleep(2200);
		const asked = asks > before;
		rows.push({ command, asked: asked ? "ASKED" : "auto-ran", note: "" });
		console.log(`${asked ? "ASKED    " : "AUTO-RAN "} ${command}`);
	}

	console.log("\nworkspace after matrix:", (await readdir(workspace)).join(", "));
	console.log("\nSUMMARY");
	for (const row of rows) console.log(`  ${row.asked.padEnd(9)} ${row.command}`);

	mock.stop();
	await eng.stop(true);
	process.exit(0);
}

main().catch((error) => {
	console.error("matrix probe failed:", error);
	process.exit(1);
});
