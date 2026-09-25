import { useMemo, useState } from "react";
import { FileCode2, FilePlus2, FileX2, Loader2, RefreshCw, X } from "lucide-react";
import type { FileDiffEntryPayload } from "@/lib/chat-schema";

interface Props {
	open: boolean;
	diffs: FileDiffEntryPayload[];
	stale: boolean;
	loading: boolean;
	onClose: () => void;
	onRefresh: () => void;
}

/** Colourises a unified diff without adding a diff library. */
function DiffBody({ patch }: { patch: string }) {
	const lines = patch.split("\n");
	return (
		<pre className="diff-body">
			{lines.map((line, index) => {
				let kind = "ctx";
				if (line.startsWith("+++") || line.startsWith("---")) kind = "meta";
				else if (line.startsWith("@@")) kind = "hunk";
				else if (line.startsWith("+")) kind = "add";
				else if (line.startsWith("-")) kind = "del";
				else if (line.startsWith("Index:") || line.startsWith("====")) kind = "meta";
				return (
					<div key={index} className={`diff-line diff-${kind}`}>
						<span className="diff-gutter">{kind === "add" ? "+" : kind === "del" ? "−" : " "}</span>
						<span className="diff-text">{line.replace(/^[+\- ]/, "")}</span>
					</div>
				);
			})}
		</pre>
	);
}

function statusIcon(status: FileDiffEntryPayload["status"]) {
	if (status === "added") return <FilePlus2 size={13} />;
	if (status === "deleted") return <FileX2 size={13} />;
	return <FileCode2 size={13} />;
}

export function DiffPanel({ open, diffs, stale, loading, onClose, onRefresh }: Props) {
	const [selected, setSelected] = useState<string | null>(null);
	const active = useMemo(() => diffs.find((diff) => diff.file === selected) ?? diffs[0], [diffs, selected]);

	if (!open) return null;

	return (
		<aside className="diff-panel" aria-label="文件差异">
			<header>
				<strong>文件差异</strong>
				<span className="diff-count">{diffs.length} 个文件</span>
				<span style={{ flex: 1 }} />
				{stale && <span className="diff-stale">有新变更</span>}
				<button className="btn" onClick={onRefresh} disabled={loading} title="重新读取差异">
					{loading ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
				</button>
				<button className="btn" onClick={onClose} aria-label="关闭差异面板">
					<X size={13} />
				</button>
			</header>
			{diffs.length === 0 ? (
				<div className="diff-empty">当前会话还没有文件变更，或引擎尚未记录差异。</div>
			) : (
				<div className="diff-split">
					<ul className="diff-files">
						{diffs.map((diff) => (
							<li key={diff.file}>
								<button data-active={(active?.file ?? diffs[0]?.file) === diff.file} onClick={() => setSelected(diff.file)}>
									{statusIcon(diff.status)}
									<span className="diff-file-name" title={diff.file}>
										{diff.file.split(/[\\/]/).pop()}
									</span>
									<span className="diff-stat">
										<b className="add">+{diff.additions}</b> <b className="del">−{diff.deletions}</b>
									</span>
								</button>
							</li>
						))}
					</ul>
					<div className="diff-detail">
						<div className="diff-path">{active?.file}</div>
						<div className="diff-status">状态：{active?.status ?? "未知"}</div>
						{active?.patch ? <DiffBody patch={active.patch} /> : <div className="diff-empty">{active?.unavailable ?? "无文本差异可展示。"}</div>}
					</div>
				</div>
			)}
		</aside>
	);
}
