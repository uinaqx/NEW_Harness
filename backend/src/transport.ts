/**
 * Harness backend — transport layer.
 *
 * Keeps the command/response/event protocol the webview already speaks
 * (`chat_event`, `chat_session_status`, `tool_approval_state` and the same
 * chunk stream names) so the UI did not have to be rewritten, and adds the
 * engine-lifecycle and settings commands the new architecture needs.
 */
import type { ServerWebSocket } from "bun";
import type {
	AgentChunkEvent,
	ChatSessionConfig,
	ChatSessionStatus,
	DesktopTransportEvent,
	DesktopTransportMessage,
	DesktopTransportRequest,
	DesktopTransportResponse,
	ProcessContext,
	ToolApprovalRequestItem,
} from "../../shared/types";
import { APP_VERSION, IS_DEV, paths } from "./config";
import { loadSettings, maskSettings, saveSettings, defaultSettings, newProfileId, normalizeModels, type AppSettings, type ApiProfile } from "./app-settings";
import { loadCredential, isOsProtected, maskSecret } from "./secrets";
import { clearProfileKey, loadProfileKey, loadProfileKeys, saveProfileKey } from "./profile-credentials";
import { HarnessEngine, type FileDiffEntry } from "./engine";
import { ENGINE_SDK_VERSION, ENGINE_UPSTREAM, ENGINE_VERSION } from "./engine/pin";
import { classifyEngineError, UserFacingError } from "./engine/errors";
import {
	getSession,
	listProjects,
	listSessions,
	patchSession,
	projectIdFor,
	renameProject,
	removeSession,
	upsertProject,
	upsertSession,
} from "./sessions";
import { currentHandshake } from "./runtime";
import { homedir } from "node:os";
import { mkdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BUILTIN_SKILLS } from "../../shared/skills";

async function nativePicker(kind: "folder" | "files"): Promise<string[]> {
	if (process.platform !== "win32") throw new UserFacingError("当前平台请手动填写绝对路径。");
	const script = kind === "folder"
		? 'Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description="选择项目文件夹"; if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){[Console]::Out.WriteLine($d.SelectedPath)}'
		: 'Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.OpenFileDialog; $d.Multiselect=$true; $d.Title="选择要附加的文件"; if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){$d.FileNames | ConvertTo-Json -Compress | Write-Output}';
	const child = Bun.spawn({ cmd: ["powershell.exe", "-NoProfile", "-STA", "-Command", script], stdout: "pipe", stderr: "pipe", windowsHide: true });
	const timer = setTimeout(() => child.kill(), 120_000);
	try {
		const output = await new Response(child.stdout).text();
		const exit = await child.exited;
		if (exit !== 0) throw new UserFacingError("系统文件选择器未能打开，请手动输入路径。");
		const value = output.trim();
		if (!value) return [];
		if (kind === "folder") return [value];
		const parsed = JSON.parse(value) as string | string[];
		return Array.isArray(parsed) ? parsed : [parsed];
	} finally {
		clearTimeout(timer);
	}
}

type Client = ServerWebSocket<unknown>;
const clients = new Set<Client>();

/** Per-session chunk counters so the client can detect a backend restart. */
const boots = new Map<string, string>();

let engineRef: HarnessEngine | null = null;

export function registerClient(ws: Client): void {
	clients.add(ws);
}
export function unregisterClient(ws: Client): void {
	clients.delete(ws);
}

export function clientCount(): number {
	return clients.size;
}

export function broadcastEvent(name: string, payload: unknown): void {
	const msg: DesktopTransportEvent = { type: "event", event: { name, payload } };
	const data = JSON.stringify(msg);
	for (const client of clients) {
		try {
			client.send(data);
		} catch {}
	}
}

export function bindEngine(engine: HarnessEngine): void {
	engineRef = engine;
	engine.bindSinks({
		chunk: (sessionId, stream, chunk, index) => {
			if (stream === "chat_session_title") {
				try {
					const title = String((JSON.parse(chunk) as { title?: string }).title ?? "").trim();
					if (title) void patchSession(sessionId, { title });
				} catch {}
			}
			if (!boots.has(sessionId)) boots.set(sessionId, `${Date.now().toString(36)}`);
			const payload: AgentChunkEvent = {
				sessionId,
				stream,
				chunk,
				ts: Date.now(),
				index,
				boot: boots.get(sessionId),
			};
			broadcastEvent("chat_event", payload);
		},
		status: (sessionId, status) => {
			void patchSession(sessionId, { lastStatus: status, updatedAt: Date.now() });
			broadcastEvent("chat_session_status", { sessionId, status });
		},
		approvals: (sessionId, approvals) => {
			broadcastEvent("tool_approval_state", { sessionId, approvals });
		},
		engine: (status) => {
			broadcastEvent("engine_state", status);
		},
	});
}

