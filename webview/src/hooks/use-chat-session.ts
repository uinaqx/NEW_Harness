/**
 * Harness webview — chat session hook.
 *
 * Owns the conversation state, folds live `chat_event` chunks into the
 * transcript (so the execution canvas renders real engine nodes), tracks the
 * engine lifecycle and exposes the settings/credential commands.
 *
 * The API key never reaches this layer: settings round-trip through the backend,
 * which returns `hasApiKey` + a mask only.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { desktopClient } from "@/lib/desktop-client";
import type { DesktopTransportState } from "@/lib/desktop-transport";
import type {
	AgentChunkEvent,
	AppInfoPayload,
	ChatMessage,
	ChatSessionConfig,
	ChatSessionStatus,
	ChatSummary,
	ConnectionTestResult,
	EngineStatusPayload,
	FileDiffEntryPayload,
	ModelSettingsPayload,
	ProviderProtocol,
	ProjectListItemPayload,
	SessionListItemPayload,
	ToolApprovalRequestItem,
	ToolNodePayload,
} from "@/lib/chat-schema";

const EMPTY_SUMMARY: ChatSummary = { toolCalls: 0, tokensIn: 0, tokensOut: 0 };

function makeId(prefix = "msg"): string {
	return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function parseJson<T>(text: string): T | undefined {
	try {
		return JSON.parse(text) as T;
	} catch {
		return undefined;
	}
}

export interface SettingsDraft {
	profileId: string;
	profileName: string;
	models: string;
	protocol: ProviderProtocol;
	baseUrl: string;
	model: string;
	workspaceRoot: string;
	apiKey: string;
	autoApproveEdits: boolean;
	autoApproveCommands: boolean;
	theme: "dark" | "light";
}

export function useChatSession() {
	const [sessionId, setSessionId] = useState<string | null>(null);
	const [status, setStatus] = useState<ChatSessionStatus>("idle");
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [config, setConfig] = useState<ChatSessionConfig | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [summary, setSummary] = useState<ChatSummary>(EMPTY_SUMMARY);
	const [approvals, setApprovals] = useState<ToolApprovalRequestItem[]>([]);
	const [transportState, setTransportState] = useState<DesktopTransportState>("connecting");
	const [sessions, setSessions] = useState<SessionListItemPayload[]>([]);
	const [projects, setProjects] = useState<ProjectListItemPayload[]>([]);
	const [streamingId, setStreamingId] = useState<string | null>(null);
	const [engine, setEngine] = useState<EngineStatusPayload | null>(null);
	const [appInfo, setAppInfo] = useState<AppInfoPayload | null>(null);
	const [settings, setSettings] = useState<ModelSettingsPayload | null>(null);
	const [diffs, setDiffs] = useState<FileDiffEntryPayload[]>([]);
	const [nodes, setNodes] = useState<ToolNodePayload[]>([]);
	const [busyCommand, setBusyCommand] = useState<string | null>(null);
	const [backendFailure, setBackendFailure] = useState<string | null>(null);
	const streamingIdRef = useRef<string | null>(null);
	const sessionRef = useRef<string | null>(null);
	const diffsStaleRef = useRef(true);
	streamingIdRef.current = streamingId;
	sessionRef.current = sessionId;

	/* ---------------- transport + engine state ---------------- */

	useEffect(
		() =>
			desktopClient.subscribeTransportState((state) => {
				setTransportState(state);
				// A failed endpoint resolution must not look like an endless "connecting".
				setBackendFailure(state === "unavailable" ? (desktopClient.getFailure()?.detail ?? "后端不可用") : null);
			}),
		[],
	);

	useEffect(() => {
		const offEngine = desktopClient.subscribe("engine_state", (payload) => {
			setEngine(payload as EngineStatusPayload);
		});
		return offEngine;
	}, []);

	const refreshEngine = useCallback(async () => {
		try {
			setEngine(await desktopClient.invoke<EngineStatusPayload>("engine_status"));
		} catch {
			/* the connection banner already reports transport problems */
		}
	}, []);

	const refreshAppInfo = useCallback(async () => {
		try {
			setAppInfo(await desktopClient.invoke<AppInfoPayload>("get_app_info"));
		} catch {}
	}, []);

	const refreshSettings = useCallback(async () => {
		try {
			const result = await desktopClient.invoke<{ settings: ModelSettingsPayload }>("get_model_settings");
			setSettings(result.settings);
		} catch {}
	}, []);

	const refreshSessions = useCallback(async () => {
		try {
			const [result, projectResult] = await Promise.all([
				desktopClient.invoke<{ sessions: SessionListItemPayload[] }>("list_sessions"),
				desktopClient.invoke<{ projects: ProjectListItemPayload[] }>("list_projects"),
			]);
			setSessions(result.sessions ?? []);
			setProjects(projectResult.projects ?? []);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, []);

	useEffect(() => {
		void (async () => {
			await refreshAppInfo();
			await refreshSettings();
			await refreshEngine();
			await refreshSessions();
		})();
	}, [refreshAppInfo, refreshSettings, refreshEngine, refreshSessions]);

	// Keep the engine panel honest even if no event arrives.
	useEffect(() => {
		const timer = setInterval(() => void refreshEngine(), 5000);
		return () => clearInterval(timer);
	}, [refreshEngine]);

	/* ---------------- live chunks ---------------- */

	const handleChunk = useCallback((event: AgentChunkEvent) => {
		switch (event.stream) {
			case "chat_queued_prompt_start":
				setStatus("starting");
				setStreamingId(null);
				streamingIdRef.current = null;
				setError(null);
				break;
			case "chat_text":
				setMessages((previous) => {
					const id = streamingIdRef.current;
					if (id) return previous.map((message) => (message.id === id ? { ...message, content: message.content + event.chunk } : message));
					const newId = makeId("msg");
					streamingIdRef.current = newId;
					setStreamingId(newId);
					return [...previous, { id: newId, sessionId: event.sessionId, role: "assistant" as const, content: event.chunk, createdAt: event.ts }];
				});
				break;
			case "chat_reasoning": {
				const parsed = parseJson<{ text?: string }>(event.chunk);
				if (!parsed?.text) break;
				setMessages((previous) => {
					const id = streamingIdRef.current;
					if (id) return previous.map((message) => (message.id === id ? { ...message, reasoning: (message.reasoning ?? "") + parsed.text } : message));
					const newId = makeId("msg");
					streamingIdRef.current = newId;
					setStreamingId(newId);
					return [
						...previous,
						{ id: newId, sessionId: event.sessionId, role: "assistant" as const, content: "", reasoning: parsed.text, createdAt: event.ts },
					];
				});
				break;
			}
			case "chat_tool_call_start": {
				streamingIdRef.current = null;
				setStreamingId(null);
				const payload = parseJson<{ toolCallId?: string; toolName?: string; input?: unknown }>(event.chunk) ?? {};
				setMessages((previous) => [
					...previous,
					{
						id: makeId("tool"),
						sessionId: event.sessionId,
						role: "tool" as const,
						content: JSON.stringify({ input: payload.input }),
						createdAt: event.ts,
						meta: {
							toolCallId: payload.toolCallId,
							toolName: payload.toolName,
							hookEventName: "tool_call_start",
							phase: "running",
						},
					},
				]);
				break;
			}
			case "chat_tool_call_update": {
				const payload = parseJson<{ toolCallId?: string; update?: { stream?: string; chunk?: string } }>(event.chunk) ?? {};
				if (!payload.toolCallId) break;
				setMessages((previous) =>
					previous.map((message) => {
						if (message.meta?.toolCallId !== payload.toolCallId) return message;
						const accumulated = (message.meta?.toolOutput ?? "") + (payload.update?.chunk ?? "");
						return {
							...message,
							meta: {
								...message.meta,
								toolOutput: accumulated,
								stream: (payload.update?.stream as "stdout" | "stderr") ?? message.meta?.stream,
							},
						};
					}),
				);
				break;
			}
			case "chat_tool_call_end": {
				const payload =
					parseJson<{
						toolCallId?: string;
						toolName?: string;
						input?: unknown;
						output?: unknown;
						error?: string;
						durationMs?: number;
						exitCode?: number;
					}>(event.chunk) ?? {};
				if (!payload.toolCallId) break;
				diffsStaleRef.current = true;
				setMessages((previous) =>
					previous.map((message) => {
						if (message.meta?.toolCallId !== payload.toolCallId) return message;
						return {
							...message,
							content: JSON.stringify({ input: payload.input, output: payload.output, error: payload.error, exitCode: payload.exitCode }),
							meta: {
								...message.meta,
								toolName: payload.toolName ?? message.meta?.toolName,
								toolOutput: typeof payload.output === "string" ? payload.output : JSON.stringify(payload.output ?? ""),
								durationMs: payload.durationMs,
								exitCode: payload.exitCode,
								hookEventName: "tool_call_end",
								phase: payload.error ? "failure" : "success",
							},
						};
					}),
				);
				break;
			}
			case "chat_usage": {
				const usage = parseJson<{ inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cost?: number }>(event.chunk);
				if (usage) {
					setSummary((current) => ({
						toolCalls: current.toolCalls,
						tokensIn: usage.inputTokens ?? current.tokensIn,
						tokensOut: (current.tokensOut ?? 0) + (usage.outputTokens ?? 0),
					}));
				}
				break;
			}
			case "chat_session_title": {
				const payload = parseJson<{ title?: string }>(event.chunk);
				if (!payload?.title) break;
				const title = payload.title;
			setSessions((current) => current.map((entry) => (entry.id === event.sessionId && !entry.customTitle ? { ...entry, title } : entry)));
				break;
			}
			case "chat_files_changed":
				diffsStaleRef.current = true;
				break;
			case "chat_done": {
				const payload = parseJson<{ reason?: string; text?: string }>(event.chunk);
				if (payload?.reason === "error" && payload.text) setError(payload.text);
				setStreamingId(null);
				streamingIdRef.current = null;
				break;
			}
			default:
				break;
		}
	}, []);

	useEffect(() => {
		const offChat = desktopClient.subscribe("chat_event", (payload) => {
			const event = payload as AgentChunkEvent;
			if (event.sessionId !== sessionRef.current) return;
			handleChunk(event);
		});
		const offStatus = desktopClient.subscribe("chat_session_status", (payload) => {
			const value = payload as { sessionId: string; status: ChatSessionStatus };
			if (value.sessionId !== sessionRef.current) return;
			setStatus(value.status);
			if (["idle", "completed", "error", "cancelled"].includes(value.status)) {
				setStreamingId(null);
				streamingIdRef.current = null;
			}
		});
		const offApprovals = desktopClient.subscribe("tool_approval_state", (payload) => {
			const value = payload as { sessionId: string; approvals: ToolApprovalRequestItem[] };
			if (value.sessionId !== sessionRef.current) return;
			setApprovals(value.approvals ?? []);
		});
		return () => {
			offChat();
			offStatus();
			offApprovals();
		};
	}, [handleChunk]);

	/* ---------------- session actions ---------------- */

	const loadDiffs = useCallback(
		async (id?: string) => {
			const target = id ?? sessionRef.current;
			if (!target) return;
			try {
				const result = await desktopClient.invoke<{ diffs: FileDiffEntryPayload[] }>("list_session_diffs", { sessionId: target });
				setDiffs(result.diffs ?? []);
				diffsStaleRef.current = false;
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e));
			}
		},
		[],
	);

	const loadNodes = useCallback(async (id?: string) => {
		const target = id ?? sessionRef.current;
		if (!target) return;
		try {
			const result = await desktopClient.invoke<{ nodes: ToolNodePayload[] }>("read_session_nodes", { sessionId: target });
			setNodes(result.nodes ?? []);
		} catch {}
	}, []);

	const selectSession = useCallback(
		async (id: string | null) => {
			sessionRef.current = id;
			if (!id) {
				setSessionId(null);
				setMessages([]);
				setStatus("idle");
				setConfig(null);
				setApprovals([]);
				setDiffs([]);
				setNodes([]);
				return;
			}
			setSessionId(id);
			setError(null);
			setStreamingId(null);
			streamingIdRef.current = null;
			setApprovals([]);
			setDiffs([]);
			setNodes([]);
			try {
				const messagesResult = await desktopClient.invoke<{ messages: ChatMessage[] }>("read_session_messages", {
					sessionId: id,
					maxMessages: 1000,
				});
				if (sessionRef.current !== id) return;
				setMessages(messagesResult.messages ?? []);
				const session = await desktopClient.invoke<{ session: { config: ChatSessionConfig; status: ChatSessionStatus } }>("get_session", {
					sessionId: id,
				});
				if (sessionRef.current !== id) return;
				setConfig(session.session?.config ?? null);
				setStatus(session.session?.status ?? "idle");
				const approvalsResult = await desktopClient.invoke<{ approvals: ToolApprovalRequestItem[] }>("poll_tool_approvals", { sessionId: id });
				if (sessionRef.current === id) setApprovals(approvalsResult.approvals ?? []);
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e));
			}
		},
		[],
	);

	const createSession = useCallback(
		async (workspaceRoot: string, options: { kind?: "work" | "chat"; profileId?: string; model?: string; mode?: "act" | "plan"; goal?: string } = {}) => {
			setBusyCommand("create_session");
			try {
				const result = await desktopClient.invoke<{ session: { id: string } }>("create_session", { workspaceRoot, ...options });
				await refreshSessions();
				await selectSession(result.session.id);
				return result.session;
			} finally {
				setBusyCommand(null);
			}
		},
		[refreshSessions, selectSession],
	);

	const deleteSession = useCallback(
		async (id: string) => {
			await desktopClient.invoke("delete_session", { sessionId: id });
			if (id === sessionRef.current) await selectSession(null);
			await refreshSessions();
		},
		[sessionId, selectSession, refreshSessions],
	);

	const createProject = useCallback(async (workspaceRoot: string) => {
		const result = await desktopClient.invoke<{ project: ProjectListItemPayload }>("create_project", { workspaceRoot });
		await refreshSessions();
		return result.project;
	}, [refreshSessions]);

	const renameProject = useCallback(async (projectId: string, name: string) => {
		await desktopClient.invoke("rename_project", { projectId, name });
		await refreshSessions();
	}, [refreshSessions]);

	const renameSession = useCallback(async (sessionId: string, title: string) => {
		await desktopClient.invoke("rename_session", { sessionId, title });
		await refreshSessions();
	}, [refreshSessions]);

	const pinSession = useCallback(async (sessionId: string, pinned: boolean) => {
		await desktopClient.invoke("pin_session", { sessionId, pinned });
		await refreshSessions();
	}, [refreshSessions]);

	const updateSessionOptions = useCallback(async (options: { profileId?: string; model?: string; mode?: "act" | "plan"; goal?: string }) => {
		const target = sessionRef.current;
		if (!target) return;
		const result = await desktopClient.invoke<{ session: { config: ChatSessionConfig } }>("update_session_config", { sessionId: target, config: options, goal: options.goal });
		setConfig(result.session.config);
		await refreshSessions();
	}, [refreshSessions]);

	const pickWorkspace = useCallback(async () => {
		const result = await desktopClient.invoke<{ paths: string[] }>("pick_workspace_directory", {}, 130_000);
		return result.paths[0] ?? null;
	}, []);
	const pickFiles = useCallback(async () => {
		const result = await desktopClient.invoke<{ paths: string[] }>("pick_attachment_files", {}, 130_000);
		return result.paths;
	}, []);

	const send = useCallback(async (prompt: string, options: { skillId?: string; attachments?: string[] } = {}) => {
		const target = sessionRef.current;
		if (!target || !prompt.trim()) return;
		const optimisticId = makeId("msg");
		setMessages((previous) => [...previous, { id: optimisticId, sessionId: target, role: "user", content: prompt, createdAt: Date.now() }]);
		// The transcript is re-read from the engine on the next open, so the
		// optimistic bubble is replaced rather than duplicated.
		setError(null);
		try {
			await desktopClient.invoke("chat_session_command", { action: "send", sessionId: target, prompt, ...options }, null);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			setStatus("error");
			setMessages((previous) => previous.filter((message) => message.id !== optimisticId));
			throw e;
		}
	}, []);

	const stop = useCallback(async () => {
		const target = sessionRef.current;
		if (!target) return;
		setBusyCommand("stop");
		try {
			const result = await desktopClient.invoke<{ cancelled: boolean; forced: boolean; detail: string }>(
				"chat_session_command",
				{ action: "stop", sessionId: target },
				20_000,
			);
			if (result.forced) setError(result.detail);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusyCommand(null);
		}
	}, []);

	const approve = useCallback(async (requestId: string) => {
		const target = sessionRef.current;
		if (!target) return;
		try {
			await desktopClient.invoke("resolve_tool_approval", { sessionId: target, requestId, decision: "allow" });
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, []);

	const reject = useCallback(async (requestId: string) => {
		const target = sessionRef.current;
		if (!target) return;
		try {
			await desktopClient.invoke("resolve_tool_approval", { sessionId: target, requestId, decision: "reject" });
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, []);

	/* ---------------- settings ---------------- */

	const saveSettings = useCallback(
		async (draft: SettingsDraft) => {
			setBusyCommand("save_settings");
			try {
				const profileResult = await desktopClient.invoke<{ profileId: string }>("save_model_profile", {
					profileId: draft.profileId || undefined,
					name: draft.profileName,
					protocol: draft.protocol,
					baseUrl: draft.baseUrl,
					models: draft.models,
					apiKey: draft.apiKey || undefined,
				});
				await desktopClient.invoke("save_model_settings", {
					lastWorkspace: draft.workspaceRoot,
					autoApproveEdits: draft.autoApproveEdits,
					autoApproveCommands: draft.autoApproveCommands,
					theme: draft.theme,
				});
				await refreshSettings();
				return profileResult.profileId;
			} finally {
				setBusyCommand(null);
			}
		},
		[refreshSettings],
	);

	const saveTheme = useCallback(async (theme: "dark" | "light") => {
		const result = await desktopClient.invoke<{ settings: ModelSettingsPayload }>("save_model_settings", { theme });
		setSettings(result.settings);
	}, []);

	const testConnection = useCallback(async (draft: SettingsDraft): Promise<ConnectionTestResult> => {
		setBusyCommand("test_connection");
		try {
			return await desktopClient.invoke<ConnectionTestResult>(
				"test_model_connection",
				{
					profileId: draft.profileId || undefined,
					protocol: draft.protocol,
					baseUrl: draft.baseUrl,
					model: draft.model,
					apiKey: draft.apiKey || undefined,
				},
				40_000,
			);
		} finally {
			setBusyCommand(null);
		}
	}, []);

	const deleteProfile = useCallback(async (profileId: string) => {
		await desktopClient.invoke("delete_model_profile", { profileId });
		await refreshSettings();
	}, [refreshSettings]);

	const restartEngine = useCallback(async () => {
		setBusyCommand("restart_engine");
		try {
			await desktopClient.invoke("engine_restart", {});
			await refreshEngine();
		} finally {
			setBusyCommand(null);
		}
	}, [refreshEngine]);

	const loadDiagnostics = useCallback(async () => {
		const result = await desktopClient.invoke<{ text: string }>("engine_diagnostics");
		return result.text;
	}, []);

	const validateWorkspace = useCallback(async (path: string) => {
		return desktopClient.invoke<{ valid: boolean; resolved?: string; error?: string }>("validate_workspace_directory", { path }, 15_000);
	}, []);

	const isBusy = status === "starting" || status === "running" || status === "stopping" || approvals.length > 0;
	const engineDown = !!engine && (engine.state === "failed" || engine.state === "crashed");

	return useMemo(
		() => ({
			sessionId,
			status,
			messages,
			config,
			error,
			summary,
			approvals,
			transportState,
			sessions,
			projects,
			streamingId,
			engine,
			engineDown,
			appInfo,
			settings,
			diffs,
			diffsStale: diffsStaleRef.current,
			nodes,
			busyCommand,
			backendFailure,
			isBusy,
			send,
			stop,
			createSession,
			selectSession,
			deleteSession,
			createProject,
			renameProject,
			renameSession,
			pinSession,
			updateSessionOptions,
			pickWorkspace,
			pickFiles,
			approve,
			reject,
			refreshSessions,
			refreshEngine,
			refreshSettings,
			saveSettings,
			deleteProfile,
			saveTheme,
			testConnection,
			restartEngine,
			loadDiagnostics,
			validateWorkspace,
			loadDiffs,
			loadNodes,
			setError,
		}),
		[
			sessionId,
			status,
			messages,
			config,
			error,
			summary,
			approvals,
			transportState,
			sessions,
			projects,
			streamingId,
			engine,
			engineDown,
			appInfo,
			settings,
			diffs,
			nodes,
			busyCommand,
			backendFailure,
			isBusy,
			send,
			stop,
			createSession,
			selectSession,
			deleteSession,
			createProject,
			renameProject,
			renameSession,
			pinSession,
			updateSessionOptions,
			pickWorkspace,
			pickFiles,
			approve,
			reject,
			refreshSessions,
			refreshEngine,
			refreshSettings,
			saveSettings,
			deleteProfile,
			saveTheme,
			testConnection,
			restartEngine,
			loadDiagnostics,
			validateWorkspace,
			loadDiffs,
			loadNodes,
		],
	);
}

export type ChatSessionApi = ReturnType<typeof useChatSession>;
