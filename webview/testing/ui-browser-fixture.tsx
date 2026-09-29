/** Runs production components in an isolated browser; no backend, credentials or user files. */
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { SettingsDialog } from "../src/components/settings-dialog";
import { ExecutionCanvas, QuestionDialog } from "../src/components/execution-canvas";
import { ChatMessages } from "../src/components/chat-messages";
import { ChatInputBar } from "../src/components/chat-input-bar";
import { TaskResult } from "../src/components/task-result";
import type { ChatMessage, FileDiffEntryPayload } from "../src/lib/chat-schema";

const query = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", query.get("theme") !== "light");
const startedAt = Date.now() - 123000;
const diffs: FileDiffEntryPayload[] = Array.from({ length: 5 }, (_, index) => ({ file: ["webview/src/components/settings-dialog.tsx", "backend/src/engine/normalize.ts", "webview/src/components/execution-canvas.tsx", "shared/types.ts", "webview/src/components/task-result.tsx"][index], additions: 15 + index, deletions: index, patch: "", status: "modified" }));
const steps: ChatMessage[] = Array.from({ length: 9 }, (_, index) => ({ id: `t${index}`, sessionId: "s", role: "tool", content: JSON.stringify({ input: index === 0 ? { description: "分析界面调整方案" } : index === 8 ? { command: "bun run typecheck", description: "检查项目类型" } : { filePath: diffs[index % 5].file } }), createdAt: startedAt + index * 1000, meta: { toolName: index === 0 ? "thinking" : index === 1 ? "read" : index === 8 ? "bash" : "edit", messageKind: index === 0 ? "reasoning" : undefined, toolOutput: index === 0 ? "仅在画布显示的思考内容" : "", phase: index === 8 ? "running" : "success", durationMs: 1300, toolMetadata: index === 1 ? { linesRead: 147 } : { filediff: { additions: 49, deletions: 0 } } } }));
const messages: ChatMessage[] = [{ id: "u", sessionId: "s", role: "user", content: "调整执行画布，并显示阅读行数、文件修改与任务耗时。", createdAt: startedAt }, ...steps, { id: "a", sessionId: "s", role: "assistant", content: "画布和设置已完成调整，正在检查项目类型。", reasoning: "不应出现在对话里的思考", createdAt: startedAt + 10000 }];
const results: Array<{ name: string; ok: boolean }> = [];
let closes = 0, saves = 0, picked = 0, opened = "", avatarSaved = "", uploaded: { name: string; dataUrl: string }[] = [];
let answered: string[][] | null = null;
let reopenSettings = () => {};
const check = (name: string, ok: boolean) => results.push({ name, ok });
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 80));
const waitFor = async (predicate: () => boolean, timeoutMs = 1800) => {
	const deadline = Date.now() + timeoutMs;
	while (!predicate() && Date.now() < deadline) await pause();
	return predicate();
};
const button = (text: string) => Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent?.includes(text));

