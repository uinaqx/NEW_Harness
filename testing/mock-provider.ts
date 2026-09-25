/**
 * Harness testing fixture — a local, OpenAI-compatible Chat Completions mock.
 *
 * Purpose: exercise the whole OpenCode call chain (streaming, tool calls,
 * permissions, cancellation, errors) without needing a real model credential.
 * NOTE: passing this fixture is NOT the same as passing with a real model.
 * Real-model acceptance is tracked separately in VALIDATION.md.
 *
 * The script is chosen from the latest user message so one conversation can be
 * driven prompt-by-prompt:
	 *   "写文件*"  -> tool call `write`   (mutating -> triggers a permission request)
	 *   "跑个命令*" -> tool call `bash`    (command  -> triggers a permission request)
	 *   "慢慢说*"  -> a slow text stream  (used to observe cancellation)
	 *   "命令甲*" / "命令乙*" -> two *different* bash calls with observable side
	 *                            effects, used to prove each command is authorised
	 *                            separately within one session
	 *   anything   -> a short final text answer
	 */
import type { Server } from "bun";

export interface MockProviderOptions {
	port?: number;
	hostname?: string;
	/** Turn index at which to emit a hard error instead of a scripted reply. */
	failAtTurn?: number;
	/** Emit a slow trickle of text chunks so cancellation can be observed. */
	slow?: boolean;
}

export interface MockProviderHandle {
	url: string;
	port: number;
	/** Every request body received, in order (for assertions). */
	requests: Array<Record<string, unknown>>;
	stop(): void;
}

interface ChatMessage {
	role: string;
	content?: unknown;
	tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
	tool_call_id?: string;
}

function sseChunk(payload: unknown): string {
	return `data: ${JSON.stringify(payload)}\n\n`;
}

function base(id: string, model: string) {
	return {
		id,
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1000),
		model,
	};
}

function delta(content: Record<string, unknown>, finish: string | null = null) {
	return { choices: [{ index: 0, delta: content, finish_reason: finish }] };
}

/**
 * A command whose result is observable on disk, not just stdout.
 *
 * Approval tests must be able to prove whether a command actually ran: `echo`
 * leaves nothing behind, so a rejection would be indistinguishable from an
 * approval whose output was missed. Writing a marker file makes "did it run?"
 * an unambiguous filesystem fact.
 */
export function shellWriteCommand(file: string, marker: string): string {
	if (process.platform === "win32") return `cmd /c echo ${marker}> ${file}`;
	return `printf '${marker}\\n' > ${file}`;
}

/** Split a string into small pieces so the client must reassemble them. */
function pieces(value: string, size = 7): string[] {
	const out: string[] = [];
	for (let i = 0; i < value.length; i += size) out.push(value.slice(i, i + size));
	return out.length ? out : [""];
}

