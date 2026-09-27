import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatMessages } from "./chat-messages";
import { SettingsDialog } from "./settings-dialog";
import { ExecutionCanvas } from "./execution-canvas";
import { TaskResult } from "./task-result";
import type { ChatMessage } from "@/lib/chat-schema";

test("conversation renders feedback but not tools, output, status steps or reasoning", () => {
	const messages: ChatMessage[] = [
		{ id: "a", sessionId: "s", role: "assistant", content: "任务反馈", reasoning: "隐藏思考", createdAt: 1 },
		{ id: "t", sessionId: "s", role: "tool", content: "隐藏工具参数", meta: { toolName: "read", toolOutput: "隐藏工具输出" }, createdAt: 1 },
		{ id: "st", sessionId: "s", role: "status", content: "隐藏步骤摘要", createdAt: 1 },
	];
	const html = renderToStaticMarkup(<ChatMessages messages={messages} status="completed" streamingId={null} error={null} />);
	expect(html).toContain("任务反馈");
	for (const text of ["隐藏思考", "隐藏工具参数", "隐藏工具输出", "隐藏步骤摘要"]) expect(html).not.toContain(text);
});

test("settings has a single model input and folder picker, no appearance or cancel action", () => {
	const html = renderToStaticMarkup(<SettingsDialog open mode="update" settings={null} lastWorkspace="" osProtected busyCommand={null} onClose={() => {}} onSave={async () => "p"} onDeleteProfile={async () => {}} onTest={async () => ({ ok: true, kind: "ok", message: "ok", latencyMs: 0 })} onValidateWorkspace={async () => ({ valid: true })} onPickWorkspace={async () => null} />);
	expect(html).toContain("模型 ID");
	expect(html).toContain("选择文件夹");
	expect(html).not.toContain("textarea");
	expect(html).not.toContain("外观主题");
	expect(html).not.toContain("取消");
});

test("canvas retains overflow above the six-row main trace and displays real line metrics", () => {
	const messages: ChatMessage[] = [{ id: "u", sessionId: "s", role: "user", content: "任务", createdAt: 1 }, ...Array.from({ length: 10 }, (_, index) => ({ id: String(index), sessionId: "s", role: "tool" as const, content: '{"input":{"filePath":"a.ts"}}', createdAt: 1, meta: { toolName: "edit", phase: "success" as const, toolMetadata: { filediff: { additions: 49, deletions: 0 } } } }))];
	const html = renderToStaticMarkup(<ExecutionCanvas messages={messages} status="running" sessionId="s" approvals={[]} startedAt={1} onApprove={() => {}} onReject={() => {}} />);
	expect((html.match(/class="harness-trace-row"/g) ?? []).length).toBe(6);
	expect(html).toContain("较早的已结束流程");
	expect(html).toContain("修改文件代码");
	expect(html).toContain("+49");
});

test("task result lists files and sums input, output and cached tokens", () => {
	const html = renderToStaticMarkup(<TaskResult startedAt={1000} endedAt={124000} busy={false} status="completed" summary={{ toolCalls: 1, tokensIn: 100, tokensOut: 20, cacheReadTokens: 10 }} hasUsage diffs={[{ file: "a.ts", patch: "", additions: 49, deletions: 0, status: "modified" }]} onOpenFile={() => {}} onReview={() => {}} />);
	expect(html).toContain("已修改 1 个文件");
	expect(html).toContain("a.ts");
	expect(html).toContain("2分3秒");
	expect(html).toContain("130 Token");
});
