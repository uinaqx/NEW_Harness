/** Why does the harness provider id / config not register with the engine? */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockProvider } from "./mock-provider";

const BIN = join(import.meta.dir, "..", "vendor", "opencode", "bin", "opencode.exe");
const mock = startMockProvider({ port: 0 });

function buildConfig(providerId: string, useInlineConfigToo: boolean) {
	return {
		$schema: "https://opencode.ai/config.json",
		model: `${providerId}/mock-model`,
		small_model: `${providerId}/mock-model`,
		autoupdate: false,
		share: "disabled",
		provider: {
			[providerId]: {
				npm: "@ai-sdk/openai-compatible",
				name: "Harness (OpenAI Chat Completions)",
				options: { baseURL: `${mock.url}/v1`, apiKey: "mock-key" },
				models: {
					"mock-model": { id: "mock-model", name: "mock-model", tool_call: true, reasoning: false, limit: { context: 200000, output: 32000 } },
				},
			},
		},
		permission: { edit: "ask", bash: "ask", external_directory: "ask", webfetch: "deny", doom_loop: "ask" },
		...(useInlineConfigToo ? {} : {}),
	};
}

async function probe(label: string, providerId: string, opts: { writeFileToo: boolean; inlineToo: boolean }, port: number) {
	const root = await mkdtemp(join(tmpdir(), "harness-prov-"));
	const workspace = join(root, "project");
	await mkdir(workspace, { recursive: true });
	await mkdir(join(root, "cfg", "opencode"), { recursive: true });
	const cfg = buildConfig(providerId, opts.inlineToo);
	const cfgPath = join(root, "cfg", "opencode", "opencode.json");
	const env: Record<string, string> = {
		...process.env as Record<string, string>,
		XDG_STATE_HOME: join(root, "state"),
		XDG_CONFIG_HOME: join(root, "cfg"),
		XDG_CACHE_HOME: join(root, "cache"),
		XDG_DATA_HOME: join(root, "data"),
		OPENCODE_SERVER_PASSWORD: "pw",
	};
	if (opts.writeFileToo) {
		await writeFile(cfgPath, JSON.stringify(cfg), "utf8");
		env.OPENCODE_CONFIG = cfgPath;
	}
	if (opts.inlineToo) env.OPENCODE_CONFIG_CONTENT = JSON.stringify(cfg);

	const proc = spawn(BIN, ["serve", "--hostname=127.0.0.1", `--port=${port}`], {
		cwd: workspace,
		env,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	proc.stdout.on("data", () => {});
	proc.stderr.on("data", () => {});
	const base = `http://127.0.0.1:${port}`;
	const auth = { authorization: `Basic ${Buffer.from("opencode:pw").toString("base64")}` };
	for (let i = 0; i < 150; i++) {
		try {
			if ((await fetch(`${base}/path`, { headers: auth })).ok) break;
		} catch {}
		await Bun.sleep(200);
	}
	const providers = (await fetch(`${base}/config/providers`, { headers: auth }).then((r) => r.json())) as {
		providers?: Array<{ id: string }>;
	};
	const ids = (providers.providers ?? []).map((p) => p.id);
	console.log(`${label}: providers=[${ids.join(", ")}] hasTarget=${ids.includes(providerId)}`);
	proc.kill();
	await Bun.sleep(400);
}

await probe("1. inline only, id=harness", "harness", { writeFileToo: false, inlineToo: true }, 45995);
await probe("2. inline only, id=harnessmock", "harnessmock", { writeFileToo: false, inlineToo: true }, 45996);
await probe("3. file only,  id=harness", "harness", { writeFileToo: true, inlineToo: false }, 45997);
await probe("4. both,       id=harness", "harness", { writeFileToo: true, inlineToo: true }, 45998);
mock.stop();
await Bun.sleep(200);
process.exit(0);