function Fixture() {
  const [settingsOpen, setSettingsOpen] = useState(query.get("view") === "settings" || query.get("view") === "personal");
  reopenSettings = () => setSettingsOpen(true);
  return <div className="app" style={{ gridTemplateColumns: "220px 1fr" }}>
    <aside className="app-sidebar" style={{ padding: "24px 18px" }}><strong>某科学的Agent</strong><p style={{ marginTop: 34 }}>新对话</p><small>项目</small><p>New Harness</p><p style={{ paddingLeft: 12 }}>界面与执行画布</p><button style={{ marginTop: "auto", textAlign: "left" }} onClick={() => document.documentElement.classList.toggle("dark")}>切换主题</button></aside>
    <main className="app-main"><header className="app-titlebar">界面与执行画布</header><div className="app-conversation">
      <ChatMessages messages={messages} status="running" streamingId={null} error={null}><TaskResult startedAt={startedAt} endedAt={startedAt + 123000} busy={false} status="completed" summary={{ toolCalls: 8, tokensIn: 2400, tokensOut: 1200, cacheReadTokens: 700 }} hasUsage diffs={diffs} onOpenFile={(file) => { opened = file; }} onReview={() => {}} /></ChatMessages>
	  <ExecutionCanvas messages={messages} status="running" sessionId="s" approvals={[]} questions={[]} startedAt={startedAt} onApprove={() => {}} onReject={() => {}} onAnswer={async (_id, answers) => { answered = answers; }} />
    </div>{query.get("view") === "upload" ? <ChatInputBar onSend={async (_prompt, options) => { uploaded = options.inlineAttachments ?? []; }} onStop={() => {}} onOpenSettings={() => {}} onPickFolder={async () => null} onPickFiles={async () => []} onWorkspaceChange={() => {}} onProfileModelChange={() => {}} onModeChange={() => {}} onGoalChange={() => {}} onApprovalModeChange={async () => {}} approvalMode="ask" busy={false} model="mock" profileId="default" profiles={[]} kind="chat" workspace="" projects={[]} mode="act" goal="" workspaceLocked={false} /> : <div style={{ margin: "14px 40px 22px", padding: "20px", background: "var(--card)", border: "1px solid var(--border)", borderRadius: 14, color: "var(--muted-foreground)" }}>继续描述任务…<div style={{ display: "flex", justifyContent: "space-between", marginTop: 20 }}>＋<span>deepseek-flash　↑</span></div></div>}</main>
    <SettingsDialog open={settingsOpen} mode="update" settings={null} lastWorkspace="" osProtected busyCommand={null} onClose={() => { closes++; setSettingsOpen(false); }} onSave={async (draft) => { saves++; check("save carries one model", !!draft.model && !("models" in draft)); return "p"; }} onDeleteProfile={async () => {}} onTest={async () => { throw new Error("测试失败可见"); }} onValidateWorkspace={async (path) => ({ valid: true, resolved: path })} onPickWorkspace={async () => { picked++; return "C:\\测试项目"; }} onAppearanceChange={async () => {}} onAvatarChange={async (_role, value) => { avatarSaved = value; }} />
    {query.get("view") === "question" && <QuestionDialog request={{ requestId: "q", sessionId: "s", questions: [{ header: "方案", question: "请选择实现方案", options: [{ label: "简洁", description: "使用简单布局" }, { label: "详细", description: "提供更多信息" }], custom: true }] }} onAnswer={async (_id, answers) => { answered = answers; }} />}
  </div>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
void (async () => {
  await pause(); await pause();
  if (query.get("view") === "settings") {
    document.querySelector<HTMLElement>(".dialog-overlay")!.click();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await pause();
    check("backdrop and Escape cannot close settings", closes === 0 && !!document.querySelector('[role="dialog"]'));
	button("个人")!.click(); await pause();
	check("personal settings expose both avatar pickers", document.querySelectorAll(".avatar-editor").length === 2);
	document.querySelector<HTMLButtonElement>('.avatar-editor button[aria-label="原子"]')!.click(); await pause();
	check("preset avatar saves through settings", avatarSaved === "preset:atom");
	button("外观")!.click(); await pause();
	check("appearance tab exposes theme and font controls", !!button("深色") && !!button("等宽字体") && !!button("标准"));
	button("配置")!.click(); await pause();
    check("theme absent from API settings", !document.querySelector('[role="dialog"]')!.textContent?.includes("外观主题"));
    check("one model field", !document.querySelector('[role="dialog"] textarea'));
    button("选择文件夹")!.click(); await pause();
    check("folder picker replaces typed workspace", picked === 1 && !!button("C:\\测试项目"));
    button("保存配置")!.click(); await pause();
    check("save keeps settings open", saves === 1 && closes === 0 && !!document.querySelector('[role="dialog"]'));
    button("测试连接")!.click(); await pause();
    check("connection command failure visible", document.querySelector('[role="dialog"]')!.textContent!.includes("测试失败可见"));
    document.querySelector<HTMLButtonElement>('.dialog-head button[aria-label="关闭"]')!.click(); await pause();
    check("only X closes settings", closes === 1 && !document.querySelector('[role="dialog"]'));
  }
	if (query.get("view") === "personal") {
		button("个人")!.click(); await pause();
		const file = new File([Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg=="), (char) => char.charCodeAt(0))], "avatar.png", { type: "image/png" });
		const input = document.querySelector<HTMLInputElement>('.avatar-editor input[type="file"]')!;
		Object.defineProperty(input, "files", { configurable: true, value: [file] });
		input.dispatchEvent(new Event("change", { bubbles: true })); await new Promise<void>((resolve) => setTimeout(resolve, 220));
		check("avatar upload opens crop selection", !!document.querySelector(".avatar-crop-viewport"));
		button("使用此头像")!.click(); await pause();
		check("cropped avatar saves as bounded image", avatarSaved.startsWith("data:image/webp;base64,") && avatarSaved.length < 500_000);
	}
	if (query.get("view") === "upload") {
		const file = new File(["hello from drag"], "notes.txt", { type: "text/plain" });
		const transfer = new DataTransfer(); transfer.items.add(file);
		document.querySelector(".composer")!.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
		check("dropped file appears as attachment chip", await waitFor(() => document.querySelector(".composer-chip")?.textContent?.includes("notes.txt") === true));
		document.querySelector<HTMLButtonElement>('.composer-chip button[title="移除附件"]')!.click(); await pause();
		check("unsent attachment can be removed", !document.querySelector(".composer-chip"));
		document.querySelector(".composer")!.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
		check("removed attachment can be re-added", await waitFor(() => document.querySelector(".composer-chip")?.textContent?.includes("notes.txt") === true));
		document.querySelector<HTMLButtonElement>('.composer-send[title="发送"]')!.click();
		check("chat sends dropped file as read-only upload", await waitFor(() => uploaded.length === 1 && uploaded[0].name === "notes.txt" && uploaded[0].dataUrl.startsWith("data:text/plain;base64,")));
	}
  check("chat hides reasoning and tool payloads", !document.querySelector(".chat-scroll")!.textContent!.includes("仅在画布") && !document.querySelector(".chat-scroll")!.textContent!.includes("不应出现在对话"));
	check("user avatar is on the right of the message", document.querySelector(".msg-row.from-user")?.lastElementChild?.classList.contains("msg-avatar") === true);
  const count = document.querySelectorAll(".harness-trace-row").length;
  check("main trace has at most six steps", count <= 6 && count > 0);
  check("all nine steps retained", count + document.querySelectorAll(".harness-trace-archive button").length === 9);
  check("read/edit metrics visible", document.querySelector(".harness-execution")!.textContent!.includes("读取 147 行") && document.querySelector(".harness-execution")!.textContent!.includes("+49"));
  document.querySelector<HTMLButtonElement>(".harness-trace-archive button")!.click(); await pause();
  check("archived thought detail accessible", document.querySelector(".harness-node-detail")!.textContent!.includes("仅在画布显示的思考内容"));
  document.querySelector<HTMLButtonElement>(".harness-node-detail button")!.click();
  button("再显示 2 个文件")!.click(); await pause();
  check("changed files expand", document.querySelectorAll(".task-file-list button").length === 5);
  document.querySelector<HTMLButtonElement>(".task-file-list button")!.click();
  check("file click targets corresponding file", opened === diffs[0].file);
  check("completed duration and tokens", document.querySelector(".task-telemetry")!.textContent!.includes("2分3秒") && document.querySelector(".task-telemetry")!.textContent!.includes("4,300 Token"));
  if (query.get("view") === "question") { button("简洁")!.click(); await pause(); check("question option can be selected", document.querySelector('.question-options button[aria-pressed="true"]')?.textContent?.includes("简洁") === true); button("提交回答")!.click(); await pause(); check("question answer reaches submit callback", answered?.[0]?.[0] === "简洁"); }
	if (query.get("view") === "question") { check("question is in a separate modal", !!document.querySelector(".question-dialog-overlay [role=dialog]") && !document.querySelector(".harness-execution .harness-question")); check("question choices are stacked vertically", getComputedStyle(document.querySelector(".question-options")!).flexDirection === "column"); check("question modal has no visible scrollbar", getComputedStyle(document.querySelector(".question-dialog")!).scrollbarWidth === "none"); }
  if (query.get("view") === "settings") { button("切换主题")!.click(); await pause(); check("theme switch preserves trace", document.querySelectorAll(".harness-trace-row").length === count); }
	if (query.get("view") === "settings") { reopenSettings(); await new Promise<void>((resolve) => setTimeout(resolve, 350)); const pane = document.querySelector<HTMLElement>(".settings-dialog")!; const heading = document.querySelector<HTMLElement>(".settings-content h3")!; const bg = getComputedStyle(pane).backgroundColor; const fg = getComputedStyle(heading).color; check(`settings light contrast (${bg}, ${fg})`, Number(bg.match(/\d+/)?.[0] ?? 0) > 190 && Number(fg.match(/\d+/)?.[0] ?? 255) < 140); }
  const output = document.createElement("script"); output.id = "ui-qa-result"; output.type = "application/json"; output.textContent = JSON.stringify(results); document.body.append(output);
})();
