import { useEffect, useState } from "react";
import { CheckCircle2, FolderOpen, Loader2, Plus, ShieldCheck, Trash2, X, XCircle } from "lucide-react";
import type { ConnectionTestResult, ModelSettingsPayload, ProviderProtocol } from "@/lib/chat-schema";
import { DEFAULT_BASE_URLS, DEFAULT_MODELS, PROTOCOL_LABELS } from "@/lib/config";
import type { SettingsDraft } from "@/hooks/use-chat-session";

interface Props {
	open: boolean;
	mode: "create" | "update";
	settings: ModelSettingsPayload | null;
	lastWorkspace: string;
	osProtected: boolean;
	busyCommand: string | null;
	onClose: () => void;
	onSave: (draft: SettingsDraft) => Promise<string>;
	onDeleteProfile: (profileId: string) => Promise<void>;
	onTest: (draft: SettingsDraft) => Promise<ConnectionTestResult>;
	onValidateWorkspace: (path: string) => Promise<{ valid: boolean; resolved?: string; error?: string }>;
	onPickWorkspace: () => Promise<string | null>;
}

function draftFrom(settings: ModelSettingsPayload | null, lastWorkspace: string, profileId?: string): SettingsDraft {
	const profile = settings?.profiles.find((item) => item.id === (profileId ?? settings.defaultProfileId)) ?? settings?.profiles[0];
	return {
		profileId: profile?.id ?? "default",
		profileName: profile?.name ?? "默认 API",
		protocol: profile?.protocol ?? settings?.protocol ?? "openai-compatible",
		baseUrl: profile?.baseUrl || settings?.baseUrl || DEFAULT_BASE_URLS["openai-compatible"],
		model: profile?.models[0] || settings?.model || DEFAULT_MODELS["openai-compatible"],
		workspaceRoot: settings?.lastWorkspace || lastWorkspace,
		// Never prefilled: the key lives only in the OS protected store.
		apiKey: "",
		autoApproveEdits: settings?.autoApproveEdits ?? false,
		autoApproveCommands: settings?.autoApproveCommands ?? false,
	};
}

