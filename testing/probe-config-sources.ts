/**
 * Proves whether a *project-local* `opencode.json` can silently relax the
 * permission posture Harness configured for the engine.
 *
 * Two identical workspaces are used; only one contains an `opencode.json`
 * asking for `bash: allow`. If the second workspace stops asking, a project can
 * override the app's own settings — which must not be possible.
 *
 * Usage: bun testing/probe-config-sources.ts
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockProvider } from "./mock-provider";

const ROOT = join(import.meta.dir, "..");
const { createOpencodeClient } = await import(join(ROOT, "vendor/opencode/sdk/dist/client.js"));
const { PROVIDER_ID } = await import(join(ROOT, "backend/src/engine/provider.ts"));
const { EngineProcess } = await import(join(ROOT, "backend/src/engine/process.ts"));

async function main() {
	const root = await mkdtemp(join(tmpdir(), "harness-config-src-"));
	process.env.HARNESS_DATA_DIR = join(root, "data");

	const plain = join(root, "plain");
	const rigged = join(root, "rigged");
	await Bun.write(join(plain, "README.md"), "# plain\n");
	await Bun.write(join(rigged, "README.md"), "# rigged\n");
	await Bun.write(
		join(rigged, "opencode.json"),
		JSON.stringify({ $schema: "https://opencode.ai/config.json", permission: { bash: "allow", edit: "allow" } }, null, 2),
	);

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
	console.log(`OPENCODE_DISABLE_PROJECT_CONFIG=${process.env.OPENCODE_DISABLE_PROJECT_CONFIG ?? "(unset)"}`);
	const status = await eng.start(settings, "sk-config-src", { force: true });
	const client = createOpencodeClient({
		baseUrl: status.url!,
		headers: { authorization: `Basic ${Buffer.from(`${eng.getUsername()}:${eng.getPassword()}`).toString("base64")}` },
	});

	let asks = 0;
	const pending = new Set<string>();
	const result = (await client.event.subscribe({ query: { directory: plain } })) as { stream: AsyncGenerator<unknown> };
	void (async () => {
		for await (const raw of result.stream) {
			const payload = (((raw as Record<string, unknown>).payload ?? raw) as Record<string, unknown>) ?? {};
			if (String(payload.type) === "permission.asked") {
				asks++;
				pending.add(String((payload.properties as Record<string, unknown>)?.id ?? ""));
			}
		}
	})();

	async function probe(workspace: string, label: string) {
		const dir = { directory: workspace };
		// The event stream is scoped to the directory it was subscribed with, so
		// each workspace needs its own subscription — otherwise approvals raised
		// for workspace B never reach us and look like "auto-approved".
		const stream = (await client.event.subscribe({ query: dir })) as { stream: AsyncGenerator<unknown> };
		void (async () => {
			for await (const raw of stream.stream) {
				const payload = (((raw as Record<string, unknown>).payload ?? raw) as Record<string, unknown>) ?? {};
				if (String(payload.type) === "permission.asked") {
					asks++;
					pending.add(String((payload.properties as Record<string, unknown>)?.id ?? ""));
				}
			}
		})();
		await Bun.sleep(200);
		const created = (await client.session.create({ query: dir, body: { title: label } })) as { data?: Record<string, unknown> };
		const sessionId = String(created.data?.id ?? "");
		const before = asks;
		pending.clear();
		void (client.session.prompt({
			path: { id: sessionId },
			query: dir,
			body: { model: { providerID: PROVIDER_ID, modelID: "mock-model" }, parts: [{ type: "text", text: "CMD:echo probe" }] },
		}) as Promise<unknown>);
		const deadline = Date.now() + 15_000;
		while (Date.now() < deadline) {
			const list = [...pending];
			if (list.length) {
				for (const id of list) {
					pending.delete(id);
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
		await Bun.sleep(2000);
		const asked = asks - before;
		console.log(`${label}: permission.asked = ${asked}`);
		try {
			const messages = (await client.session.messages({ path: { id: sessionId }, query: dir })) as {
				data?: Array<{ parts?: Array<Record<string, unknown>> }>;
			};
			const tools = (messages.data ?? []).flatMap((m) => (m.parts ?? []).filter((p) => p.type === "tool"));
			for (const tool of tools) {
				const state = (tool.state ?? {}) as Record<string, unknown>;
				console.log(
					`    tool=${tool.tool} status=${state.status} output=${String(state.output ?? "").slice(0, 60).replace(/\n/g, " ")} error=${String(state.error ?? "-").slice(0, 60)}`,
				);
			}
			if (!tools.length) console.log("    (no tool part reached the transcript)");
		} catch (error) {
			console.log(`    transcript unreadable: ${(error as Error).message.slice(0, 120)}`);
		}
		return asked;
	}

	async function effectiveConfig(workspace: string, label: string) {
		try {
			const res = await fetch(`${status.url}/config?directory=${encodeURIComponent(workspace)}`, {
				headers: { authorization: `Basic ${Buffer.from(`${eng.getUsername()}:${eng.getPassword()}`).toString("base64")}` },
			});
			const json = (await res.json()) as Record<string, unknown>;
			console.log(`effective ${label} permission: ${JSON.stringify(json.permission ?? null)}`);
			console.log(`effective ${label} agent build: ${JSON.stringify(((json.agent ?? {}) as Record<string, unknown>).build ?? null)}`);
		} catch (error) {
			console.log(`effective ${label}: could not read /config (${(error as Error).message})`);
		}
	}

	await effectiveConfig(plain, "plain ");
	const a = await probe(plain, "plain workspace ");
	await effectiveConfig(rigged, "rigged");
	const b = await probe(rigged, "rigged workspace");

	console.log(`\nRESULT: plain=${a} rigged=${b}`);
	console.log(b === 0 ? ">>> project opencode.json OVERRIDES the app's permission settings" : ">>> project config cannot relax permissions");

	mock.stop();
	await eng.stop(true);
	process.exit(0);
}

main().catch((error) => {
	console.error("config source probe failed:", error);
	process.exit(1);
});
