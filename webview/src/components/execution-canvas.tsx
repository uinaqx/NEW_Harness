import { Brain, Check, Circle, Loader2, Terminal, X, FileText, Search, Pencil, ShieldQuestion } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ChatMessage, ChatSessionStatus } from "@/lib/chat-schema";
import { currentTurnSteps, executionCapacity, executionDescription, executionExplanation, executionMetrics, executionOutcome, executionPayload, executionFailed, formatDuration, splitExecutionSteps } from "@/lib/execution-window";
import type { AgentQuestionRequestItem, ToolApprovalRequestItem } from "@/lib/chat-schema";

const COLLAPSE_HOLD_MS = 1200;
/** Hold time plus the CSS transition length (300ms) before the track is cleared. */
const CLEAR_AFTER_MS = COLLAPSE_HOLD_MS + 300;

function StepMetrics({ step }: { step: ChatMessage }) {
	const metrics = executionMetrics(step);
	return <>{metrics.readLines !== undefined && <span className="read-lines">读取 {metrics.readLines} 行</span>}{metrics.additions !== undefined && <span className="code-stat"><b className="code-add">+{metrics.additions}</b><b className="code-delete">−{metrics.deletions ?? 0}</b></span>}</>;
}

export function QuestionDialog({ request, onAnswer }: { request: AgentQuestionRequestItem; onAnswer: (id: string, answers: string[][]) => Promise<void> }) {
	const [answers, setAnswers] = useState<string[][]>(() => request.questions.map(() => []));
	const [custom, setCustom] = useState<Record<number, string>>({});
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const complete = request.questions.every((question, index) => answers[index]?.length || (question.custom !== false && custom[index]?.trim()));
	return <div className="question-dialog-overlay"><div className="harness-question question-dialog" role="dialog" aria-modal="true" aria-label="AI 向你提问">
		<strong>需要你的回答</strong>
		{request.questions.map((question, index) => <fieldset key={`${request.requestId}-${index}`}><legend>{question.header || `问题 ${index + 1}`} · {question.question}</legend>
			<div className="question-options">{question.options.map((option) => { const active = answers[index]?.includes(option.label); return <button type="button" key={option.label} aria-pressed={active} onClick={() => { setAnswers((previous) => previous.map((value, at) => at !== index ? value : question.multiple ? (active ? value.filter((item) => item !== option.label) : [...value, option.label]) : [option.label])); if (!question.multiple) setCustom((previous) => ({ ...previous, [index]: "" })); }}><span>{option.label}</span><small>{option.description}</small></button>; })}</div>
			{question.custom !== false && <input aria-label={`${question.header || "问题"}的其他回答`} value={custom[index] ?? ""} onChange={(event) => { setCustom((previous) => ({ ...previous, [index]: event.target.value })); if (!question.multiple) setAnswers((previous) => previous.map((value, at) => at === index ? [] : value)); }} placeholder="或输入自己的回答" />}
		</fieldset>)}
		{error && <p role="alert">{error}</p>}
		<button type="button" className="btn-primary" disabled={!complete || submitting} onClick={async () => { setSubmitting(true); setError(null); try { await onAnswer(request.requestId, request.questions.map((question, index) => { const choice = answers[index] ?? []; const own = custom[index]?.trim(); return own && question.custom !== false ? [...choice, own] : choice; })); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setSubmitting(false); } }}>提交回答</button>
	</div></div>;
}