export function SettingsDialog({ open, mode, settings, lastWorkspace, osProtected, busyCommand, onClose, onSave, onDeleteProfile, onTest, onValidateWorkspace, onPickWorkspace }: Props) {
	const [draft, setDraft] = useState<SettingsDraft>(() => draftFrom(settings, lastWorkspace));
	const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
	const [saveState, setSaveState] = useState<{ ok: boolean; message: string } | null>(null);
	const [workspaceState, setWorkspaceState] = useState<{ valid: boolean; message: string } | null>(null);
	const [selectedProfileId, setSelectedProfileId] = useState(settings?.defaultProfileId ?? "default");

	useEffect(() => {
		if (open) {
			const selected = settings?.defaultProfileId ?? "default";
			setSelectedProfileId(selected);
			setDraft(draftFrom(settings, lastWorkspace, selected));
			setTestResult(null);
			setSaveState(null);
			setWorkspaceState(null);
		}
	}, [open]);

	if (!open) return null;

	const set = <K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]) => setDraft((previous) => ({ ...previous, [key]: value }));

	const switchProtocol = (protocol: ProviderProtocol) => {
		setDraft((previous) => ({
			...previous,
			protocol,
			baseUrl: DEFAULT_BASE_URLS[protocol],
			model: DEFAULT_MODELS[protocol],
		}));
		setTestResult(null);
	};

	const currentProfile = settings?.profiles.find((item) => item.id === selectedProfileId);
	const keyPlaceholder = currentProfile?.hasApiKey ? `已保存 ${currentProfile.apiKeyMask ?? "••••"}（留空表示不修改）` : "sk-...";

	return (
		<div className="dialog-overlay">
			<div className="dialog" role="dialog" aria-modal="true" aria-label="API 设置">
				<div className="dialog-head">
					<h2>设置</h2>
					<button onClick={onClose} aria-label="关闭">
						<X size={16} />
					</button>
				</div>
				<div className="field">
					<label>API 配置</label>
					<div className="api-profile-list">
						{settings?.profiles.map((profile) => <button key={profile.id} className="api-profile-item" data-active={selectedProfileId === profile.id} onClick={() => { setSelectedProfileId(profile.id); setDraft(draftFrom(settings, lastWorkspace, profile.id)); setTestResult(null); setSaveState(null); }}>
							<span className="api-profile-status" data-ready={profile.hasApiKey} />
							<span><strong>{profile.name}</strong><small>{profile.models.join(" · ")}</small></span>
						</button>)}
						<button className="api-profile-add" onClick={() => { setSelectedProfileId(""); setDraft({ ...draftFrom(settings, lastWorkspace), profileId: "", profileName: "", apiKey: "", model: "" }); setTestResult(null); setSaveState(null); }}><Plus size={15} /> 添加 API</button>
					</div>
				</div>
				<div className="field"><label>配置名称</label><input value={draft.profileName} onChange={(event) => set("profileName", event.target.value)} placeholder="例如：DeepSeek 工作模型" /></div>

				<div className="field">
					<label>接口协议</label>
					<div className="segmented">
						{(["openai-compatible", "anthropic"] as ProviderProtocol[]).map((protocol) => (
							<button key={protocol} className="seg" data-active={draft.protocol === protocol} onClick={() => switchProtocol(protocol)}>
								{PROTOCOL_LABELS[protocol]}
							</button>
						))}
					</div>
					<div className="hint">
						{draft.protocol === "openai-compatible"
							? "使用 Chat Completions 接口（不是 Responses API）。"
							: "使用 Anthropic Messages 接口（/v1/messages）。"}
					</div>
				</div>

				<div className="field">
					<label>Base URL</label>
					<input
						type="text"
						value={draft.baseUrl}
						onChange={(event) => set("baseUrl", event.target.value)}
						placeholder={DEFAULT_BASE_URLS[draft.protocol]}
					/>
					<div className="hint">仅去掉结尾多余的斜杠，路径前缀（如 /v1）原样保留。</div>
				</div>

				<div className="row2">
					<div className="field">
						<label>模型 ID</label>
						<input value={draft.model} onChange={(event) => set("model", event.target.value)} placeholder={DEFAULT_MODELS[draft.protocol]} />
						<div className="hint">每份 API 配置一个模型；可添加多份配置并在对话框切换。</div>
					</div>
					<div className="field">
						<label>API Key {osProtected && <span className="badge-ok"><ShieldCheck size={11} /> 系统保护</span>}</label>
						<input type="password" value={draft.apiKey} onChange={(event) => set("apiKey", event.target.value)} placeholder={keyPlaceholder} />
						<div className="hint">使用 Windows DPAPI 加密保存，界面与日志只显示掩码。</div>
					</div>
				</div>

				<div className="field">
						<label>Work 默认工作区目录（可留空）</label>
					<div className="settings-workspace-picker">
						<button type="button" onClick={async () => {
							try {
								const path = await onPickWorkspace();
								if (!path) return;
								const result = await onValidateWorkspace(path);
								if (result.valid) set("workspaceRoot", result.resolved ?? path);
								setWorkspaceState({ valid: result.valid, message: result.valid ? "已选择工作区" : result.error ?? "路径不可用" });
							} catch (error) { setWorkspaceState({ valid: false, message: error instanceof Error ? error.message : String(error) }); }
						}}><FolderOpen size={16} /><span>{draft.workspaceRoot || "选择文件夹"}</span></button>
						{draft.workspaceRoot && <button type="button" aria-label="清除默认工作区" onClick={() => { set("workspaceRoot", ""); setWorkspaceState(null); }}><X size={14} /></button>}
					</div>
					<div className="hint">
						项目内读取默认允许；修改文件与执行命令默认询问。工作区是权限边界，不是操作系统级沙箱。
					</div>
					{workspaceState && (
						<div className={workspaceState.valid ? "inline-ok" : "inline-bad"}>
							{workspaceState.valid ? <CheckCircle2 size={12} /> : <XCircle size={12} />} {workspaceState.message}
						</div>
					)}
				</div>

				<div className="row2">
					<label className="check">
						<input type="checkbox" checked={draft.autoApproveEdits} onChange={(event) => set("autoApproveEdits", event.target.checked)} />
						自动批准文件修改
					</label>
					<label className="check">
						<input type="checkbox" checked={draft.autoApproveCommands} onChange={(event) => set("autoApproveCommands", event.target.checked)} />
						自动批准命令执行
					</label>
				</div>
				<div className="hint" style={{ marginTop: -6 }}>
					关闭时通常会请求授权；具体判定由执行引擎负责。第一版不提供「永久允许全部」。
				</div>

				{testResult && (
					<div className={testResult.ok ? "test-ok" : "test-bad"}>
						<strong>
							{testResult.ok ? <CheckCircle2 size={13} /> : <XCircle size={13} />} {testResult.message}
						</strong>
						{testResult.detail && <pre>{testResult.detail}</pre>}
						<span className="test-kind">类别：{testResult.kind} · 耗时 {testResult.latencyMs}ms</span>
					</div>
				)}

				{saveState && <div className={saveState.ok ? "inline-ok" : "inline-bad"}>{saveState.message}</div>}

				<div className="dialog-actions">
					{currentProfile && settings && settings.profiles.length > 1 && <button className="btn danger" onClick={async () => {
						if (!window.confirm(`删除 API 配置“${currentProfile.name}”？`)) return;
						try {
							await onDeleteProfile(currentProfile.id);
							const remaining = settings.profiles.find((item) => item.id !== currentProfile.id);
							if (remaining) {
								setSelectedProfileId(remaining.id);
								setDraft(draftFrom(settings, lastWorkspace, remaining.id));
							}
							setTestResult(null);
							setSaveState({ ok: true, message: "API 配置已删除。" });
						} catch (error) {
							setSaveState({ ok: false, message: error instanceof Error ? error.message : String(error) });
						}
					}}><Trash2 size={14} /> 删除 API</button>}
					<button
						className="btn"
						disabled={busyCommand === "test_connection" || !draft.model.trim() || !draft.baseUrl.trim()}
						onClick={async () => {
							setTestResult(null);
							try { setTestResult(await onTest(draft)); }
							catch (error) { setSaveState({ ok: false, message: error instanceof Error ? error.message : String(error) }); }
						}}
					>
						{busyCommand === "test_connection" ? <Loader2 size={14} className="spin" /> : null} 测试连接
					</button>
					<span className="spacer" style={{ flex: 1 }} />
					<button
						className="btn btn-primary"
						disabled={busyCommand === "save_settings" || !draft.profileName.trim() || !draft.model.trim() || !draft.baseUrl.trim()}
						onClick={async () => {
							try {
								const id = await onSave(draft);
								setSelectedProfileId(id);
								setDraft((current) => ({ ...current, profileId: id, apiKey: "" }));
								setSaveState({ ok: true, message: "配置已保存；可继续添加其他 API。" });
							} catch (e) {
								setSaveState({ ok: false, message: e instanceof Error ? e.message : String(e) });
							}
						}}
					>
						{busyCommand === "save_settings" ? <Loader2 size={14} className="spin" /> : null} 保存配置
					</button>
				</div>
				<div className="hint">「保存配置」与「测试连接」是独立操作：测试会发送一个最小、无工具调用的真实请求。</div>
			</div>
		</div>
	);
}
