import { useEffect, useRef, useState } from "react";
import { Atom, BadgeCheck, Blocks, BookOpen, Brush, Bug, Check, ChevronDown, FilePlus2, FlaskConical, Folder, FolderOpen, GitBranch, GitPullRequest, LayoutTemplate, Lightbulb, ListTodo, MessageSquareText, Palette, PencilLine, Plus, Send, Settings, Shapes, Square, Sticker, Target, TestTubeDiagonal, Workflow, X, type LucideIcon } from "lucide-react";
import { BUILTIN_SKILLS } from "@shared/skills";
import type { ApiProfilePayload, ProjectListItemPayload } from "@/lib/chat-schema";

const SKILL_ICONS: Record<string, LucideIcon> = {
	"algorithmic-art": Atom, "brand-guidelines": Palette, "canvas-design": Shapes,
	"frontend-design": LayoutTemplate, "internal-comms": MessageSquareText,
	"mcp-builder": Blocks, "skill-creator": PencilLine, "slack-gif-creator": Sticker,
	"theme-factory": Brush, "web-artifacts-builder": Workflow, "webapp-testing": TestTubeDiagonal,
	brainstorming: Lightbulb, "systematic-debugging": Bug, "test-driven-development": FlaskConical,
	"verification-before-completion": BadgeCheck, "writing-plans": ListTodo,
	"using-git-worktrees": GitBranch, "finishing-a-development-branch": GitPullRequest,
	"receiving-code-review": BookOpen, "writing-skills": PencilLine,
};

interface Props {
	onSend: (prompt: string, options: { skillId?: string; attachments?: string[] }) => Promise<void>;
	onStop: () => void;
	onOpenSettings: () => void;
	onPickFolder: () => Promise<string | null>;
	onPickFiles: () => Promise<string[]>;
	onWorkspaceChange: (path: string) => void;
	onProfileModelChange: (profileId: string, model: string) => void;
	onModeChange: (mode: "act" | "plan") => void;
	onGoalChange: (goal: string) => void;
	busy: boolean;
	model: string;
	profileId: string;
	profiles: ApiProfilePayload[];
	kind: "work" | "chat";
	workspace: string;
	projects: ProjectListItemPayload[];
	mode: "act" | "plan";
	goal: string;
	workspaceLocked: boolean;
}

function folderName(path: string): string { return path.split(/[\\/]/).filter(Boolean).pop() || path; }

