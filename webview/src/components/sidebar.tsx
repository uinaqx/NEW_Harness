import { useEffect, useMemo, useRef, useState } from "react";
import { Archive, ChevronDown, ChevronRight, Folder, FolderPlus, MessageCircle, MessageSquarePlus, Moon, MoreHorizontal, Pin, PinOff, Plus, Settings, Sun, Trash2, Pencil } from "lucide-react";
import type { ChatSessionStatus, ProjectListItemPayload, SessionListItemPayload } from "@/lib/chat-schema";
import { BrandMark } from "@/components/brand-mark";

interface Props {
	sessions: SessionListItemPayload[];
	projects: ProjectListItemPayload[];
	activeId: string | null;
	activeWorkspace?: string;
	onSelect: (id: string) => void;
	onNew: (workspaceRoot?: string) => void;
	onNewChat: () => void;
	onNewProject: () => void;
	onOpenSettings: () => void;
	onDelete: (id: string) => Promise<void>;
	onRename: (id: string, title: string) => Promise<void>;
	onPin: (id: string, pinned: boolean) => Promise<void>;
	onRenameProject: (id: string, name: string) => Promise<void>;
	onActionError: (error: unknown) => void;
	theme: "dark" | "light";
	onToggleTheme: () => void;
	status: ChatSessionStatus;
}

function folderName(path: string): string { return path.split(/[\\/]/).filter(Boolean).pop() || path; }