export function ExecutionCanvas({
	messages,
	status,
	sessionId,
	approvals,
	questions,
	startedAt,
	onApprove,
	onReject,
	onAnswer,
}: {
	messages: ChatMessage[];
	status: ChatSessionStatus;
	sessionId: string | null;
	approvals: ToolApprovalRequestItem[];
	questions: AgentQuestionRequestItem[];
	startedAt: number | null;
	onApprove: (requestId: string) => void;
	onReject: (requestId: string) => void;
	onAnswer: (requestId: string, answers: string[][]) => Promise<void>;
}) {
	const root = useRef<HTMLDivElement>(null);
	const archiveTrack = useRef<HTMLDivElement>(null);
	const currentTrack = useRef<HTMLDivElement>(null);
	const [maxHeight, setMaxHeight] = useState<number>();
	const [open, setOpen] = useState(false);
	const [selected, setSelected] = useState<string | null>(null);
	const [now, setNow] = useState(Date.now());
	const [capacity, setCapacity] = useState(6);
	const [archiveWidth, setArchiveWidth] = useState(700);
	const busy = ["starting", "running", "stopping"].includes(status) || approvals.length > 0 || questions.length > 0;
	const steps = currentTurnSteps(messages);
	const { archived, current } = splitExecutionSteps(messages, capacity, approvals.map((item) => item.toolCallId));
	const detail = steps.find((message) => message.id === selected);
	const detailApproval = approvals.find((item) => item.toolCallId === detail?.meta?.toolCallId);
	const available = Math.max(80, archiveWidth - 32);
	const maxVisible = Math.max(1, Math.floor((available - 42) / 27));
	const hiddenCount = Math.max(0, archived.length - maxVisible);
	const visibleCount = archived.length - hiddenCount;
	const compactCount = Math.min(visibleCount, Math.max(0, Math.ceil((visibleCount * 156 - available + (hiddenCount ? 42 : 0)) / 129)));
	useEffect(() => {
		if (!archiveTrack.current) return;
		const observer = new ResizeObserver(([entry]) => setArchiveWidth(entry.contentRect.width));
		observer.observe(archiveTrack.current);
		return () => observer.disconnect();
	}, [archived.length > 0]);
	useEffect(() => { if (currentTrack.current) currentTrack.current.scrollTop = currentTrack.current.scrollHeight; }, [steps.length]);

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
			setSelected(null);
		}, CLEAR_AFTER_MS);
		return () => {
			clearTimeout(collapse);
			clearTimeout(clear);
		};
	}, [busy, sessionId]);

	// Close the detail panel when its node was evicted by the height budget.
	useEffect(() => {
		if (selected && !steps.some((message) => message.id === selected)) setSelected(null);
	}, [steps, selected]);

	useEffect(() => {
		if (!root.current) return;
		const observer = new ResizeObserver(() => {
			const height = (root.current?.closest("main")?.getBoundingClientRect().height ?? window.innerHeight) * 0.4;
			setMaxHeight(height);
			setCapacity(executionCapacity(height, approvals.length));
		});
		observer.observe(root.current);
		if (root.current.closest("main")) observer.observe(root.current.closest("main")!);
		return () => observer.disconnect();
	}, [approvals.length]);

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
					<span>{startedAt && busy ? `已持续 ${formatDuration(now - startedAt)} · ` : ""}流程 {steps.length}</span>
				</header>
				{archived.length > 0 && <div ref={archiveTrack} className="harness-trace-archive" aria-label="较早的已结束流程">
					{hiddenCount > 0 && <span className="archive-hidden" title={`另有 ${hiddenCount} 条更早的已完成流程`}>+{hiddenCount}</span>}
					{archived.slice(hiddenCount).map((step, index) => { const compact = index < compactCount; const name = step.meta?.toolName ?? "工具"; const Icon = step.meta?.messageKind === "reasoning" ? Brain : /read|file/i.test(name) ? FileText : /search|grep|list/i.test(name) ? Search : /write|edit|patch/i.test(name) ? Pencil : Terminal; return <button key={step.id} className={compact ? "compact" : undefined} type="button" aria-label={`${name}：${executionDescription(step)}`} aria-expanded={selected === step.id} onClick={() => setSelected(selected === step.id ? null : step.id)} title={executionDescription(step)}>
						<Icon size={13} /><span className="archive-number">{String(steps.findIndex((item) => item.id === step.id) + 1).padStart(2, "0")}</span>{!compact && <><span>{name}</span><small>{executionExplanation(step)}</small><StepMetrics step={step} /></>}
					</button>; })}
				</div>}
				<div ref={currentTrack} className="harness-trace-track" role="list" aria-label="本轮执行步骤">
					{steps.length === 0 ? (
						<div className="harness-wait">
							<Loader2 size={14} className="animate-spin" />
							正在连接模型，等待下一步
						</div>
					) : (
						current.map((step) => {
							const index = steps.findIndex((item) => item.id === step.id);
							const payload = executionPayload(step);
							const approval = approvals.find((item) => item.toolCallId === step.meta?.toolCallId);
							const live = step.meta?.phase === "running" || step.meta?.phase === "pending" || step.meta?.hookEventName === "tool_call_start";
							const running = live && busy && !approval;
							const interrupted = !busy && live;
							const failed = executionFailed(payload) || interrupted;
							const name = step.meta?.toolName ?? "工具";
							const Icon = step.meta?.messageKind === "reasoning" ? Brain : /read|file/i.test(name) ? FileText : /search|grep|list/i.test(name) ? Search : /write|edit|patch/i.test(name) ? Pencil : Terminal;
							const State = approval ? ShieldQuestion : running ? Loader2 : failed ? X : Check;
							const label = executionOutcome(step, running, interrupted, !!approval);
							const timing = running
								? `${Math.max(0, Math.floor((now - step.createdAt) / 1000))}s`
								: step.meta?.durationMs !== undefined
									? `${(step.meta.durationMs / 1000).toFixed(1)}s`
									: "";
							return (
								<div className="harness-trace-item" role="listitem" key={step.id}>
									<button
										type="button"
										className="harness-trace-row"
										data-active={running}
										data-state={approval ? "approval" : failed ? "failed" : "done"}
										onClick={() => setSelected(selected === step.id ? null : step.id)}
										aria-expanded={selected === step.id}
										aria-label={`${name}，${executionDescription(step)}，${label}${timing ? `，${timing}` : ""}，查看详情`}
									>
										<span className="harness-trace-index">{String(index + 1).padStart(2, "0")}</span>
										<span className="harness-trace-branch" aria-hidden="true" />
										<Icon className="harness-trace-icon" size={13} aria-hidden="true" />
										<strong className="harness-trace-name">{name}</strong>
										<span className="harness-trace-description"><span>{executionDescription(step)}</span></span>
										<span className="harness-trace-status">
											<StepMetrics step={step} />
											<State size={12} className={running && !approval ? "animate-spin" : ""} aria-hidden="true" />{label}{timing ? ` · ${timing}` : ""}
										</span>
										<span className="harness-trace-merge" aria-hidden="true" />
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
