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
	AgentQuestionRequestItem,
	AppInfoPayload,
	ChatMessage,
	ChatSessionConfig,
	ChatSessionStatus,
	ChatSummary,
	ConnectionTestResult,
	EngineStatusPayload,
	FileDiffEntryPayload,
	ModelSettingsPayload,
	InlineAttachment,
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
	protocol: ProviderProtocol;
	baseUrl: string;
	model: string;
	workspaceRoot: string;
	apiKey: string;
}

export function useChatSession() {
	const [sessionId, setSessionId] = useState<string | null>(null);
	const [status, setStatus] = useState<ChatSessionStatus>("idle");
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [config, setConfig] = useState<ChatSessionConfig | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [summary, setSummary] = useState<ChatSummary>(EMPTY_SUMMARY);
	const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
	const [runEndedAt, setRunEndedAt] = useState<number | null>(null);
	const [runOutcome, setRunOutcome] = useState<ChatSessionStatus>("idle");
	const [hasUsage, setHasUsage] = useState(false);
	const [approvals, setApprovals] = useState<ToolApprovalRequestItem[]>([]);
	const [questions, setQuestions] = useState<AgentQuestionRequestItem[]>([]);
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
	const reasoningIdRef = useRef<string | null>(null);
	const sessionRef = useRef<string | null>(null);
	const activeKindRef = useRef<"work" | "chat">("work");
	const diffsStaleRef = useRef(true);
	const turnGenerationRef = useRef(0);
	const backgroundRuns = useRef(new Map<string, { messages: ChatMessage[]; status: ChatSessionStatus; config: ChatSessionConfig | null; summary: ChatSummary; runStartedAt: number | null; runEndedAt: number | null; runOutcome: ChatSessionStatus; hasUsage: boolean; streamingId: string | null; reasoningId: string | null; stepIntent: string | null; events: AgentChunkEvent[]; approvals: ToolApprovalRequestItem[]; questions: AgentQuestionRequestItem[] }>());
	const stepIntentRef = useRef<string | null>(null);
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
		const endReasoning = () => {
			const id = reasoningIdRef.current;
			if (!id) return;
			reasoningIdRef.current = null;
			setMessages((previous) => previous.map((message) => message.id === id ? { ...message, meta: { ...message.meta, phase: "success", hookEventName: "tool_call_end", durationMs: event.ts - message.createdAt } } : message));
		};
		switch (event.stream) {
			case "chat_queued_prompt_start":
				reasoningIdRef.current = null;
				stepIntentRef.current = null;
				turnGenerationRef.current++;
				setStatus("starting");
				setRunOutcome("running");
				setStreamingId(null);
				streamingIdRef.current = null;
				setError(null);
				setRunStartedAt(event.ts);
				setRunEndedAt(null);
				setSummary(EMPTY_SUMMARY);
				setHasUsage(false);
				setDiffs([]);
				break;
			case "chat_step_intent": {
				const intent = parseJson<{ text?: string }>(event.chunk)?.text?.trim();
				stepIntentRef.current = intent && Array.from(intent).length <= 15 ? intent : null;
				if (stepIntentRef.current) setMessages((previous) => {
					const turnStart = previous.findLastIndex((message) => message.role === "user");
					const index = previous.findLastIndex((message, at) => at > turnStart && message.meta?.messageKind === "reasoning" && !message.meta?.stepIntent);
					return index < 0 ? previous : previous.map((message, at) => at === index ? { ...message, meta: { ...message.meta, stepIntent: stepIntentRef.current ?? undefined } } : message);
				});
				break;
			}
			case "chat_text":
				endReasoning();
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
				if (activeKindRef.current === "chat") {
					const id = streamingIdRef.current ?? makeId("msg");
					streamingIdRef.current = id;
					setStreamingId(id);
					setMessages((previous) => previous.some((message) => message.id === id)
						? previous.map((message) => message.id === id ? { ...message, reasoning: (message.reasoning ?? "") + parsed.text } : message)
						: [...previous, { id, sessionId: event.sessionId, role: "assistant" as const, content: "", reasoning: parsed.text, createdAt: event.ts }]);
					break;
				}
				const id = reasoningIdRef.current ?? makeId("reasoning");
				reasoningIdRef.current = id;
				setMessages((previous) => {
					if (previous.some((message) => message.id === id)) return previous.map((message) => message.id === id ? { ...message, meta: { ...message.meta, toolOutput: (message.meta?.toolOutput ?? "") + parsed.text } } : message);
					return [...previous, { id, sessionId: event.sessionId, role: "tool" as const, content: JSON.stringify({ input: { description: "分析问题并规划下一步" } }), createdAt: event.ts, meta: { toolName: "thinking", messageKind: "reasoning", phase: "running" as const, hookEventName: "tool_call_start", toolOutput: parsed.text } }];
				});
				break;
			}
			case "chat_tool_call_start": {
				endReasoning();
				const stepIntent = stepIntentRef.current;
				stepIntentRef.current = null;
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
							stepIntent: stepIntent ?? undefined,
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
						title?: string;
						metadata?: Record<string, unknown>;
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
								title: payload.title,
								toolMetadata: payload.metadata,
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
					setHasUsage(true);
					setSummary((current) => ({
						toolCalls: current.toolCalls,
						tokensIn: current.tokensIn + (usage.inputTokens ?? 0),
						tokensOut: (current.tokensOut ?? 0) + (usage.outputTokens ?? 0),
						cacheReadTokens: (current.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0),
					}));
				}
				break;
			}
			case "chat_session_title": {
				const payload = parseJson<{ title?: string }>(event.chunk);
				if (!payload?.title) break;
				const title = payload.title;
			setSessions((current) => current.map((entry) => (entry.id === event.sessionId && entry.kind !== "chat" && !entry.customTitle ? { ...entry, title } : entry)));
				break;
			}
			case "chat_files_changed":
				diffsStaleRef.current = true;
				break;
			case "chat_done": {
				endReasoning();
				setRunEndedAt(event.ts);
				const payload = parseJson<{ reason?: string; text?: string }>(event.chunk);
				setRunOutcome(payload?.reason === "error" ? "error" : payload?.reason === "aborted" ? "cancelled" : "completed");
				if (payload?.reason === "error" && payload.text) setError(payload.text);
				setStreamingId(null);
				streamingIdRef.current = null;
				if (activeKindRef.current === "chat" && payload?.reason !== "error") {
					const generation = turnGenerationRef.current;
					void (async () => {
						for (const delay of [100, 350, 900, 1500]) {
							await new Promise((resolve) => setTimeout(resolve, delay));
							if (sessionRef.current !== event.sessionId || turnGenerationRef.current !== generation) return;
							try {
								const result = await desktopClient.invoke<{ messages: ChatMessage[] }>("read_session_messages", { sessionId: event.sessionId, maxMessages: 1000 });
								const history = result.messages ?? [];
								const lastUser = history.findLastIndex((message) => message.role === "user");
								if (!history.slice(lastUser + 1).some((message) => message.role === "assistant" && message.content.trim())) continue;
								if (sessionRef.current === event.sessionId && turnGenerationRef.current === generation) setMessages(history);
								return;
							} catch { /* the engine can still be finalising its history */ }
						}
					})();
				}
				break;
			}
			default:
				break;
		}
	}, []);

	useEffect(() => {
		const offChat = desktopClient.subscribe("chat_event", (payload) => {
			const event = payload as AgentChunkEvent;
			if (event.sessionId !== sessionRef.current) {
				backgroundRuns.current.get(event.sessionId)?.events.push(event);
				return;
			}
			handleChunk(event);
		});
		const offStatus = desktopClient.subscribe("chat_session_status", (payload) => {
			const value = payload as { sessionId: string; status: ChatSessionStatus };
			setSessions((current) => current.map((entry) => entry.id === value.sessionId ? { ...entry, status: value.status } : entry));
			if (value.sessionId !== sessionRef.current) {
				const run = backgroundRuns.current.get(value.sessionId);
				if (run) {
					run.status = value.status;
					if (["completed", "cancelled", "error"].includes(value.status)) { run.runOutcome = value.status; run.runEndedAt = Date.now(); }
				}
				return;
			}
			setStatus(value.status);
			if (["completed", "cancelled", "error"].includes(value.status)) setRunOutcome(value.status);
			if (["idle", "completed", "error", "cancelled"].includes(value.status)) {
				setRunEndedAt((previous) => previous ?? Date.now());
				setStreamingId(null);
				streamingIdRef.current = null;
			}
		});
		const offApprovals = desktopClient.subscribe("tool_approval_state", (payload) => {
			const value = payload as { sessionId: string; approvals: ToolApprovalRequestItem[] };
			if (value.sessionId !== sessionRef.current) { const run = backgroundRuns.current.get(value.sessionId); if (run) run.approvals = value.approvals ?? []; return; }
			setApprovals(value.approvals ?? []);
		});
		const offQuestions = desktopClient.subscribe("agent_question_state", (payload) => {
			const value = payload as { sessionId: string; questions: AgentQuestionRequestItem[] };
			if (value.sessionId === sessionRef.current) setQuestions(value.questions ?? []);
			else { const run = backgroundRuns.current.get(value.sessionId); if (run) run.questions = value.questions ?? []; }
		});
		return () => {
			offChat();
			offStatus();
			offApprovals();
			offQuestions();
		};
	}, [handleChunk]);

	/* ---------------- session actions ---------------- */

	const loadDiffs = useCallback(
		async (id?: string) => {
			const target = id ?? sessionRef.current;
			if (!target) return;
			const generation = turnGenerationRef.current;
			try {
				const result = await desktopClient.invoke<{ diffs: FileDiffEntryPayload[] }>("list_session_diffs", { sessionId: target, latestTurn: true });
				if (sessionRef.current !== target || turnGenerationRef.current !== generation) return;
				setDiffs(result.diffs ?? []);
				diffsStaleRef.current = false;
			} catch (e) {
				if (sessionRef.current === target && turnGenerationRef.current === generation) setError(e instanceof Error ? e.message : String(e));
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

	useEffect(() => {
		if (sessionId && runStartedAt && ["idle", "completed", "cancelled", "error"].includes(status)) void loadDiffs(sessionId);
	}, [sessionId, status, runStartedAt, loadDiffs]);

	const selectSession = useCallback(
		async (id: string | null) => {
			const previousId = sessionRef.current;
			if (previousId && previousId !== id && ["starting", "running", "stopping"].includes(status)) {
				backgroundRuns.current.set(previousId, { messages, status, config, summary, runStartedAt, runEndedAt, runOutcome, hasUsage, streamingId, reasoningId: reasoningIdRef.current, stepIntent: stepIntentRef.current, events: [], approvals, questions });
			}
			turnGenerationRef.current++;
			sessionRef.current = id;
			const cached = id ? backgroundRuns.current.get(id) : undefined;
			if (id && cached) {
				backgroundRuns.current.delete(id);
				setSessionId(id);
				setMessages(cached.messages);
				setStatus(cached.status);
				setConfig(cached.config);
				activeKindRef.current = cached.config?.kind ?? "work";
				setSummary(cached.summary);
				setRunStartedAt(cached.runStartedAt);
				setRunEndedAt(cached.runEndedAt);
				setRunOutcome(cached.runOutcome);
				setHasUsage(cached.hasUsage);
				setStreamingId(cached.streamingId);
				streamingIdRef.current = cached.streamingId;
				reasoningIdRef.current = cached.reasoningId;
				stepIntentRef.current = cached.stepIntent;
				setApprovals(cached.approvals);
				setQuestions(cached.questions);
				setError(null);
				for (const event of cached.events) handleChunk(event);
				void loadDiffs(id);
				return;
			}
			if (!id) {
				setSessionId(null);
				setMessages([]);
				setStatus("idle");
				setConfig(null);
				activeKindRef.current = "work";
				setApprovals([]);
				setQuestions([]);
				setDiffs([]);
				setNodes([]);
				setRunStartedAt(null);
				setRunEndedAt(null);
				setSummary(EMPTY_SUMMARY);
				setHasUsage(false);
				reasoningIdRef.current = null;
				stepIntentRef.current = null;
				return;
			}
			setSessionId(id);
			setError(null);
			setStreamingId(null);
			streamingIdRef.current = null;
			setApprovals([]);
			setQuestions([]);
			setDiffs([]);
			setNodes([]);
			setRunStartedAt(null);
			setRunEndedAt(null);
			reasoningIdRef.current = null;
			stepIntentRef.current = null;
			setSummary(EMPTY_SUMMARY);
			setHasUsage(false);
			setStatus("idle");
			setMessages([]);
			setConfig(null);
			try {
				const messagesResult = await desktopClient.invoke<{ messages: ChatMessage[] }>("read_session_messages", {
					sessionId: id,
					maxMessages: 1000,
				});
				if (sessionRef.current !== id) return;
				setMessages(messagesResult.messages ?? []);
				const history = messagesResult.messages ?? [];
				const lastUser = history.findLastIndex((message) => message.role === "user");
				const turn = history.slice(lastUser + 1).filter((message) => message.role === "assistant");
				setRunStartedAt(lastUser >= 0 ? history[lastUser].createdAt : null);
				setRunEndedAt(turn.reduce((latest, message) => Math.max(latest, message.meta?.completedAt ?? 0), 0) || null);
				setSummary({ toolCalls: 0, tokensIn: turn.reduce((total, message) => total + (message.meta?.inputTokens ?? 0), 0), tokensOut: turn.reduce((total, message) => total + (message.meta?.outputTokens ?? 0), 0), cacheReadTokens: turn.reduce((total, message) => total + (message.meta?.cacheReadTokens ?? 0), 0) });
				setHasUsage(turn.some((message) => (message.meta?.inputTokens ?? 0) + (message.meta?.outputTokens ?? 0) + (message.meta?.cacheReadTokens ?? 0) > 0));
				const session = await desktopClient.invoke<{ session: { config: ChatSessionConfig; status: ChatSessionStatus } }>("get_session", {
					sessionId: id,
				});
				if (sessionRef.current !== id) return;
				setConfig(session.session?.config ?? null);
				activeKindRef.current = session.session?.config?.kind ?? "work";
				setStatus(session.session?.status ?? "idle");
				setRunOutcome(session.session?.status ?? "idle");
				const approvalsResult = await desktopClient.invoke<{ approvals: ToolApprovalRequestItem[] }>("poll_tool_approvals", { sessionId: id });
				if (sessionRef.current === id) setApprovals(approvalsResult.approvals ?? []);
				const questionResult = await desktopClient.invoke<{ questions: AgentQuestionRequestItem[] }>("poll_agent_questions", { sessionId: id });
				if (sessionRef.current === id) setQuestions(questionResult.questions ?? []);
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e));
			}
		},
		[messages, status, config, summary, runStartedAt, runEndedAt, runOutcome, hasUsage, streamingId, approvals, questions, handleChunk, loadDiffs],
	);

	const createSession = useCallback(
		async (workspaceRoot: string, options: { kind?: "work" | "chat"; profileId?: string; model?: string; mode?: "act" | "plan"; goal?: string } = {}) => {
			activeKindRef.current = options.kind ?? "work";
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
	const setProjectIcon = useCallback(async (projectId: string, icon: NonNullable<ProjectListItemPayload["icon"]>) => {
		await desktopClient.invoke("set_project_icon", { projectId, icon });
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

	const send = useCallback(async (prompt: string, options: { skillId?: string; attachments?: string[]; inlineAttachments?: InlineAttachment[] } = {}) => {
		const target = sessionRef.current;
		if (!target || !prompt.trim()) return;
		turnGenerationRef.current++;
		reasoningIdRef.current = null;
		const optimisticId = makeId("msg");
		const attached = options.inlineAttachments?.map((file) => file.name).filter(Boolean) ?? [];
		setMessages((previous) => [...previous, { id: optimisticId, sessionId: target, role: "user", content: attached.length ? `${prompt}\n\n附件：${attached.join("、")}` : prompt, createdAt: Date.now() }]);
		// The transcript is re-read from the engine on the next open, so the
		// optimistic bubble is replaced rather than duplicated.
		setError(null);
		setRunStartedAt(Date.now());
		setStatus("starting");
		setRunOutcome("running");
		setRunEndedAt(null);
		setSummary(EMPTY_SUMMARY);
		setHasUsage(false);
		setDiffs([]);
		try {
			await desktopClient.invoke("chat_session_command", { action: "send", sessionId: target, prompt, ...options }, null);
			await refreshSessions();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			setStatus("error");
			setRunOutcome("error");
			setRunEndedAt(Date.now());
			setMessages((previous) => previous.filter((message) => message.id !== optimisticId));
			throw e;
		}
	}, [refreshSessions]);

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

	const answerQuestion = useCallback(async (requestId: string, answers: string[][]) => {
		const target = sessionRef.current;
		if (!target) return;
		await desktopClient.invoke("answer_agent_question", { sessionId: target, requestId, answers });
		setQuestions((items) => items.filter((item) => item.requestId !== requestId));
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
					models: [draft.model.trim()],
					apiKey: draft.apiKey || undefined,
				});
				await desktopClient.invoke("save_model_settings", {
					lastWorkspace: draft.workspaceRoot,
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

	const setApprovalMode = useCallback(async (mode: "ask" | "auto" | "full") => {
		const result = await desktopClient.invoke<{ settings: ModelSettingsPayload }>("save_model_settings", {
			autoApproveEdits: mode !== "ask",
			autoApproveCommands: mode !== "ask",
			fullAccess: mode === "full",
		});
		setSettings(result.settings);
	}, []);

	const saveAppearance = useCallback(async (patch: { theme?: "dark" | "light"; fontFamily?: "system" | "mono"; fontSize?: "small" | "normal" | "large" }) => {
		const result = await desktopClient.invoke<{ settings: ModelSettingsPayload }>("save_model_settings", patch);
		setSettings(result.settings);
	}, []);

	const saveAvatar = useCallback(async (role: "user" | "assistant", value: string) => {
		const result = await desktopClient.invoke<{ settings: ModelSettingsPayload }>("save_model_settings", role === "user" ? { userAvatar: value } : { assistantAvatar: value });
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

	const isBusy = status === "starting" || status === "running" || status === "stopping" || approvals.length > 0 || questions.length > 0;
	const engineDown = !!engine && (engine.state === "failed" || engine.state === "crashed");

	return useMemo(
		() => ({
			sessionId,
			status,
			messages,
			config,
			error,
			summary,
			runStartedAt,
			runEndedAt,
			runOutcome,
			hasUsage,
			approvals,
			questions,
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
			setProjectIcon,
			renameSession,
			pinSession,
			updateSessionOptions,
			pickWorkspace,
			pickFiles,
			approve,
			reject,
			answerQuestion,
			refreshSessions,
			refreshEngine,
			refreshSettings,
			saveSettings,
			deleteProfile,
			saveTheme,
			saveAppearance,
			saveAvatar,
			setApprovalMode,
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
			runStartedAt,
			runEndedAt,
			runOutcome,
			hasUsage,
			approvals,
			questions,
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
			saveAppearance,
			saveAvatar,
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