function engine(): HarnessEngine {
	if (!engineRef) throw new Error("引擎适配层尚未就绪");
	return engineRef;
}

function respond(req: DesktopTransportRequest, ok: boolean, result?: unknown, error?: string): DesktopTransportResponse {
	return { type: "response", id: req.id, ok, result, error };
}

function fail(req: DesktopTransportRequest, error: unknown): DesktopTransportResponse {
	// Errors raised by our own guards already read like product messages and must
	// not be re-classified into a generic "engine call failed".
	if (error instanceof UserFacingError) return respond(req, false, undefined, error.message);
	const failure = classifyEngineError(error);
	const detail = failure.detail ? `${failure.message}（${failure.detail}）` : failure.message;
	return respond(req, false, undefined, detail);
}

async function currentApiKey(): Promise<string> {
	return loadCredential(paths.credentials()) ?? "";
}

async function settingsWithKey(): Promise<{ settings: AppSettings; apiKey: string; profileKeys: Record<string, string> }> {
	const settings = await loadSettings();
	const profileKeys = loadProfileKeys(settings);
	return { settings, apiKey: profileKeys.default ?? await currentApiKey(), profileKeys };
}

async function settingsSnapshot() {
	const { settings, apiKey, profileKeys } = await settingsWithKey();
	return maskSettings(settings, !!apiKey, maskSecret(apiKey), profileKeys);
}

/** Ensure the engine is up, starting it lazily if needed. */
async function ensureEngine(): Promise<HarnessEngine> {
	const instance = engine();
	if (instance.status().state !== "running") {
		const { settings, apiKey, profileKeys } = await settingsWithKey();
		instance.updateCredentials(settings, apiKey, profileKeys);
		await instance.ensureStarted();
	}
	return instance;
}