export function Sidebar({ sessions, projects, activeId, activeWorkspace, onSelect, onNew, onNewChat, onNewProject, onOpenSettings, onDelete, onRename, onPin, onRenameProject, onActionError, theme, onToggleTheme, status }: Props) {
	const [expanded, setExpanded] = useState<Record<string, boolean>>({});
	const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
	const [editing, setEditing] = useState<{ kind: "session" | "project"; id: string; text: string } | null>(null);
	const savingRef = useRef(false);
	const grouped = useMemo(() => {
		const result = new Map<string, SessionListItemPayload[]>();
		for (const session of sessions.filter((item) => item.kind !== "chat")) {
			const key = session.workspaceRoot.toLocaleLowerCase();
			const list = result.get(key) ?? [];
			list.push(session);
			result.set(key, list);
		}
		return result;
	}, [sessions]);
	const pinned = sessions.filter((session) => session.pinned && session.kind !== "chat");
	const chatSessions = sessions.filter((session) => session.kind === "chat").sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt - a.updatedAt);
	const selectedMenu = sessions.find((session) => session.id === menu?.id);

	useEffect(() => {
		if (!menu) return;
		const close = () => setMenu(null);
		window.addEventListener("pointerdown", close);
		window.addEventListener("keydown", close);
		return () => { window.removeEventListener("pointerdown", close); window.removeEventListener("keydown", close); };
	}, [menu]);

	const saveEdit = async () => {
		if (!editing || savingRef.current) return;
		const value = editing.text.trim();
		if (!value) { setEditing(null); return; }
		savingRef.current = true;
		try {
			if (editing.kind === "session") await onRename(editing.id, value);
			else await onRenameProject(editing.id, value);
			setEditing(null);
		} catch (error) {
			onActionError(error);
		} finally {
			savingRef.current = false;
		}
	};

	const renderSession = (entry: SessionListItemPayload) => (
		<div key={entry.id} className="sidebar-chat" data-active={entry.id === activeId} onContextMenu={(event) => { event.preventDefault(); setMenu({ id: entry.id, x: event.clientX, y: event.clientY }); }}>
			{editing?.kind === "session" && editing.id === entry.id ? (
				<input autoFocus className="sidebar-rename" value={editing.text} onChange={(event) => setEditing({ ...editing, text: event.target.value })} onBlur={() => void saveEdit()} onKeyDown={(event) => { if (event.key === "Enter") void saveEdit(); if (event.key === "Escape") setEditing(null); }} />
			) : (
				<button className="sidebar-chat-select" onClick={() => onSelect(entry.id)} title={`${entry.title} · ${entry.workspaceRoot}`}>
					<span className="sidebar-chat-title">{entry.title && entry.title !== "新会话" ? entry.title : entry.lastMessage || "新对话"}</span>
					{entry.legacy && <Archive size={12} aria-label="只读历史" />}
					<span className="si-status" data-status={entry.id === activeId ? status : entry.status} />
				</button>
			)}
			<button className="sidebar-more" aria-label={`管理 ${entry.title}`} onClick={(event) => { event.stopPropagation(); const box = event.currentTarget.getBoundingClientRect(); setMenu({ id: entry.id, x: box.right, y: box.bottom }); }}><MoreHorizontal size={15} /></button>
		</div>
	);

	return (
		<aside className="app-sidebar">
			<div className="sidebar-brand"><BrandMark size={28} /><strong>某科学的Agent</strong></div>
			<nav className="sidebar-primary" aria-label="主导航">
				<button onClick={() => onNew()}><MessageSquarePlus size={17} /> Work 新对话 <span className="sidebar-shortcut">Ctrl N</span></button>
				<button onClick={onNewChat}><MessageCircle size={17} /> Chat 开聊</button>
				<button onClick={onNewProject}><FolderPlus size={17} /> 新建项目</button>
			</nav>
			<div className="sidebar-list">
				{pinned.length > 0 && <section className="sidebar-section"><div className="sidebar-section-label"><Pin size={12} /> 已置顶</div>{pinned.map(renderSession)}</section>}
				<section className="sidebar-section">
					<div className="sidebar-section-label"><span>项目</span><button onClick={onNewProject} title="添加项目"><Plus size={14} /></button></div>
					{projects.length === 0 && <div className="sidebar-empty">添加文件夹后，就能在同一项目中建立多个对话。</div>}
					{projects.map((project) => {
						const entries = (grouped.get(project.workspaceRoot.toLocaleLowerCase()) ?? []).filter((entry) => !entry.pinned);
						const isOpen = expanded[project.id] !== false;
						return <div key={project.id} className="sidebar-project">
							<div className="sidebar-project-head">
								<button className="sidebar-project-toggle" onClick={() => setExpanded((value) => ({ ...value, [project.id]: !isOpen }))} title={project.workspaceRoot}>
									{isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<Folder size={15} />
									{editing?.kind === "project" && editing.id === project.id ? null : <span>{project.name || folderName(project.workspaceRoot)}</span>}
								</button>
								<button className="sidebar-project-add" onClick={() => onNew(project.workspaceRoot)} title="在此项目中新建对话"><Plus size={14} /></button>
							</div>
							{editing?.kind === "project" && editing.id === project.id && <input autoFocus className="sidebar-rename project-edit" value={editing.text} onChange={(event) => setEditing({ ...editing, text: event.target.value })} onBlur={() => void saveEdit()} onKeyDown={(event) => { if (event.key === "Enter") void saveEdit(); if (event.key === "Escape") setEditing(null); }} />}
							{isOpen && <div className="sidebar-project-chats">{entries.map(renderSession)}{entries.length === 0 && <button className="sidebar-project-empty" onClick={() => onNew(project.workspaceRoot)}>{activeWorkspace === project.workspaceRoot ? "输入消息即可开始" : "新建对话"}</button>}</div>}
						<button className="sidebar-project-rename" onClick={() => setEditing({ kind: "project", id: project.id, text: project.name || folderName(project.workspaceRoot) })} title="重命名项目"><Pencil size={12} /></button>
					</div>;
					})}
					</section>
			</div>
			<section className="sidebar-section sidebar-chat-section">
					<div className="sidebar-section-label"><span>Chat · 纯对话</span><button onClick={onNewChat} title="开始新聊天"><Plus size={14} /></button></div>
					{chatSessions.length ? chatSessions.map(renderSession) : <button className="sidebar-project-empty" onClick={onNewChat}>点击开聊，无需选择工作区</button>}
			</section>
			<div className="sidebar-footer">
				<button onClick={onToggleTheme} title={theme === "dark" ? "切换浅色模式" : "切换深色模式"}>{theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}{theme === "dark" ? "浅色模式" : "深色模式"}</button>
				<button onClick={onOpenSettings} title="设置"><Settings size={16} /> 设置</button>
			</div>
			{selectedMenu && menu && <div className="sidebar-context-menu" style={{ left: Math.min(menu.x, window.innerWidth - 190), top: Math.min(menu.y, window.innerHeight - 140) }} onPointerDown={(event) => event.stopPropagation()} role="menu">
				<button role="menuitem" onClick={() => { setEditing({ kind: "session", id: selectedMenu.id, text: selectedMenu.title }); setMenu(null); }}><Pencil size={14} /> 重命名</button>
				<button role="menuitem" onClick={() => { void onPin(selectedMenu.id, !selectedMenu.pinned).catch(onActionError); setMenu(null); }}>{selectedMenu.pinned ? <PinOff size={14} /> : <Pin size={14} />}{selectedMenu.pinned ? "取消置顶" : "置顶"}</button>
				<button role="menuitem" className="danger" onClick={() => { setMenu(null); if (window.confirm(selectedMenu.legacy ? "从列表移除这条只读历史？" : "删除此对话及引擎中的记录？")) void onDelete(selectedMenu.id).catch(onActionError); }}><Trash2 size={14} /> 删除</button>
			</div>}
		</aside>
	);
}