export function ChatInputBar({ onSend, onStop, onOpenSettings, onPickFolder, onPickFiles, onWorkspaceChange, onProfileModelChange, onModeChange, onGoalChange, busy, model, profileId, profiles, kind, workspace, projects, mode, goal, workspaceLocked }: Props) {
	const [text, setText] = useState("");
	const [menu, setMenu] = useState<"add" | "workspace" | "model" | "goal" | null>(null);
	const [goalDraft, setGoalDraft] = useState(goal);
	const [attachments, setAttachments] = useState<string[]>([]);
	const [skillId, setSkillId] = useState<string | undefined>();
	const [error, setError] = useState<string | null>(null);
	const [sending, setSending] = useState(false);
	const ref = useRef<HTMLTextAreaElement>(null);
	const root = useRef<HTMLDivElement>(null);

	useEffect(() => { setGoalDraft(goal); }, [goal]);
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = Math.min(el.scrollHeight, 230) + "px";
	}, [text]);
	useEffect(() => {
		if (!menu) return;
		const outside = (event: PointerEvent) => { if (root.current && !root.current.contains(event.target as Node)) setMenu(null); };
		const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setMenu(null); };
		window.addEventListener("pointerdown", outside);
		window.addEventListener("keydown", escape);
		return () => { window.removeEventListener("pointerdown", outside); window.removeEventListener("keydown", escape); };
	}, [menu]);

	const submit = async () => {
		const value = text.trim();
		if (!value || busy || sending) return;
		setSending(true);
		setError(null);
		try {
			await onSend(value, { skillId, attachments });
			setText(""); setSkillId(undefined); setAttachments([]);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally { setSending(false); }
	};
	const chooseFolder = async (asAttachment: boolean) => {
		try {
			const path = await onPickFolder();
			if (path) {
				if (asAttachment) setAttachments((current) => [...new Set([...current, path])].slice(0, 8));
				else onWorkspaceChange(path);
			}
			setMenu(null);
		} catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
	};

	return (
		<div className="composer" ref={root}>
			<div className="composer-inner">
				<div className="composer-box">
					{(attachments.length > 0 || skillId) && <div className="composer-chips">
						{attachments.map((path) => <span className="composer-chip" key={path} title={path}><FolderOpen size={12} /> {folderName(path)} <button aria-label={`移除 ${path}`} onClick={() => setAttachments((items) => items.filter((item) => item !== path))}><X size={12} /></button></span>)}
						{skillId && <span className="composer-chip"><Plus size={12} /> {BUILTIN_SKILLS.find((item) => item.id === skillId)?.label ?? skillId} <button aria-label="移除技能" onClick={() => setSkillId(undefined)}><X size={12} /></button></span>}
					</div>}
					<textarea ref={ref} autoFocus value={text} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); } }} rows={2} placeholder={busy ? "正在回复…" : kind === "chat" ? "开始聊天…" : "描述你的任务，或输入你想修改的内容…"} disabled={busy} />
					<div className="composer-bar">
						{kind === "work" ? <><button className="composer-icon" title="添加文件、目标、技能" aria-expanded={menu === "add"} onClick={() => setMenu(menu === "add" ? null : "add")}><Plus size={19} /></button>
						<button className="composer-location" title={workspace || "选择访问位置"} onClick={() => setMenu(menu === "workspace" ? null : "workspace")}><Folder size={14} /><span>{workspace ? folderName(workspace) : "选择访问位置"}</span><ChevronDown size={13} /></button>
						{mode === "plan" && <button className="composer-plan-pill" onClick={() => onModeChange("act")} title="关闭计划模式"><Lightbulb size={13} /> 计划模式 <X size={11} /></button>}</> : <span className="composer-chat-pill"><MessageSquareText size={14} /> Chat · 仅文字</span>}
						<span className="composer-spacer" />
						<button className="composer-model" onClick={() => setMenu(menu === "model" ? null : "model")} title="选择模型">{profiles.find((item) => item.id === profileId)?.name ? `${profiles.find((item) => item.id === profileId)?.name} · ` : ""}{model || "选择模型"}<ChevronDown size={13} /></button>
						{busy ? <button className="composer-send stop" onClick={onStop} title="停止任务"><Square size={15} /></button> : <button className="composer-send" onClick={() => void submit()} disabled={!text.trim() || sending} title="发送"><Send size={17} /></button>}
					</div>
				</div>
				{error && <div className="composer-error" role="alert">{error}</div>}
				{kind === "work" && menu === "add" && <div className="composer-popover add-menu">
					<div className="popover-label">添加</div>
					<button onClick={async () => { try { const paths = await onPickFiles(); setAttachments((current) => [...new Set([...current, ...paths])].slice(0, 8)); setMenu(null); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }}><FilePlus2 size={17} /> 文件</button>
					<button onClick={() => void chooseFolder(true)}><FolderOpen size={17} /> 文件夹</button>
					<button onClick={() => { setGoalDraft(goal); setMenu("goal"); }}><Target size={17} /> 目标 <small>{goal ? "已设置" : "设置持续追求的目标"}</small></button>
					<button onClick={() => { onModeChange(mode === "plan" ? "act" : "plan"); setMenu(null); }}><Lightbulb size={17} /> 计划模式 <small>{mode === "plan" ? "已开启" : "先计划，再动手"}</small></button>
					<div className="popover-label skills-label">内置技能 · {BUILTIN_SKILLS.length}</div>
						<div className="skill-list">{BUILTIN_SKILLS.map((skill) => { const Icon = SKILL_ICONS[skill.id] ?? Blocks; return <button key={skill.id} onClick={() => { setSkillId(skill.id); setMenu(null); }}><span className="skill-badge"><Icon size={17} strokeWidth={1.8} /></span><span><strong>{skill.label}</strong><small>{skill.description}</small></span>{skillId === skill.id && <Check size={14} />}</button>; })}</div>
				</div>}
				{kind === "work" && menu === "workspace" && <div className="composer-popover chooser-menu"><div className="popover-label">访问位置</div>{workspace && <div className="current-path" title={workspace}>{workspace}</div>}{!workspaceLocked && <><button onClick={() => void chooseFolder(false)}><FolderOpen size={16} /> 浏览文件夹…</button><div className="popover-label">最近项目</div>{projects.map((project) => <button key={project.id} onClick={() => { onWorkspaceChange(project.workspaceRoot); setMenu(null); }}><Folder size={16} /> {project.name || folderName(project.workspaceRoot)}</button>)}<input type="text" placeholder="或粘贴绝对路径" value={workspace} onChange={(event) => onWorkspaceChange(event.target.value)} /></>}{workspaceLocked && <div className="popover-note">现有对话的工作区固定。请在项目下新建对话来切换位置。</div>}</div>}
				{menu === "model" && <div className="composer-popover chooser-menu model-menu"><div className="popover-label">选择模型</div>{profiles.map((profile) => <div key={profile.id} className="model-group"><div className="model-group-name">{profile.name}{!profile.hasApiKey && <small>未配置 Key</small>}</div>{profile.models.map((item) => <button key={`${profile.id}/${item}`} className="model-option" onClick={() => { onProfileModelChange(profile.id, item); setMenu(null); }}><span>{item}</span>{profileId === profile.id && model === item && <Check size={15} />}</button>)}</div>)}<button onClick={() => { setMenu(null); onOpenSettings(); }}><Settings size={15} /> 管理 API 与模型</button></div>}
				{menu === "goal" && <div className="composer-popover chooser-menu goal-menu"><div className="popover-label">持续目标</div><textarea value={goalDraft} onChange={(event) => setGoalDraft(event.target.value)} placeholder="写下这个对话要持续追求的目标" rows={3} /><button onClick={() => { onGoalChange(goalDraft.trim()); setMenu(null); }}><Check size={15} /> 保存目标</button>{goal && <button onClick={() => { onGoalChange(""); setGoalDraft(""); setMenu(null); }}><X size={15} /> 清除目标</button>}</div>}
			</div>
		</div>
	);
}
