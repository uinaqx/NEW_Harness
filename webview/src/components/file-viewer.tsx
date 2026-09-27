import { useEffect, useState } from "react";
import { FileCode2, Loader2, X } from "lucide-react";
import { desktopClient } from "@/lib/desktop-client";

export function FileViewer({ sessionId, file, onClose }: { sessionId: string; file: string; onClose: () => void }) {
	const [data, setData] = useState<{ content: string; truncated: boolean } | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		let active = true;
		setData(null); setError(null);
		void desktopClient.invoke<{ content: string; truncated: boolean }>("read_workspace_file", { sessionId, file }).then((result) => { if (active) setData(result); }).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
		return () => { active = false; };
	}, [sessionId, file]);
	return <aside className="file-viewer" aria-label="项目文件预览">
		<header><FileCode2 size={15} /><strong title={file}>{file}</strong><button type="button" aria-label="关闭文件预览" onClick={onClose}><X size={16} /></button></header>
		{error ? <p className="file-viewer-message">{error}</p> : !data ? <p className="file-viewer-message"><Loader2 size={14} className="spin" />正在打开文件…</p> : <>
			{data.truncated && <p className="file-viewer-message">文件较大，仅展示前 1 MB。</p>}
			<pre className="file-viewer-code">{data.content.split("\n").map((line, index) => <span className="file-source-line" key={index}><span className="file-line-number" aria-hidden="true">{index + 1}</span><code>{line || " "}</code></span>)}</pre>
		</>}
	</aside>;
}
