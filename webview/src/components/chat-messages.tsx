import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { Loader2, AlertTriangle } from "lucide-react";
import { AvatarVisual } from "./avatar-visual";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage, ChatSessionStatus } from "@/lib/chat-schema";
import { cn } from "@/lib/utils";

interface Props {
	messages: ChatMessage[];
	status: ChatSessionStatus;
	streamingId: string | null;
	error: string | null;
	showWaiting?: boolean;
	showReasoning?: boolean;
	/** Work keeps the active streaming segment until the completion handoff. */
	deferActiveAnswer?: boolean;
	userAvatar?: string;
	assistantAvatar?: string;
	assistantLabel?: string;
	children?: ReactNode;
	/** The live canvas follows messages within the same scrollable document. */
	afterMessages?: ReactNode;
}

function renderContent(content: string) {
	if (!content) return null;
	return <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ node: _node, children, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer">{children}</a> }}>{content}</ReactMarkdown>;
}

function visibleContent(content: string): string {
	const withoutTags = content.replace(/<(?:think|analysis)>[\s\S]*?<\/(?:think|analysis)>/gi, "").replace(/<(?:think|analysis)>[\s\S]*$/gi, "").trim();
	return withoutTags;
}

function embeddedReasoning(content: string): string {
	return [...content.matchAll(/<think>([\s\S]*?)<\/think>/gi)].map((match) => match[1].trim()).filter(Boolean).join("\n\n");
}

export function ChatMessages({ messages, status, streamingId, error, showWaiting = false, showReasoning = false, deferActiveAnswer = false, userAvatar, assistantAvatar, assistantLabel = "某科学的Agent", children, afterMessages }: Props) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	const afterRef = useRef<HTMLDivElement>(null);
	const followLatest = useRef(true);
	const isBusy = status === "starting" || status === "running" || status === "stopping";
	const hasContent = messages.length > 0 || isBusy;
	const awaitingFirst = isBusy && !streamingId && !messages.some((m) => m.role === "tool" && m.meta?.hookEventName === "tool_call_start");

	useLayoutEffect(() => {
		const el = scrollRef.current;
		if (el && followLatest.current) el.scrollTop = el.scrollHeight;
	}, [messages, streamingId, children, afterMessages, isBusy]);

	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const observer = new ResizeObserver(() => { if (followLatest.current) el.scrollTop = el.scrollHeight; });
		observer.observe(el);
		if (contentRef.current) observer.observe(contentRef.current);
		if (afterRef.current) observer.observe(afterRef.current);
		return () => observer.disconnect();
	}, [hasContent]);

	const items = useMemo(() => messages.filter((message) => message.role === "user" || message.role === "error" || (message.role === "assistant" && !(deferActiveAnswer && isBusy && message.id === streamingId) && (visibleContent(message.content) || (showReasoning && (message.reasoning || embeddedReasoning(message.content)))))), [messages, showReasoning, deferActiveAnswer, isBusy, streamingId]);

	if (!hasContent) {
		return null;
	}

	return (
		<div className="chat-scroll" data-executing={deferActiveAnswer && isBusy} ref={scrollRef} onScroll={(event) => { const el = event.currentTarget; followLatest.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64; }}>
			<div className="chat-inner" ref={contentRef}>
				{items.map((m) => {
					const isUser = m.role === "user";
					const isAssistant = m.role === "assistant";
					const isError = m.role === "error";
					const isStreaming = streamingId === m.id;
					const content = isAssistant ? visibleContent(m.content) : m.content;
					const reasoning = showReasoning && isAssistant ? [m.reasoning, embeddedReasoning(m.content)].filter(Boolean).join("\n\n") : "";
					if (m.role === "system") return null;
					return (
						<div className={cn("msg", isUser && "msg-from-user")} key={m.id}>
							<div className={cn("msg-row", isUser && "from-user")}>
								{!isUser && <div className={cn("msg-avatar", isError ? "tool" : "assistant")}>
									{isError ? <AlertTriangle size={14} /> : <AvatarVisual value={assistantAvatar} size={26} />}
								</div>}
								<div className="msg-body">
									<div className="msg-role">{isUser ? "用户" : isError ? "错误" : assistantLabel}</div>
									<div className={cn("msg-content", isUser ? "msg-user" : isAssistant ? "msg-assistant" : isError ? "msg-error" : "")}>
										{isStreaming && !content ? (
											<span className="msg-status"><Loader2 size={14} className="spin" /> 正在思考…</span>
										) : isError ? (
											<span style={{ display: "flex", gap: 8, alignItems: "center" }}><AlertTriangle size={14} /> {m.content}</span>
										) : (
											renderContent(content)
										)}
										{reasoning && <details className="msg-reasoning"><summary>查看思考内容</summary><div>{renderContent(reasoning)}</div></details>}
									</div>
								</div>
								{isUser && <div className="msg-avatar user"><AvatarVisual value={userAvatar} size={26} /></div>}
							</div>
						</div>
					);
				})}
				{showWaiting && awaitingFirst && (
					<div className="msg-status"><Loader2 size={14} className="spin" /> 正在等待回复…</div>
				)}
				{children}
			</div>
			<div className="chat-after-messages" ref={afterRef}>{afterMessages}</div>
		</div>
	);
}