export function startMockProvider(options: MockProviderOptions = {}): MockProviderHandle {
	const requests: Array<Record<string, unknown>> = [];
	const state = { stopped: false };

	const server: Server = Bun.serve({
		hostname: options.hostname ?? "127.0.0.1",
		port: options.port ?? 0,
		async fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === "/health") return Response.json({ ok: true });
			if (url.pathname.endsWith("/models")) {
				return Response.json({ object: "list", data: [{ id: "mock-model", object: "model" }] });
			}
			if (!url.pathname.endsWith("/chat/completions")) {
				return new Response("not found", { status: 404 });
			}
			const body = (await req.json()) as {
				model?: string;
				messages?: ChatMessage[];
				stream?: boolean;
				[key: string]: unknown;
			};
			requests.push(body as Record<string, unknown>);
			const model = body.model ?? "mock-model";
			const messages = body.messages ?? [];
			const turn = messages.filter((m) => m.role === "assistant").length;
			const id = `chatcmpl-${requests.length}`;

			// Script the reply from the most recent user message so a single
			// conversation is driven prompt-by-prompt, and use the number of
			// assistant turns since that message as the step inside the script.
			let lastUserIndex = -1;
			for (let i = messages.length - 1; i >= 0; i--) {
				if (messages[i].role === "user") {
					lastUserIndex = i;
					break;
				}
			}
			const lastUserText = String(messages[lastUserIndex]?.content ?? "");
			const step = messages.slice(lastUserIndex + 1).filter((m) => m.role === "assistant").length;

			if (options.failAtTurn !== undefined && turn === options.failAtTurn) {
				return Response.json(
					{ error: { message: "mock upstream failure", type: "invalid_request_error", code: "mock_failure" } },
					{ status: 400 },
				);
			}

			// Scripted replies.
			let toolName: string | null = null;
			let toolArgs = "";
			let finalText = "";
			if (step === 0 && lastUserText.includes("写文件")) {
				toolName = "write";
				toolArgs = JSON.stringify({ filePath: "PHASE1.txt", content: "hello from harness\n" });
			} else if (step === 0 && lastUserText.includes("跑个命令")) {
				toolName = "bash";
				toolArgs = JSON.stringify({ command: "echo mock-command-ran", description: "print a marker" });
		} else if (step === 0 && lastUserText.includes("命令甲")) {
			toolName = "bash";
			toolArgs = JSON.stringify({ command: shellWriteCommand("alpha.txt", "alpha"), description: "create alpha.txt" });
		} else if (step === 0 && lastUserText.includes("命令乙")) {
			toolName = "bash";
			toolArgs = JSON.stringify({ command: shellWriteCommand("beta.txt", "beta"), description: "create beta.txt" });
		} else if (step === 0 && lastUserText.startsWith("CMD:")) {
			// Escape hatch for permission probes: run an arbitrary command so we
			// can characterise which commands the engine authorises and which it
			// does not (e.g. `CMD:exit 7`).
			toolName = "bash";
			toolArgs = JSON.stringify({ command: lastUserText.slice(4), description: "probe command" });
		} else if (step === 0 && lastUserText.includes("命令丙")) {
			toolName = "bash";
			toolArgs = JSON.stringify({ command: shellWriteCommand("gamma.txt", "gamma"), description: "create gamma.txt" });
			} else if (step === 0 && lastUserText.includes("改文件")) {
				toolName = "edit";
				// Matches both "phase1 workspace" and "integration workspace" fixtures.
				toolArgs = JSON.stringify({ filePath: "README.md", oldString: "workspace", newString: "workspace (edited)" });
			} else if (step === 0 && lastUserText.includes("读文件")) {
				toolName = "read";
				toolArgs = JSON.stringify({ filePath: "README.md" });
			} else if (step === 0 && lastUserText.includes("失败命令")) {
				toolName = "bash";
				toolArgs = JSON.stringify({ command: "exit 7", description: "exit non-zero" });
			} else if (step === 0 && lastUserText.includes("慢慢说")) {
				finalText = "这是一段故意放慢的回复，用来验证取消行为能够真正打断进行中的回合。".repeat(6);
			} else {
				finalText = `已完成：本轮共 ${step + 1} 个助手回合。`;
			}
			const isSlow = options.slow || lastUserText.includes("慢慢说");

			if (!body.stream) {
				if (toolName) {
					return Response.json({
						id,
						object: "chat.completion",
						created: Math.floor(Date.now() / 1000),
						model,
						choices: [
							{
								index: 0,
								message: {
									role: "assistant",
									content: null,
									tool_calls: [{ id: `call_${turn}`, type: "function", function: { name: toolName, arguments: toolArgs } }],
								},
								finish_reason: "tool_calls",
							},
						],
						usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
					});
				}
				return Response.json({
					id,
					object: "chat.completion",
					created: Math.floor(Date.now() / 1000),
					model,
					choices: [{ index: 0, message: { role: "assistant", content: finalText }, finish_reason: "stop" }],
					usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
				});
			}

			const encoder = new TextEncoder();
			const chunks: string[] = [];
			chunks.push(sseChunk({ ...base(id, model), ...delta({ role: "assistant", content: "" }) }));

			if (toolName) {
				chunks.push(
					sseChunk({
						...base(id, model),
						...delta({ tool_calls: [{ index: 0, id: `call_${turn}`, type: "function", function: { name: toolName, arguments: "" } }] }),
					}),
				);
				for (const p of pieces(toolArgs)) {
					chunks.push(
						sseChunk({
							...base(id, model),
							...delta({ tool_calls: [{ index: 0, function: { arguments: p } }] }),
						}),
					);
				}
				chunks.push(sseChunk({ ...base(id, model), ...delta({}, "tool_calls") }));
			} else {
				for (const p of pieces(finalText, isSlow ? 2 : 9)) {
					chunks.push(sseChunk({ ...base(id, model), ...delta({ content: p }) }));
				}
				chunks.push(sseChunk({ ...base(id, model), ...delta({}, "stop") }));
			}
			chunks.push("data: [DONE]\n\n");

			const stream = new ReadableStream<Uint8Array>({
				async start(controller) {
					for (const c of chunks) {
						if (state.stopped) break;
						controller.enqueue(encoder.encode(c));
						if (isSlow) await Bun.sleep(120);
					}
					controller.close();
				},
			});
			return new Response(stream, {
				headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
			});
		},
	});

	const port = server.port;
	return {
		url: `http://127.0.0.1:${port}`,
		port,
		requests,
		stop() {
			state.stopped = true;
			server.stop(true);
		},
	};
}

if (import.meta.main) {
	const handle = startMockProvider({ port: Number(process.env.MOCK_PORT) || 4599 });
	console.log(`mock provider on ${handle.url}/v1`);
}