export async function dispatchCommand(req: DesktopTransportRequest): Promise<DesktopTransportResponse> {
	const { command, args = {} } = req;
	try {
		switch (command) {
			case "ping":
				return respond(req, true, { pong: true, version: APP_VERSION });

			/* ---------------- app / engine identity ---------------- */

			case "get_app_info": {
				const handshake = currentHandshake();
				return respond(req, true, {
					appVersion: APP_VERSION,
					engineVersion: ENGINE_VERSION,
					engineUpstream: ENGINE_UPSTREAM,
					engineSdk: ENGINE_SDK_VERSION,
					dataDir: paths.root(),
					port: handshake?.port ?? null,
					instanceId: handshake?.instanceId ?? null,
					credentialsOsProtected: isOsProtected(),
					dev: IS_DEV,
				});
			}
			case "engine_status": {
				const status = engine().status();
				const handshake = currentHandshake();
				return respond(req, true, {
					...status,
					token: undefined,
					appPort: handshake?.port ?? null,
					appInstanceId: handshake?.instanceId ?? null,
				});
			}
			case "engine_start": {
				const { settings, apiKey, profileKeys } = await settingsWithKey();
				const instance = engine();
				instance.updateCredentials(settings, apiKey, profileKeys);
				const status = await instance.start(!!args.force);
				return respond(req, true, { status });
			}
			case "engine_restart": {
				const { settings, apiKey, profileKeys } = await settingsWithKey();
				const instance = engine();
				instance.updateCredentials(settings, apiKey, profileKeys);
				const status = await instance.restart(!!args.force);
				return respond(req, true, { status });
			}
			case "engine_diagnostics": {
				return respond(req, true, { text: engine().diagnosticsText() });
			}
			case "engine_stop": {
				await engine().stop(true);
				return respond(req, true, { stopped: true });
			}

			/* ---------------- model settings / credentials ---------------- */

			case "get_model_settings": {
				return respond(req, true, {
					settings: await settingsSnapshot(),
					osProtected: isOsProtected(),
				});
			}
			case "save_model_settings": {
				const patch: Partial<AppSettings> = {};
				if (typeof args.protocol === "string") patch.protocol = args.protocol as AppSettings["protocol"];
				if (typeof args.baseUrl === "string") patch.baseUrl = args.baseUrl;
				if (typeof args.model === "string") patch.model = args.model;
				if (typeof args.lastWorkspace === "string") patch.lastWorkspace = args.lastWorkspace;
				if (typeof args.autoApproveEdits === "boolean") patch.autoApproveEdits = args.autoApproveEdits;
				if (typeof args.autoApproveCommands === "boolean") patch.autoApproveCommands = args.autoApproveCommands;
				if (typeof args.theme === "string") patch.theme = args.theme === "light" ? "light" : "dark";
				const saved = await saveSettings(patch);
				if (typeof args.apiKey === "string" && args.apiKey) {
					saveProfileKey(saved.defaultProfileId, args.apiKey);
				}
				const profileKeys = loadProfileKeys(saved);
				const key = profileKeys.default ?? "";
				const instance = engine();
				instance.updateCredentials(saved, key, profileKeys);
				// Provider/permission changes are picked up by the engine on the next
				// turn (the prompt carries the model), so no restart is needed and a
				// running task is not interrupted.
				return respond(req, true, {
					settings: await settingsSnapshot(),
					note: "配置已保存：协议与模型在下一轮对话生效，不会打断当前任务。",
				});
			}
			case "clear_model_credentials": {
				const settings = await loadSettings();
				clearProfileKey(settings.defaultProfileId);
				const instance = engine();
				instance.updateCredentials(settings, loadProfileKey("default"), loadProfileKeys(settings));
				return respond(req, true, { cleared: true });
			}
			case "test_model_connection": {
				const settings = await loadSettings();
				const isNewProfile = args.profileId === "";
				const profileId = typeof args.profileId === "string" && settings.profiles.some((item) => item.id === args.profileId) ? args.profileId : settings.defaultProfileId;
				const selected = settings.profiles.find((item) => item.id === profileId)!;
				const stored = isNewProfile ? "" : loadProfileKey(profileId);
				const probe: AppSettings = {
					...settings,
					protocol: (typeof args.protocol === "string" ? args.protocol : selected.protocol) as AppSettings["protocol"],
					baseUrl: typeof args.baseUrl === "string" ? args.baseUrl : selected.baseUrl,
					model: typeof args.model === "string" ? args.model : selected.models[0],
				};
				const apiKey = typeof args.apiKey === "string" && args.apiKey ? args.apiKey : stored;
				const result = await engine().testConnection(probe, apiKey);
				return respond(req, true, result);
			}
			case "save_model_profile": {
				const settings = await loadSettings();
				const id = typeof args.profileId === "string" && settings.profiles.some((item) => item.id === args.profileId) ? args.profileId : newProfileId();
				const name = String(args.name || "").trim().slice(0, 80);
				const protocol = args.protocol === "anthropic" ? "anthropic" : "openai-compatible";
				const baseUrl = String(args.baseUrl || "").trim();
				const models = normalizeModels(args.models);
				if (!name || !baseUrl || !models.length) return respond(req, false, undefined, "请填写 API 名称、Base URL 和至少一个模型 ID。");
				if (!/^https?:\/\//i.test(baseUrl)) return respond(req, false, undefined, "Base URL 必须以 http:// 或 https:// 开头。");
				const profile: ApiProfile = { id, name, protocol, baseUrl, models };
				const profiles = settings.profiles.some((item) => item.id === id)
					? settings.profiles.map((item) => item.id === id ? profile : item)
					: [...settings.profiles, profile];
				const saved = await saveSettings({ profiles });
				if (typeof args.apiKey === "string" && args.apiKey.trim()) saveProfileKey(id, args.apiKey.trim());
				const keys = loadProfileKeys(saved);
				engine().updateCredentials(saved, keys.default ?? "", keys);
				return respond(req, true, { profileId: id, settings: await settingsSnapshot() });
			}
			case "delete_model_profile": {
				const settings = await loadSettings();
				const id = String(args.profileId || "");
				if (!settings.profiles.some((item) => item.id === id)) return respond(req, false, undefined, "API 配置不存在。");
				if (settings.profiles.length === 1) return respond(req, false, undefined, "请至少保留一个 API 配置。");
				if ((await listSessions()).some((item) => item.profileId === id)) return respond(req, false, undefined, "仍有对话使用此 API，请先切换这些对话的模型或删除对话。");
				const profiles = settings.profiles.filter((item) => item.id !== id);
				const saved = await saveSettings({ profiles, defaultProfileId: id === settings.defaultProfileId ? profiles[0].id : settings.defaultProfileId });
				clearProfileKey(id);
				const keys = loadProfileKeys(saved);
				engine().updateCredentials(saved, keys.default ?? "", keys);
				return respond(req, true, { settings: await settingsSnapshot() });
			}

			/* ---------------- workspace ---------------- */

			case "get_process_context": {
				const workspaceRoot = String(args.workspaceRoot || process.cwd());
				const ctx: ProcessContext = {
					workspaceRoot,
					cwd: workspaceRoot,
					homeDir: homedir(),
					platform: process.platform,
					appVersion: APP_VERSION,
				};
				return respond(req, true, ctx);
			}
			case "validate_workspace_directory": {
				const path = String(args.path || "");
				if (!path) return respond(req, true, { valid: false, error: "路径为空" });
				try {
					const info = await stat(resolve(path));
					const valid = info.isDirectory();
					return respond(req, true, {
						valid,
						isDirectory: valid,
						resolved: resolve(path),
						error: valid ? undefined : "该路径不是目录",
					});
				} catch (error) {
					return respond(req, true, { valid: false, error: error instanceof Error ? error.message : String(error) });
				}
			}
			case "pick_workspace_directory":
				return respond(req, true, { paths: await nativePicker("folder") });
			case "pick_attachment_files":
				return respond(req, true, { paths: await nativePicker("files") });

			/* ---------------- sessions ---------------- */
			case "list_projects":
				return respond(req, true, { projects: await listProjects() });
			case "create_project": {
				const workspaceRoot = String(args.workspaceRoot || "").trim();
				if (!workspaceRoot) return respond(req, false, undefined, "请选择项目文件夹");
				const root = resolve(workspaceRoot);
				const info = await stat(root).catch(() => null);
				if (!info?.isDirectory()) return respond(req, false, undefined, `文件夹不可用：${workspaceRoot}`);
				return respond(req, true, { project: await upsertProject(root) });
			}
			case "rename_project": {
				const name = String(args.name || "").trim();
				if (!name || name.length > 100) return respond(req, false, undefined, "项目名称需为 1–100 个字符");
				const project = await renameProject(String(args.projectId || ""), name);
				return project ? respond(req, true, { project }) : respond(req, false, undefined, "项目不存在");
			}

			case "list_sessions": {
				const entries = await listSessions();
				return respond(req, true, {
					sessions: entries.map((entry) => ({
						id: entry.id,
						kind: entry.kind ?? "work",
						profileId: entry.profileId,
						createdAt: entry.createdAt,
						updatedAt: entry.updatedAt,
						status: entry.lastStatus,
						workspaceRoot: entry.workspaceRoot,
						model: entry.model,
						title: entry.customTitle || entry.title,
						customTitle: entry.customTitle,
						pinned: !!entry.pinned,
						legacy: !!entry.legacy,
						summary: { toolCalls: 0, tokensIn: 0, tokensOut: 0 },
						lastMessage: entry.lastMessage,
					})),
				});
			}
			case "rename_session": {
				const id = String(args.sessionId || "");
				const title = String(args.title || "").trim();
				if (!title || title.length > 120) return respond(req, false, undefined, "会话名称需为 1–120 个字符");
				const entry = await patchSession(id, { customTitle: title });
				return entry ? respond(req, true, { id, title }) : respond(req, false, undefined, "会话不存在");
			}
			case "pin_session": {
				const id = String(args.sessionId || "");
				const entry = await patchSession(id, { pinned: !!args.pinned });
				return entry ? respond(req, true, { id, pinned: !!entry.pinned }) : respond(req, false, undefined, "会话不存在");
			}
			case "create_session": {
				const kind = args.kind === "chat" ? "chat" as const : "work" as const;
				const settings = await loadSettings();
				const profileId = typeof args.profileId === "string" && settings.profiles.some((item) => item.id === args.profileId) ? args.profileId : settings.defaultProfileId;
				const profile = settings.profiles.find((item) => item.id === profileId)!;
				if (!loadProfileKey(profileId)) return respond(req, false, undefined, `请先为“${profile.name}”配置 API Key。`);
				const selectedModel = typeof args.model === "string" && args.model.trim() ? args.model.trim() : profile.models[0];
				if (!profile.models.includes(selectedModel)) await saveSettings({ profiles: settings.profiles.map((item) => item.id === profileId ? { ...item, models: [...item.models, selectedModel] } : item) });
				const workspaceRoot = kind === "chat" ? paths.chatWorkspace() : String(args.workspaceRoot || "");
				if (kind === "work") {
					if (!workspaceRoot) return respond(req, false, undefined, "请先选择工作区目录");
					const info = await stat(resolve(workspaceRoot)).catch(() => null);
					if (!info?.isDirectory()) return respond(req, false, undefined, `工作区不可用：${workspaceRoot}`);
				} else await mkdir(workspaceRoot, { recursive: true });
				const instances = await ensureEngine();
				const created = await instances.createSession(resolve(workspaceRoot), typeof args.title === "string" ? args.title : kind === "chat" ? "新聊天" : undefined);
				if (kind === "work") await upsertProject(resolve(workspaceRoot));
				const entry = {
					id: created.id,
					kind,
					profileId,
					workspaceRoot: resolve(workspaceRoot),
					title: created.title,
					createdAt: created.createdAt,
					updatedAt: created.updatedAt,
					lastStatus: "idle",
					model: selectedModel,
					mode: kind === "work" && args.mode === "plan" ? "plan" as const : "act" as const,
					goal: kind === "work" && typeof args.goal === "string" ? args.goal.trim().slice(0, 2000) : "",
				};
				await upsertSession(entry);
				if (kind === "work") void saveSettings({ lastWorkspace: resolve(workspaceRoot) });
				return respond(req, true, {
					session: {
						id: entry.id,
						createdAt: entry.createdAt,
						updatedAt: entry.updatedAt,
						status: "idle" as ChatSessionStatus,
						config: sessionConfigFor(entry, entry.model),
						messages: [],
						summary: { toolCalls: 0, tokensIn: 0, tokensOut: 0 },
					},
				});
			}
			case "get_session": {
				const id = String(args.sessionId || "");
				const entry = await getSession(id);
				if (!entry) return respond(req, false, undefined, "会话不存在");
				const instance = engine();
				let status: ChatSessionStatus = (entry.lastStatus as ChatSessionStatus) ?? "idle";
				if (instance.status().state === "running" && !entry.legacy) {
					try {
						const live = await instance.getEngineSession(entry.workspaceRoot, id);
						if (live) status = live.status;
					} catch {
						/* keep the indexed status */
					}
				}
				return respond(req, true, {
					session: {
						id: entry.id,
						createdAt: entry.createdAt,
						updatedAt: entry.updatedAt,
						status,
						legacy: !!entry.legacy,
						config: sessionConfigFor(entry, entry.model),
						messages: [],
						summary: { toolCalls: 0, tokensIn: 0, tokensOut: 0 },
					},
				});
			}
			case "delete_session": {
				const id = String(args.sessionId || "");
				const entry = await getSession(id);
				if (!entry) return respond(req, true, { removed: false, sessionId: id });
				if (entry.legacy) {
					await removeSession(id);
					return respond(req, true, { removed: true, sessionId: id, note: "只读历史记录已从列表移除。" });
				}
				const instance = engine();
				if (instance.isBusy(id)) {
					return respond(req, false, undefined, "该会话正在执行任务，请先停止再删除。");
				}
				if (instance.status().state === "running") {
					await instance.deleteSession(entry.workspaceRoot, id);
				}
				await removeSession(id);
				return respond(req, true, { removed: true, sessionId: id });
			}
			case "read_session_messages": {
				const id = String(args.sessionId || "");
				const max = Number(args.maxMessages) || 500;
				const entry = await getSession(id);
				if (!entry) return respond(req, false, undefined, "会话不存在");
				if (entry.legacy) {
					return respond(req, true, { sessionId: id, messages: await readLegacyTranscript(entry.legacyFile) });
				}
				const instances = await ensureEngine();
				const messages = await instances.readMessages(entry.workspaceRoot, id, max);
				return respond(req, true, { sessionId: id, messages: entry.kind === "chat" ? messages.filter((item) => item.role === "user" || item.role === "assistant") : messages });
			}
			case "update_session_config": {
				const id = String(args.sessionId || "");
				const entry = await getSession(id);
				if (!entry) return respond(req, false, undefined, "会话不存在");
				const patch = (args.config || {}) as Partial<ChatSessionConfig>;
				if (entry.kind === "chat" && (patch.mode === "plan" || args.goal)) return respond(req, false, undefined, "Chat 模式仅支持对话。");
				const settings = await loadSettings();
				const profileId = typeof patch.profileId === "string" ? patch.profileId : entry.profileId ?? settings.defaultProfileId;
				const profile = settings.profiles.find((item) => item.id === profileId);
				if (!profile) return respond(req, false, undefined, "所选 API 配置不存在。");
				if (typeof patch.model === "string" && patch.model.trim()) {
					const model = patch.model.trim();
					if (!profile.models.includes(model)) await saveSettings({ profiles: settings.profiles.map((item) => item.id === profileId ? { ...item, models: [...item.models, model] } : item) });
					await patchSession(id, { model, profileId, updatedAt: Date.now() });
				} else if (profileId !== entry.profileId) await patchSession(id, { profileId, model: profile.models[0], updatedAt: Date.now() });
				if (entry.kind !== "chat") {
					if (patch.mode === "plan" || patch.mode === "act") await patchSession(id, { mode: patch.mode });
					if (typeof args.goal === "string") await patchSession(id, { goal: args.goal.trim().slice(0, 2000) });
				}
				if (typeof patch.workspaceRoot === "string" && patch.workspaceRoot) {
					return respond(req, false, undefined, "工作区不可在既有会话上更改，请新建会话。");
				}
				const updated = await getSession(id);
				return respond(req, true, { session: { id, config: sessionConfigFor(updated!, updated?.model ?? "") } });
			}
			case "read_session_nodes": {
				const id = String(args.sessionId || "");
				const entry = await getSession(id);
				if (!entry) return respond(req, false, undefined, "会话不存在");
				if (entry.legacy || entry.kind === "chat") return respond(req, true, { sessionId: id, nodes: [] });
				const live = engine().nodes(id);
				if (live && live.length) return respond(req, true, { sessionId: id, nodes: live });
				const instances = await ensureEngine();
				const nodes = await instances.readToolNodes(entry.workspaceRoot, id);
				return respond(req, true, { sessionId: id, nodes });
			}
			case "list_session_diffs": {
				const id = String(args.sessionId || "");
				const entry = await getSession(id);
				if (!entry) return respond(req, false, undefined, "会话不存在");
				if (entry.legacy || entry.kind === "chat") return respond(req, true, { sessionId: id, diffs: [], note: "此对话没有文件差异。" });
				const instances = await ensureEngine();
				const diffs: FileDiffEntry[] = await instances.readDiffs(
					entry.workspaceRoot,
					id,
					typeof args.messageId === "string" ? args.messageId : undefined,
				);
				return respond(req, true, { sessionId: id, diffs });
			}

			/* ---------------- approvals ---------------- */

			case "poll_tool_approvals": {
				const id = String(args.sessionId || "");
				const entry = await getSession(id);
				return respond(req, true, { sessionId: id, approvals: entry?.kind === "chat" ? [] : engine().pendingApprovals(id) as ToolApprovalRequestItem[] });
			}
			case "resolve_tool_approval": {
				const sessionId = String(args.sessionId || "");
				if ((await getSession(sessionId))?.kind === "chat") return respond(req, false, undefined, "Chat 模式不允许工具授权。");
				const requestId = String(args.requestId || "");
				const decision = args.decision === "reject" ? "reject" : "allow";
				if (!sessionId || !requestId) return respond(req, false, undefined, "缺少会话或授权请求 ID");
				await engine().replyPermission(sessionId, requestId, decision);
				return respond(req, true, { resolved: true, decision });
			}

			/* ---------------- running a turn ---------------- */

			case "chat_session_command": {
				const action = String(args.action || "");
				const sessionId = String(args.sessionId || "");
				if (!sessionId) return respond(req, false, undefined, "缺少会话 ID");
				const entry = await getSession(sessionId);
				if (!entry) return respond(req, false, undefined, "会话不存在");
				if (entry.legacy) return respond(req, false, undefined, "旧会话是只读历史，不能继续运行。");

				if (action === "stop") {
					const result = await engine().stopTask(sessionId);
					return respond(req, true, result);
				}
				if (action === "send") {
					const prompt = String(args.prompt || "");
					if (!prompt.trim()) return respond(req, false, undefined, "请输入内容");
					if (entry.kind === "chat" && (args.skillId || (Array.isArray(args.attachments) && args.attachments.length))) {
						return respond(req, false, undefined, "Chat 模式仅支持文字对话，不能使用本地文件或技能工具。");
					}
					const skillId = typeof args.skillId === "string" && BUILTIN_SKILLS.some((item) => item.id === args.skillId) ? args.skillId : undefined;
					const attachments: string[] = [];
					if (Array.isArray(args.attachments)) {
						for (const path of args.attachments.slice(0, 8)) {
							if (typeof path !== "string" || !path.trim()) continue;
							const file = resolve(path);
							if (await stat(file).then((value) => value.isFile() || value.isDirectory()).catch(() => false)) attachments.push(file);
						}
					}
					const { settings, apiKey, profileKeys } = await settingsWithKey();
					const profileId = entry.profileId ?? settings.defaultProfileId;
					const profile = settings.profiles.find((item) => item.id === profileId);
					if (!profile) return respond(req, false, undefined, "此对话选择的 API 配置已不存在，请重新选择模型。");
					if (!profileKeys[profileId]) return respond(req, false, undefined, `请先为“${profile.name}”配置 API Key。`);
					const instance = await ensureEngine();
					instance.updateCredentials(settings, apiKey, profileKeys);
					await instance.prompt(sessionId, entry.workspaceRoot, prompt, {
						kind: entry.kind ?? "work", profileId, model: entry.model || profile.models[0],
						mode: entry.mode, goal: entry.goal, skillId, attachments,
					});
					await patchSession(sessionId, {
						updatedAt: Date.now(),
						lastMessage: prompt.slice(0, 120),
						lastStatus: "starting",
						model: entry.model || settings.model,
					});
					return respond(req, true, { sessionId, queued: true });
				}
				return respond(req, false, undefined, `未知操作：${action}`);
			}

			default:
				return respond(req, false, undefined, `未知命令：${command}`);
		}
	} catch (error) {
		return fail(req, error);
	}
}

function sessionConfigFor(entry: { id: string; workspaceRoot: string; model: string; profileId?: string; kind?: "work" | "chat"; mode?: "act" | "plan"; goal?: string }, model: string): ChatSessionConfig {
	return {
		sessionId: entry.id,
		kind: entry.kind ?? "work",
		profileId: entry.profileId,
		workspaceRoot: entry.workspaceRoot,
		cwd: entry.workspaceRoot,
		provider: "opencode",
		model: model || entry.model,
		mode: entry.mode ?? "act",
		goal: entry.goal,
		// The key never travels to the frontend.
		apiKey: "",
		enableTools: entry.kind !== "chat",
	};
}

async function readLegacyTranscript(file: string | undefined) {
	if (!file) return [];
	try {
		const raw = await readFile(join(paths.legacySessions(), file), "utf8");
		const parsed = JSON.parse(raw) as { messages?: Array<Record<string, unknown>> };
		return (parsed.messages ?? []).map((message) => ({
			id: String(message.id ?? ""),
			sessionId: null,
			role: String(message.role ?? "assistant"),
			content: String(message.content ?? ""),
			createdAt: Number(message.createdAt ?? 0),
			meta: { messageKind: "legacy" },
		}));
	} catch {
		return [];
	}
}

export async function handleMessage(raw: string): Promise<DesktopTransportMessage | null> {
	let parsed: DesktopTransportRequest;
	try {
		parsed = JSON.parse(raw) as DesktopTransportRequest;
	} catch {
		return null;
	}
	if (parsed.type !== "command") return null;
	return await dispatchCommand(parsed);
}

export function defaultSettingsSnapshot() {
	return defaultSettings();
}

export function projectIdForPath(path: string): string {
	return projectIdFor(path);
}
