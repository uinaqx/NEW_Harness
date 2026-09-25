/**
 * Control experiment for `OPENCODE_DISABLE_PROJECT_CONFIG`.
 *
 * Spawns the pinned engine directly (no Harness code beyond the config builder)
 * so exactly one variable differs between runs:
 *
 *   bun testing/probe-manual-spawn.ts          # flag unset
 *   bun testing/probe-manual-spawn.ts 1        # OPENCODE_DISABLE_PROJECT_CONFIG=1
 *   bun testing/probe-manual-spawn.ts true     # OPENCODE_DISABLE_PROJECT_CONFIG=true
 *
 * The rigged workspace carries an `opencode.json` granting `bash: allow`.
 * If the flag is honoured, the engine must still ask.
 */
import type { Subprocess } from "bun";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockProvider } from "./mock-provider";

const ROOT = join(import.meta.dir, "..");
const { createOpencodeClient } = await import(join(ROOT, "vendor/opencode/sdk/dist/client.js"));
const { buildOpenCodeConfig, PROVIDER_ID } = await import(join(ROOT, "backend/src/engine/provider.ts"));

const FLAG = process.argv[2];
const OPENCODE_BIN = join(ROOT, "vendor/opencode/bin/opencode.exe");

async function main() {
	const root = await mkdtemp(join(tmpdir(), "harness-manual-spawn-"));
	const workspace = join(root, "ws");
	await Bun.write(join(workspace, "README.md"), "# manual\n");
	await Bun.write(
		join(workspace, "opencode.json"),
		JSON.stringify({ $schema: "https://opencode.ai/config.json", permission: { bash: "allow", edit: "allow" } }, null, 2),
	);

	const mock = startMockProvider({});
	const config = buildOpenCodeConfig({
		settings: {
			version: 1,
			protocol: "openai-compatible",
			baseUrl: `${mock.url}/v1`,
			model: "mock-model",
			lastWorkspace: "",
			autoApproveEdits: false,
			autoApproveCommands: false,
			theme: "dark",
		},
		apiKey: "sk-manual-spawn",
	});

	const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("probe") });
	const port = probe.port;
	probe.stop(true);

	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") env[k] = v;
	env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
	env.OPENCODE_SERVER_PASSWORD = "pw";
	if (FLAG !== undefined) env.OPENCODE_DISABLE_PROJECT_CONFIG = FLAG;

	console.log(`flag=${FLAG === undefined ? "(unset)" : FLAG}`);

	const child: Subprocess<"ignore", "pipe", "pipe"> = Bun.spawn({
		cmd: [OPENCODE_BIN, "serve", "--hostname=127.0.0.1", `--port=${port}`, "--log-level=INFO"],
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});
	let url: string | null = null;
	const deadline = Date.now() + 60_000;
	const healthUrl = `http://127.0.0.1:${port}/path`;
	while (Date.now() < deadline && !url) {
		const res = await fetch(healthUrl, { headers: { authorization: `Basic ${Buffer.from("opencode:pw").toString("base64")}` } }).catch(() => null);
		if (res?.ok) url = `http://127.0.0.1:${port}`;
		else await Bun.sleep(300);
	}
	if (!url) {
		const out = await new Response(child.stdout as unknown as ReadableStream).text().catch(() => "");
		throw new Error(`engine did not come up.\nstdout:\n${out.slice(-3000)}`);
	}
	console.log(`engine up on ${url}`);

	const client = createOpencodeClient({
		baseUrl: url,
		headers: { authorization: `Basic ${Buffer.from("opencode:pw").toString("base64")}` },
	});

	let asks = 0;
	const pending = new Set<string>();
	const result = (await client.event.subscribe({ query: { directory: workspace } })) as { stream: AsyncGenerator<unknown> };
	void (async () => {
		for await (const raw of result.stream) {
			const payload = (((raw as Record<string, unknown>).payload ?? raw) as Record<string, unknown>) ?? {};
			if (String(payload.type) === "permission.asked") {
				asks++;
				pending.add(String((payload.properties as Record<string, unknown>)?.id ?? ""));
			}
		}
	})();

	const created = (await client.session.create({ query: { directory: workspace }, body: { title: "spawn probe" } })) as { data?: Record<string, unknown> };
	const sessionId = String(created.data?.id ?? "");
	void (client.session.prompt({
		path: { id: sessionId },
		query: { directory: workspace },
		body: { model: { providerID: PROVIDER_ID, modelID: "mock-model" }, parts: [{ type: "text", text: "CMD:echo spawn" }] },
	}) as Promise<unknown>);
	const waitUntil = Date.now() + 15_000;
	while (Date.now() < waitUntil) {
		const list = [...pending];
		if (list.length) {
			for (const id of list) {
				pending.delete(id);
				await client.postSessionIdPermissionsPermissionId({
					path: { id: sessionId, permissionID: id },
					query: { directory: workspace },
					body: { response: "once" },
				});
			}
			break;
		}
		await Bun.sleep(80);
	}
	await Bun.sleep(2500);
	console.log(`permission.asked = ${asks}  ->  ${asks > 0 ? "flag HONOURED (still asks)" : "local config STILL overrides"}`);

	mock.stop();
	child.kill();
	process.exit(0);
}

main().catch((error) => {
	console.error("manual spawn probe failed:", error);
	process.exit(1);
});
