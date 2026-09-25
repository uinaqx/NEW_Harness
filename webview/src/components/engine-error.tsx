import { useState } from "react";
import { AlertTriangle, Loader2, RefreshCw, Stethoscope } from "lucide-react";
import type { EngineStatusPayload } from "@/lib/chat-schema";

interface Props {
	engine: EngineStatusPayload;
	onRetry: () => void;
	onDiagnostics: () => Promise<string>;
	retrying: boolean;
}

/**
 * Shown instead of an endless loading state: the engine failed to start, so the
 * user gets the reason, a retry button and the diagnostics entry point.
 */
export function EngineError({ engine, onRetry, onDiagnostics, retrying }: Props) {
	const [diagnostics, setDiagnostics] = useState<string | null>(null);
	const [loadingDiagnostics, setLoadingDiagnostics] = useState(false);

	return (
		<div className="engine-error" role="alert">
			<div className="ee-icon">
				<AlertTriangle size={22} />
			</div>
			<h2>执行引擎未就绪</h2>
			<p>{engine.lastError ?? "OpenCode 引擎启动失败，当前无法执行任务。"}</p>
			<dl className="ee-facts">
				<div>
					<dt>状态</dt>
					<dd>{engine.state}</dd>
				</div>
				<div>
					<dt>引擎版本</dt>
					<dd>{engine.version}</dd>
				</div>
				<div>
					<dt>二进制</dt>
					<dd>{engine.binary?.path ?? "未找到"}</dd>
				</div>
				<div>
					<dt>校验</dt>
					<dd>{engine.binary ? (engine.binary.verified ? "SHA-256 已通过" : "未通过（未经验证）") : "—"}</dd>
				</div>
				<div>
					<dt>重启次数</dt>
					<dd>{engine.restarts}</dd>
				</div>
			</dl>
			<div className="ee-actions">
				<button className="btn btn-primary" onClick={onRetry} disabled={retrying}>
					{retrying ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} 重试启动
				</button>
				<button
					className="btn"
					disabled={loadingDiagnostics}
					onClick={async () => {
						setLoadingDiagnostics(true);
						try {
							setDiagnostics(await onDiagnostics());
						} finally {
							setLoadingDiagnostics(false);
						}
					}}
				>
					{loadingDiagnostics ? <Loader2 size={14} className="spin" /> : <Stethoscope size={14} />} 查看诊断
				</button>
			</div>
			{diagnostics && (
				<pre className="ee-diagnostics" aria-label="引擎诊断信息">
					{diagnostics}
				</pre>
			)}
		</div>
	);
}
