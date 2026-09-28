import { useEffect, useState } from "react";
import { ExternalLink, FileCode2, FolderOpen, Loader2, MonitorPlay, X } from "lucide-react";
import { desktopClient } from "@/lib/desktop-client";

export function FileViewer({ sessionId, file, onClose }: { sessionId: string; file: string; onClose: () => void }) {
	const [data, setData] = useState<{ content: string; truncated: boolean; previewUrl?: string } | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [view, setView] = useState<"code" | "preview">("code");
	const previewable = /\.(html?|svg)$/i.test(file);
	const openNative = async (command: "open_workspace_file" | "open_workspace_folder") => {
		try { await desktopClient.invoke(command, { sessionId, file }); }
		catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
	};
	useEffect(() => {
		let active = true;
		setData(null); setError(null); setView("code");
		void desktopClient.invoke<{ content: string; truncated: boolean; previewUrl?: string }>("read_workspace_file", { sessionId, file }).then((result) => { if (active) setData(result); }).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
		return () => { active = false; };
	}, [sessionId, file]);
	return <aside className="file-viewer" aria-label="项目文件预览">
		<header><FileCode2 size={15} /><strong title={file}>{file}</strong><button type="button" aria-label="打开文件" title="在默认程序中打开文件" onClick={() => void openNative("open_workspace_file")}><ExternalLink size={16} /></button><button type="button" aria-label="打开所在文件夹" title="打开所在文件夹" onClick={() => void openNative("open_workspace_folder")}><FolderOpen size={16} /></button><button type="button" aria-label="关闭文件预览" onClick={onClose}><X size={16} /></button></header>
		{error ? <p className="file-viewer-message">{error}</p> : !data ? <p className="file-viewer-message"><Loader2 size={14} className="spin" />正在打开文件…</p> : <>
			{data.truncated && <p className="file-viewer-message">文件较大，仅展示前 1 MB。</p>}
			{previewable && <div className="file-view-tabs"><button type="button" aria-pressed={view === "code"} onClick={() => setView("code")}><FileCode2 size={14} /> 代码</button><button type="button" aria-pressed={view === "preview"} onClick={() => setView("preview")}><MonitorPlay size={14} /> 在线预览</button></div>}
			{view === "preview" && previewable ? <iframe className="file-live-preview" title={`${file} 成品预览`} sandbox="allow-scripts" referrerPolicy="no-referrer" src={data.previewUrl} srcDoc={data.previewUrl ? undefined : data.content} /> : <pre className="file-viewer-code">{data.content.split("\n").map((line, index) => <span className="file-source-line" key={index}><span className="file-line-number" aria-hidden="true">{index + 1}</span><code>{line || " "}</code></span>)}</pre>}
		</>}
	</aside>;
}
