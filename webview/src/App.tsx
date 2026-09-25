import { useCallback, useEffect, useMemo, useState } from "react";
import { useChatSession, type SettingsDraft } from "@/hooks/use-chat-session";
import { Sidebar } from "@/components/sidebar";
import { ExecutionCanvas } from "@/components/execution-canvas";
import { ChatMessages } from "@/components/chat-messages";
import { ChatInputBar } from "@/components/chat-input-bar";
import { Welcome } from "@/components/welcome";
import { SettingsDialog } from "@/components/settings-dialog";
import { DiffPanel } from "@/components/diff-panel";
import { EngineError } from "@/components/engine-error";
import { pruneExecutionMessages } from "@/lib/execution-window";
import { FileDiff, Folder, FolderOpen, Loader2, MessageCircle, RefreshCw, Wifi, WifiOff, X } from "lucide-react";

export function App() {
	const api = useChatSession();
	const [capacity, setCapacity] = useState(8);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [dialogMode, setDialogMode] = useState<"create" | "update">("create");
	const [diffOpen, setDiffOpen] = useState(false);
	const [diffLoading, setDiffLoading] = useState(false);
	const [draftWorkspace, setDraftWorkspace] = useState("");
	const [selectedModel, setSelectedModel] = useState("");
	const [selectedProfileId, setSelectedProfileId] = useState("");
	const [draftKind, setDraftKind] = useState<"work" | "chat">("work");
	const [selectedMode, setSelectedMode] = useState<"act" | "plan">("act");
	const [goal, setGoal] = useState("");
	const [projectOpen, setProjectOpen] = useState(false);
	const [projectPath, setProjectPath] = useState("");
	const [theme, setTheme] = useState<"dark" | "light">(() => {
		try { return localStorage.getItem("harness-theme") === "light" ? "light" : "dark"; } catch { return "dark"; }
	});

	useEffect(() => {
		if (api.settings?.theme) setTheme(api.settings.theme);
	}, [api.settings?.theme]);
	useEffect(() => {
		document.documentElement.classList.toggle("dark", theme === "dark");
		try { localStorage.setItem("harness-theme", theme); } catch {}
	}, [theme]);
	const changeTheme = useCallback((next: "dark" | "light") => {
		setTheme(next);
		void api.saveTheme(next).catch((error: unknown) => api.setError(error instanceof Error ? error.message : String(error)));
	}, [api.saveTheme, api.setError]);

	const protectedToolCallIds = useMemo(() => api.approvals.map((item) => item.toolCallId), [api.approvals]);
	const displayMessages = useMemo(
		() => pruneExecutionMessages(api.messages, capacity, protectedToolCallIds),
		[api.messages, capacity, protectedToolCallIds],
	);

	const onClear = useCallback(() => {
		// The canvas calls this once a finished run has collapsed; the prune is
		// applied reactively, so there is nothing to mutate here.
	}, []);

	const openCreate = useCallback((workspaceRoot?: string) => {
		setDraftKind("work");
		const root = workspaceRoot ?? (api.config?.kind === "work" ? api.config.workspaceRoot : undefined) ?? api.settings?.lastWorkspace ?? "";
		setDraftWorkspace(root);
		setSelectedProfileId(api.settings?.defaultProfileId ?? "default");
		setSelectedModel(api.settings?.profiles.find((item) => item.id === api.settings?.defaultProfileId)?.models[0] ?? api.settings?.model ?? "");
		setSelectedMode("act");
		setGoal("");
		void api.selectSession(null);
	}, [api.config?.workspaceRoot, api.config?.kind, api.settings?.lastWorkspace, api.settings?.model, api.settings?.profiles, api.settings?.defaultProfileId, api.selectSession]);
	const openChat = useCallback(() => {
		setDraftKind("chat");
		setDraftWorkspace("");
		setSelectedProfileId(api.settings?.defaultProfileId ?? "default");
		setSelectedModel(api.settings?.profiles.find((item) => item.id === api.settings?.defaultProfileId)?.models[0] ?? api.settings?.model ?? "");
		setSelectedMode("act");
		setGoal("");
		void api.selectSession(null);
	}, [api.settings, api.selectSession]);

	useEffect(() => {
		if (!api.sessionId || !api.config) return;
		setDraftWorkspace(api.config.workspaceRoot);
		setDraftKind(api.config.kind ?? "work");
		setSelectedProfileId(api.config.profileId ?? api.settings?.defaultProfileId ?? "default");
		setSelectedModel(api.config.model);
		setSelectedMode(api.config.mode);
		setGoal(api.config.goal ?? "");
	}, [api.sessionId, api.config]);
	useEffect(() => {
		if (!api.sessionId && !selectedModel && api.settings?.model) setSelectedModel(api.settings.model);
		if (!api.sessionId && !selectedProfileId && api.settings?.defaultProfileId) setSelectedProfileId(api.settings.defaultProfileId);
	}, [api.sessionId, api.settings?.model, api.settings?.defaultProfileId, selectedModel, selectedProfileId]);
	useEffect(() => {
		const shortcut = (event: KeyboardEvent) => {
			if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") { event.preventDefault(); openCreate(); }
		};
		window.addEventListener("keydown", shortcut);
		return () => window.removeEventListener("keydown", shortcut);
	}, [openCreate]);

	const openUpdate = useCallback(() => {
		setDialogMode("update");
		setDialogOpen(true);
	}, []);

	const handleSave = useCallback(async (draft: SettingsDraft) => api.saveSettings(draft), [api.saveSettings]);

	const send = useCallback(async (prompt: string, options: { skillId?: string; attachments?: string[] } = {}) => {
		const kind = api.sessionId ? api.config?.kind ?? "work" : draftKind;
		const workspace = kind === "chat" ? "" : (api.sessionId ? api.config?.workspaceRoot ?? "" : draftWorkspace).trim();
		if (kind === "work" && !workspace) throw new Error("请先在输入框选择访问位置。");
		if (!selectedModel.trim()) throw new Error("请先选择模型。");
		const profile = api.settings?.profiles.find((item) => item.id === selectedProfileId);
		if (!profile?.hasApiKey) throw new Error(`请先为“${profile?.name ?? "所选 API"}”配置 API Key。`);
		if (!api.sessionId) await api.createSession(workspace, { kind, profileId: selectedProfileId, model: selectedModel.trim(), mode: selectedMode, goal });
		else await api.updateSessionOptions(kind === "chat" ? { profileId: selectedProfileId, model: selectedModel.trim() } : { profileId: selectedProfileId, model: selectedModel.trim(), mode: selectedMode, goal });
		await api.send(prompt, kind === "chat" ? {} : options);
	}, [api.sessionId, api.config?.workspaceRoot, api.config?.kind, api.settings?.profiles, api.createSession, api.updateSessionOptions, api.send, draftWorkspace, draftKind, selectedProfileId, selectedModel, selectedMode, goal]);

	const chooseWorkspace = useCallback(async () => api.pickWorkspace(), [api.pickWorkspace]);
	const addProject = useCallback(async () => {
		const project = await api.createProject(projectPath.trim());
		setProjectOpen(false);
		openCreate(project.workspaceRoot);
	}, [api.createProject, projectPath, openCreate]);

	const openDiffs = useCallback(async () => {
		setDiffOpen(true);
		setDiffLoading(true);
		try {
			await api.loadDiffs();
		} finally {
			setDiffLoading(false);
		}
	}, [api]);

	const hasSession = !!api.sessionId;
	const activeKind = api.sessionId ? api.config?.kind ?? "work" : draftKind;
	const connected = api.transportState === "connected";
	const engineLabel = api.engine
		? api.engine.state === "running"
			? `引擎就绪 · 端口 ${api.engine.port}`
			: api.engine.state === "starting"
				? "引擎启动中…"
				: "引擎未就绪"
		: "未连接引擎";

	return (
		<div className="app">
			<Sidebar
				sessions={api.sessions}
				projects={api.projects}
				activeId={api.sessionId}
				activeWorkspace={!api.sessionId ? draftWorkspace : undefined}
				onSelect={api.selectSession}
				onNew={openCreate}
				onNewChat={openChat}
				onNewProject={() => { setProjectPath(""); setProjectOpen(true); }}
				onOpenSettings={openUpdate}
				onDelete={api.deleteSession}
				onRename={api.renameSession}
				onPin={api.pinSession}
				onRenameProject={api.renameProject}
				onActionError={(error) => api.setError(error instanceof Error ? error.message : String(error))}
				theme={theme}
				onToggleTheme={() => changeTheme(theme === "dark" ? "light" : "dark")}
				status={api.status}
			/>
			<main className="app-main">
				<header className="app-titlebar">
					{activeKind === "chat" ? <MessageCircle size={15} /> : <Folder size={15} />}
					<span className="title">{api.sessionId ? (api.sessions.find((item) => item.id === api.sessionId)?.title || "对话") : activeKind === "chat" ? "新聊天" : "新对话"}</span>
					<span className="spacer" />
					<span className="engine-chip" data-state={api.engine?.state ?? "unknown"} title={engineLabel}>
						{api.engine?.state === "running" ? <Wifi size={12} /> : <WifiOff size={12} />} {api.engine?.state === "running" ? "已连接" : "引擎未就绪"}
					</span>
					{hasSession && activeKind === "work" && (
						<button className="btn btn-ghost" onClick={openDiffs} title="查看文件差异">
							<FileDiff size={13} /> 差异
						</button>
					)}
					{(!connected || api.transportState === "reconnecting") && (
						<span className="transport-inline">
							<Loader2 size={12} className="spin" /> 正在连接后端…
						</span>
					)}
				</header>

				{api.error && (
					<div className="transport-banner" role="alert">
						<span>{api.error}</span>
						<button className="btn btn-ghost" onClick={() => api.setError(null)}>
							知道了
						</button>
					</div>
				)}

				{api.backendFailure ? (
					<div className="engine-error" role="alert">
						<div className="ee-icon">
							<WifiOff size={22} />
						</div>
						<h2>无法连接后端服务</h2>
						<p>{api.backendFailure}</p>
						<dl className="ee-facts">
							<div>
								<dt>连接状态</dt>
								<dd>{api.transportState}</dd>
							</div>
							<div>
								<dt>日志</dt>
							<dd>%LOCALAPPDATA%\Harness\data\logs\shell.log</dd>
							</div>
						</dl>
						<div className="ee-actions">
							<button className="btn btn-primary" onClick={() => window.location.reload()}>
								<RefreshCw size={14} /> 重新加载界面
							</button>
						</div>
						<p className="ee-hint">
							桌面版由某科学的Agent启动后端并注入启动握手；若反复出现，请确认没有残留的
							harness-shell.exe / harness-backend.exe 进程，然后重新启动应用。
						</p>
					</div>
				) : api.engineDown && api.engine ? (
					<EngineError
						engine={api.engine}
						retrying={api.busyCommand === "restart_engine"}
						onRetry={() => void api.restartEngine()}
						onDiagnostics={api.loadDiagnostics}
					/>
				) : (
					<>
						<div className="app-conversation">
							<ChatMessages messages={api.messages} status={api.status} streamingId={api.streamingId} error={api.error} />
							{api.messages.length === 0 && <Welcome kind={activeKind} onPick={(prompt) => { void send(prompt).catch((cause: unknown) => api.setError(cause instanceof Error ? cause.message : String(cause))); }} hasWorkspace={!!draftWorkspace} onOpenSettings={() => { void chooseWorkspace().then((path) => { if (path) setDraftWorkspace(path); }).catch((cause: unknown) => api.setError(cause instanceof Error ? cause.message : String(cause))); }} />}
							{hasSession && activeKind === "work" && <ExecutionCanvas
								messages={displayMessages}
								status={api.status}
								sessionId={api.sessionId}
								approvals={api.approvals}
								onCapacity={setCapacity}
								onClear={onClear}
								onApprove={api.approve}
								onReject={api.reject}
							/>}
						</div>
						<ChatInputBar
							onSend={send}
							onStop={api.stop}
							onOpenSettings={openUpdate}
							onPickFolder={chooseWorkspace}
							onPickFiles={api.pickFiles}
							onWorkspaceChange={setDraftWorkspace}
							onProfileModelChange={(profileId, model) => { setSelectedProfileId(profileId); setSelectedModel(model); }}
							onModeChange={setSelectedMode}
							onGoalChange={setGoal}
							busy={api.isBusy}
							model={selectedModel}
							profileId={selectedProfileId}
							profiles={api.settings?.profiles ?? []}
							kind={activeKind}
							workspace={draftWorkspace}
							projects={api.projects}
							mode={selectedMode}
							goal={goal}
							workspaceLocked={hasSession}
						/>
					</>
				)}

				<DiffPanel
					open={diffOpen && hasSession && activeKind === "work"}
					diffs={api.diffs}
					stale={api.diffsStale}
					loading={diffLoading}
					onClose={() => setDiffOpen(false)}
					onRefresh={async () => {
						setDiffLoading(true);
						try {
							await api.loadDiffs();
						} finally {
							setDiffLoading(false);
						}
					}}
				/>
			</main>

			<SettingsDialog
				open={dialogOpen}
				mode={dialogMode}
				settings={api.settings}
				lastWorkspace={api.settings?.lastWorkspace ?? ""}
				osProtected={!!api.appInfo?.credentialsOsProtected}
				busyCommand={api.busyCommand}
				onClose={() => setDialogOpen(false)}
				onSave={handleSave}
				onDeleteProfile={api.deleteProfile}
				onTest={api.testConnection}
				onValidateWorkspace={api.validateWorkspace}
				onThemeChange={changeTheme}
			/>
			{projectOpen && <div className="dialog-overlay" onClick={() => setProjectOpen(false)}>
				<div className="dialog project-dialog" onClick={(event) => event.stopPropagation()}>
					<div className="dialog-head"><h2>添加项目</h2><button onClick={() => setProjectOpen(false)} aria-label="关闭"><X size={17} /></button></div>
					<p>选择一个文件夹，之后可以在这个项目下创建多个对话。</p>
					<div className="project-path-row"><input autoFocus value={projectPath} onChange={(event) => setProjectPath(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void addProject().catch((cause: unknown) => api.setError(cause instanceof Error ? cause.message : String(cause))); }} placeholder="C:\\Users\\you\\project" /><button className="btn" onClick={() => { void chooseWorkspace().then((path) => { if (path) setProjectPath(path); }).catch((cause: unknown) => api.setError(cause instanceof Error ? cause.message : String(cause))); }}><FolderOpen size={15} /> 浏览</button></div>
					<div className="dialog-actions"><button className="btn" onClick={() => setProjectOpen(false)}>取消</button><button className="btn btn-primary" disabled={!projectPath.trim()} onClick={() => { void addProject().catch((cause: unknown) => api.setError(cause instanceof Error ? cause.message : String(cause))); }}>添加项目</button></div>
				</div>
			</div>}
		</div>
	);
}
