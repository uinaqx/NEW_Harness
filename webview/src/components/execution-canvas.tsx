import { Check, Circle, Loader2, Terminal, X, FileText, Search, Pencil, ShieldQuestion } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { ChatMessage, ChatSessionStatus } from "@/lib/chat-schema";
import { executionCapacity, executionOutcome, executionPayload, executionFailed } from "@/lib/execution-window";
import type { ToolApprovalRequestItem } from "@/hooks/chat-session/types";

const COLLAPSE_HOLD_MS = 1200;
/** Hold time plus the CSS transition length (300ms) before the track is cleared. */
const CLEAR_AFTER_MS = COLLAPSE_HOLD_MS + 300;

export function ExecutionCanvas({
	messages,
	status,
	sessionId,
	approvals,
	onCapacity,
	onClear,
	onApprove,
	onReject,
}: {
	messages: ChatMessage[];
	status: ChatSessionStatus;
	sessionId: string | null;
	approvals: ToolApprovalRequestItem[];
	onCapacity: (capacity: number) => void;
	onClear: () => void;
	onApprove: (requestId: string) => void;
	onReject: (requestId: string) => void;
}) {
	const root = useRef<HTMLDivElement>(null);
	const gradientId = useId().replace(/:/g, "");
	const [maxHeight, setMaxHeight] = useState<number>();
	const [open, setOpen] = useState(false);
	const [selected, setSelected] = useState<string | null>(null);
	const [now, setNow] = useState(Date.now());
	const busy = ["starting", "running", "stopping"].includes(status) || approvals.length > 0;
	const steps = messages.filter((message) => message.role === "tool");
	const detail = steps.find((message) => message.id === selected);
	const detailApproval = approvals.find((item) => item.toolCallId === detail?.meta?.toolCallId);

	// A new session starts with an empty canvas: history is not replayed.
	useEffect(() => {
		setSelected(null);
		setOpen(false);
	}, [sessionId]);

	useEffect(() => {
		if (busy) {
			setOpen(true);
			return;
		}
		const collapse = setTimeout(() => setOpen(false), COLLAPSE_HOLD_MS);
		const clear = setTimeout(() => {
			onClear();
			setSelected(null);
		}, CLEAR_AFTER_MS);
		return () => {
			clearTimeout(collapse);
			clearTimeout(clear);
		};
	}, [busy, onClear, sessionId]);

	// Close the detail panel when its node was evicted by the width budget.
	useEffect(() => {
		if (selected && !steps.some((message) => message.id === selected)) setSelected(null);
	}, [steps, selected]);

	useEffect(() => {
		if (!root.current) return;
		const observer = new ResizeObserver(() => {
			onCapacity(executionCapacity(root.current?.getBoundingClientRect().width ?? 0));
			setMaxHeight((root.current?.closest("main")?.getBoundingClientRect().height ?? window.innerHeight) * 0.4);
		});
		observer.observe(root.current);
		if (root.current.closest("main")) observer.observe(root.current.closest("main")!);
		return () => observer.disconnect();
	}, [onCapacity]);

	useEffect(() => {
		if (!busy) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [busy]);

	return (
		<section ref={root} className="harness-execution" data-open={open} aria-label="实时执行画布" aria-hidden={!open} inert={!open}>
			<div className="harness-execution-inner" style={{ maxHeight }}>
				<header>
					<span>
						<Circle size={7} fill="currentColor" /> {busy ? "正在执行" : status === "completed" ? "执行完成" : "执行已结束"}
					</span>
					<span>仅显示最新步骤</span>
				</header>
				<div className="harness-node-track">
					{steps.length === 0 ? (
						<div className="harness-wait">
							<Loader2 size={16} className="animate-spin" />
							正在连接模型，等待下一步
						</div>
					) : (
						steps.map((step, index) => {
							const payload = executionPayload(step);
							const approval = approvals.find((item) => item.toolCallId === step.meta?.toolCallId);
							const live = step.meta?.phase === "running" || step.meta?.phase === "pending" || step.meta?.hookEventName === "tool_call_start";
							const running = live && busy && !approval;
							const interrupted = !busy && live;
							const failed = executionFailed(payload) || interrupted;
							const name = step.meta?.toolName ?? "工具";
							const Icon = /read|file/.test(name) ? FileText : /search|grep|list/.test(name) ? Search : /write|edit|patch/.test(name) ? Pencil : Terminal;
							const State = approval ? ShieldQuestion : running ? Loader2 : failed ? X : Check;
							const label = executionOutcome(step, running, interrupted, !!approval);
							const timing = running
								? ` · ${Math.max(0, Math.floor((now - step.createdAt) / 1000))}s`
								: step.meta?.durationMs !== undefined
									? ` · ${(step.meta.durationMs / 1000).toFixed(1)}s`
									: "";
							return (
								<div className="harness-node-group" key={step.id}>
									{index > 0 && (
										<svg className="harness-connector" viewBox="0 0 32 8" aria-hidden="true">
											<defs>
												<linearGradient id={`${gradientId}-${index}`}>
													<stop stopColor="currentColor" stopOpacity="0" />
													<stop offset="1" stopColor="currentColor" />
												</linearGradient>
											</defs>
											<path d="M0 4H32" />
											<path style={{ stroke: `url(#${gradientId}-${index})` }} className={busy ? "harness-flow" : ""} d="M0 4H32" />
										</svg>
									)}
									<button
										type="button"
										className="harness-node"
										data-active={running}
										data-state={approval ? "approval" : failed ? "failed" : "done"}
										onClick={() => setSelected(selected === step.id ? null : step.id)}
										aria-expanded={selected === step.id}
									>
										<span className="harness-node-top">
											<Icon size={18} />
											<State size={14} className={running && !approval ? "animate-spin" : ""} />
										</span>
										<strong>{name}</strong>
										<span>
											{label}
											{timing}
										</span>
									</button>
								</div>
							);
						})
					)}
				</div>
				{detail && (
					<aside className="harness-node-detail" aria-label="工具详情">
						<button type="button" aria-label="关闭工具详情" onClick={() => setSelected(null)}>
							<X size={16} />
						</button>
						<strong>
							{detail.meta?.toolName}
							{detail.meta?.exitCode !== undefined ? ` · 退出码 ${detail.meta.exitCode}` : ""}
						</strong>
						<pre>{detailApproval?.summary && (!detail.content || detail.content === '{"input":{}}') ? detailApproval.summary : detail.content}{detail.meta?.toolOutput ? `\n\n${detail.meta.toolOutput}` : ""}</pre>
					</aside>
				)}
				{approvals.map((approval) => (
					<div className="harness-approval" key={approval.requestId}>
						<ShieldQuestion size={16} />
						<div className="approval-text">
							<strong>允许执行 {approval.toolName}？</strong>
							<span className="approval-summary">{approval.summary ?? "引擎请求授权"}</span>
						</div>
						<button type="button" onClick={() => onReject(approval.requestId)}>
							拒绝
						</button>
						<button type="button" className="btn-primary" onClick={() => onApprove(approval.requestId)}>
							允许本次
						</button>
					</div>
				))}
			</div>
		</section>
	);
}
