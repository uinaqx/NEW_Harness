import { useEffect, useState } from "react";
import { ChevronDown, Clock3, FileDiff } from "lucide-react";
import type { ChatSessionStatus, ChatSummary, FileDiffEntryPayload } from "@/lib/chat-schema";
import { formatDuration } from "@/lib/execution-window";

export function TaskResult({ startedAt, endedAt, busy, status, summary, hasUsage, diffs, onOpenFile, onReview }: {
	startedAt: number | null; endedAt: number | null; busy: boolean; status: ChatSessionStatus;
	summary: ChatSummary; hasUsage: boolean; diffs: FileDiffEntryPayload[];
	onOpenFile: (file: string) => void; onReview: () => void;
}) {
	const [now, setNow] = useState(Date.now());
	const [expanded, setExpanded] = useState(false);
	useEffect(() => { setExpanded(false); }, [startedAt]);
	useEffect(() => {
		if (!busy) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [busy]);
	if (!startedAt) return null;
	const duration = formatDuration((busy ? now : endedAt ?? now) - startedAt);
	const additions = diffs.reduce((total, diff) => total + diff.additions, 0);
	const deletions = diffs.reduce((total, diff) => total + diff.deletions, 0);
	const totalTokens = summary.tokensIn + summary.tokensOut + (summary.cacheReadTokens ?? 0);
	const visible = expanded ? diffs : diffs.slice(0, 3);
	const outcome = status === "error" ? "任务失败" : status === "cancelled" ? "任务已停止" : "任务结束";
	return <div className="task-result">
		{!busy && diffs.length > 0 && <section className="task-changes" aria-label="本轮文件修改">
			<header><FileDiff size={20} /><div><strong>已修改 {diffs.length} 个文件</strong><span className="code-stat"><b className="code-add">+{additions}</b><b className="code-delete">−{deletions}</b></span></div><button type="button" onClick={onReview}>查看差异</button></header>
			<div className="task-file-list">{visible.map((diff) => <button type="button" key={diff.file} onClick={() => onOpenFile(diff.file)} title={`打开 ${diff.file}`}><span>{diff.file}</span><span className="code-stat"><b className="code-add">+{diff.additions}</b><b className="code-delete">−{diff.deletions}</b></span></button>)}</div>
			{diffs.length > 3 && <button type="button" className="task-show-files" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "收起文件列表" : `再显示 ${diffs.length - 3} 个文件`}<ChevronDown size={14} style={{ transform: expanded ? "rotate(180deg)" : undefined }} /></button>}
		</section>}
		<div className="task-telemetry" aria-live="off"><Clock3 size={12} /><span>{busy ? `任务已持续 ${duration}` : `${outcome} · 耗时 ${duration}`}</span><span className="telemetry-separator">·</span><span title={`输入 ${summary.tokensIn} · 输出 ${summary.tokensOut} · 缓存读取 ${summary.cacheReadTokens ?? 0}`}>{hasUsage ? `${totalTokens.toLocaleString("zh-CN")} Token` : busy ? "等待 Token 用量" : "模型未返回 Token 用量"}</span></div>
	</div>;
}
