/** Runs production components in an isolated browser; no backend, credentials or user files. */
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { SettingsDialog } from "../src/components/settings-dialog";
import { ExecutionCanvas, QuestionDialog } from "../src/components/execution-canvas";
import { ChatMessages } from "../src/components/chat-messages";
import { ChatInputBar } from "../src/components/chat-input-bar";
import { TaskResult } from "../src/components/task-result";
import type { ChatMessage, FileDiffEntryPayload, ModelSettingsPayload } from "../src/lib/chat-schema";
import { desktopClient } from "../src/lib/desktop-client";
import { dateKey } from "../src/lib/usage-activity";
import type { UsageOverviewPayload } from "../../shared/types";

const usageDays = Array.from({ length: 365 }, (_, index) => { const date = new Date(); date.setDate(date.getDate() - 364 + index); return { date: dateKey(date), inputTokens: index % 4 === 0 ? 1000 + index * 9 : 0, outputTokens: index % 4 === 0 ? 200 + index : 0, cacheReadTokens: index % 4 === 0 ? 50 : 0, turns: index % 4 === 0 ? 1 : 0 }; });
const demoUsage: UsageOverviewPayload = { sessions: 12, turns: 92, inputTokens: usageDays.reduce((sum, day) => sum + day.inputTokens, 0), outputTokens: usageDays.reduce((sum, day) => sum + day.outputTokens, 0), cacheReadTokens: usageDays.reduce((sum, day) => sum + day.cacheReadTokens, 0), unavailableSessions: 0, truncatedSessions: 0, workTurns: 60, chatTurns: 32, toolCalls: 260, totalDurationMs: 1840000, longestTurnMs: 123000, days: usageDays, skills: [{ id: "frontend-design", calls: 12 }, { id: "webapp-testing", calls: 8 }, { id: "brainstorming", calls: 6 }, { id: "systematic-debugging", calls: 4 }, { id: "writing-plans", calls: 3 }, { id: "theme-factory", calls: 2 }], models: [{ id: "deepseek-flash", replies: 100, tokens: 250000 }] };
(desktopClient as unknown as { invoke: (command: string) => Promise<unknown> }).invoke = async (command) => { if (command === "get_usage_overview") return demoUsage; throw new Error(`Unexpected fixture command ${command}`); };

const query = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", query.get("theme") !== "light");
document.documentElement.dataset.themePreset = "classic";
const startedAt = Date.now() - 123000;
const diffs: FileDiffEntryPayload[] = Array.from({ length: 5 }, (_, index) => ({ file: ["webview/src/components/settings-dialog.tsx", "backend/src/engine/normalize.ts", "webview/src/components/execution-canvas.tsx", "shared/types.ts", "webview/src/components/task-result.tsx"][index], additions: 15 + index, deletions: index, patch: "", status: "modified" }));
const steps: ChatMessage[] = Array.from({ length: 9 }, (_, index) => ({ id: `t${index}`, sessionId: "s", role: "tool", content: JSON.stringify({ input: index === 0 ? { description: "分析界面调整方案" } : index === 8 ? { command: "bun run typecheck", description: "检查项目类型" } : { filePath: diffs[index % 5].file } }), createdAt: startedAt + index * 1000, meta: { toolName: index === 0 ? "thinking" : index === 1 ? "read" : index === 8 ? "bash" : "edit", messageKind: index === 0 ? "reasoning" : undefined, toolOutput: index === 0 ? "仅在画布显示的思考内容" : "", phase: index === 8 ? "running" : "success", durationMs: 1300, toolMetadata: index === 1 ? { linesRead: 147 } : { filediff: { additions: 49, deletions: 0 } } } }));
const messages: ChatMessage[] = [{ id: "u", sessionId: "s", role: "user", content: "调整执行画布，并显示阅读行数、文件修改与任务耗时。", createdAt: startedAt }, ...steps, { id: "a", sessionId: "s", role: "assistant", content: "**界面已更新**，正在检查 `项目类型`。\n\n- 思考只在画布展示\n- 文件修改与耗时可查看", reasoning: "不应出现在对话里的思考", createdAt: startedAt + 10000 }];
const results: Array<{ name: string; ok: boolean }> = [];
let closes = 0, saves = 0, picked = 0, opened = "", avatarSaved = "", uploaded: { name: string; dataUrl: string }[] = [];
let answered: string[][] | null = null;
let reopenSettings = () => {};
let changeLayout: (busy: boolean, extra?: string) => void = () => {};
const check = (name: string, ok: boolean) => results.push({ name, ok });
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 80));
const waitFor = async (predicate: () => boolean, timeoutMs = 1800) => {
	const deadline = Date.now() + timeoutMs;
	while (!predicate() && Date.now() < deadline) await pause();
	return predicate();
};
const button = (text: string) => Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent?.includes(text));

function Fixture() {
  const [layoutBusy, setLayoutBusy] = useState(query.get("sample") !== "layout-completed");
  const [layoutStarted, setLayoutStarted] = useState(!query.get("sample")?.startsWith("layout-new-"));
  const [extraFeedback, setExtraFeedback] = useState("");
  changeLayout = (busy, extra = "") => { setLayoutStarted(true); setLayoutBusy(busy); setExtraFeedback(extra); };
  if (query.get("view") === "layout") {
    const isNew = query.get("sample")?.startsWith("layout-new-");
    const isChat = query.get("sample") === "layout-new-chat";
    const status = !layoutStarted ? "idle" : layoutBusy ? "running" : "completed";
    const history: ChatMessage[] = query.get("sample") === "layout-long" ? Array.from({ length: 26 }, (_, index) => ({ id: `history-${index}`, sessionId: "s", role: index % 2 ? "assistant" : "user", content: `之前的消息 ${index}。` + "可自由回看任务对话。".repeat(8), createdAt: startedAt })) : [];
    const layoutMessages: ChatMessage[] = !layoutStarted ? [] : [...history, { id: "user", sessionId: "s", role: "user", content: "做一个贪吃蛇小游戏，html", createdAt: startedAt }, ...(!isNew ? [{ id: "feedback", sessionId: "s", role: "assistant" as const, content: layoutBusy ? "已创建 `snake.html`，正在验证碰撞逻辑。" : "**已完成**，`snake.html` 可以直接在浏览器中打开。碰撞逻辑与键盘控制测试通过。", createdAt: startedAt }] : []), ...(extraFeedback ? [{ id: "extra", sessionId: "s", role: "assistant" as const, content: extraFeedback, createdAt: startedAt }] : []), ...(!isChat ? steps.slice(-4) : [])];
    return <div className="app" style={{ gridTemplateColumns: "220px 1fr" }}><aside className="app-sidebar" style={{ padding: 24 }}>某科学的Agent</aside><main className="app-main"><header className="app-titlebar">贪吃蛇小游戏</header><div className="app-conversation"><ChatMessages messages={layoutMessages} status={status} streamingId={null} error={null} deferActiveAnswer={!isChat} afterMessages={!isChat && <ExecutionCanvas messages={layoutMessages} status={status} sessionId="s" approvals={[]} questions={[]} startedAt={startedAt} onApprove={() => {}} onReject={() => {}} onAnswer={async () => {}} />}><TaskResult startedAt={layoutStarted ? startedAt : null} endedAt={startedAt + 123000} busy={layoutBusy} status="completed" summary={{ toolCalls: 4, tokensIn: 2400, tokensOut: 1200, cacheReadTokens: 700 }} hasUsage diffs={isChat ? [] : [{ file: "snake.html", additions: 324, deletions: 0, patch: "+game", status: "added" }]} onOpenFile={(file) => { opened = file; }} onReview={() => {}} /></ChatMessages>{!layoutStarted && <div className="welcome">开始一个新对话</div>}</div><div className="composer"><div className="composer-inner"><div className="composer-box">继续描述任务…</div></div></div></main></div>;
  }
  const [settingsOpen, setSettingsOpen] = useState(["settings", "personal", "theme"].includes(query.get("view") ?? ""));
  const [appearance, setAppearance] = useState<ModelSettingsPayload>({ profiles: [], defaultProfileId: "default", protocol: "openai-compatible", baseUrl: "", model: "mock", lastWorkspace: "", autoApproveEdits: false, autoApproveCommands: false, fullAccess: false, theme: query.get("theme") === "light" ? "light" : "dark", themePreset: "classic", fontFamily: "system", fontSize: "normal", userAvatar: "preset:user", assistantAvatar: "preset:brand", apiKey: "", hasApiKey: false, apiKeyMask: null });
  reopenSettings = () => setSettingsOpen(true);
  return <div className="app" style={{ gridTemplateColumns: "220px 1fr" }}>
    <aside className="app-sidebar" style={{ padding: "24px 18px" }}><strong>某科学的Agent</strong><p style={{ marginTop: 34 }}>新对话</p><small>项目</small><p>New Harness</p><p style={{ paddingLeft: 12 }}>界面与执行画布</p><button style={{ marginTop: "auto", textAlign: "left" }} onClick={() => document.documentElement.classList.toggle("dark")}>切换主题</button></aside>
    <main className="app-main"><header className="app-titlebar">界面与执行画布</header><div className="app-conversation">
      <ChatMessages messages={messages} status="running" streamingId={null} error={null} assistantAvatar={appearance.themePreset === "classic" ? "preset:brand" : `theme:${appearance.themePreset}`} assistantLabel={appearance.themePreset === "fairy" ? "Fairy" : appearance.themePreset === "klee" ? "可莉" : "某科学的Agent"} afterMessages={<ExecutionCanvas messages={messages} status="running" sessionId="s" approvals={[]} questions={[]} startedAt={startedAt} onApprove={() => {}} onReject={() => {}} onAnswer={async (_id, answers) => { answered = answers; }} />}><TaskResult startedAt={startedAt} endedAt={startedAt + 123000} busy={false} status="completed" summary={{ toolCalls: 8, tokensIn: 2400, tokensOut: 1200, cacheReadTokens: 700 }} hasUsage diffs={diffs} onOpenFile={(file) => { opened = file; }} onReview={() => {}} /></ChatMessages>
    </div>{query.get("view") === "upload" ? <ChatInputBar onSend={async (_prompt, options) => { uploaded = options.inlineAttachments ?? []; }} onStop={() => {}} onOpenSettings={() => {}} onPickFolder={async () => null} onPickFiles={async () => []} onWorkspaceChange={() => {}} onProfileModelChange={() => {}} onModeChange={() => {}} onGoalChange={() => {}} onApprovalModeChange={async () => {}} approvalMode="ask" busy={false} model="mock" profileId="default" profiles={[]} kind="chat" workspace="" projects={[]} mode="act" goal="" workspaceLocked={false} /> : <div style={{ margin: "14px 40px 22px", padding: "20px", background: "var(--card)", border: "1px solid var(--border)", borderRadius: 14, color: "var(--muted-foreground)" }}>继续描述任务…<div style={{ display: "flex", justifyContent: "space-between", marginTop: 20 }}>＋<span>deepseek-flash　↑</span></div></div>}</main>
    <SettingsDialog open={settingsOpen} mode="update" settings={query.get("view") === "theme" ? appearance : null} lastWorkspace="" osProtected busyCommand={null} onClose={() => { closes++; setSettingsOpen(false); }} onSave={async (draft) => { saves++; check("save carries one model", !!draft.model && !("models" in draft)); return "p"; }} onDeleteProfile={async () => {}} onTest={async () => { throw new Error("测试失败可见"); }} onValidateWorkspace={async (path) => ({ valid: true, resolved: path })} onPickWorkspace={async () => { picked++; return "C:\\测试项目"; }} onAppearanceChange={async (patch) => { setAppearance((current) => ({ ...current, ...patch })); if (patch.themePreset) document.documentElement.dataset.themePreset = patch.themePreset; if (patch.theme) document.documentElement.classList.toggle("dark", patch.theme === "dark"); }} onAvatarChange={async (_role, value) => { avatarSaved = value; }} />
    {query.get("view") === "question" && <QuestionDialog request={{ requestId: "q", sessionId: "s", questions: [{ header: "方案", question: "请选择实现方案", options: [{ label: "简洁", description: "使用简单布局" }, { label: "详细", description: "提供更多信息" }], custom: true }] }} onAnswer={async (_id, answers) => { answered = answers; }} />}
  </div>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
void (async () => {
  await pause(); await pause();
  if (query.get("view") === "layout") {
    const isNew = query.get("sample")?.startsWith("layout-new-");
    const isChat = query.get("sample") === "layout-new-chat";
    if (isNew) {
      check("new conversation starts with the welcome screen", !!document.querySelector(".welcome") && !document.querySelector(".chat-scroll"));
      changeLayout(true); await pause(); await pause();
    }
    const scroll = document.querySelector<HTMLElement>(".chat-scroll")!;
    const firstMessage = document.querySelector<HTMLElement>(".msg")!;
    if (query.get("sample") !== "layout-long") {
      const offset = firstMessage.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
      check(`first message starts at the top (${Math.round(offset)}px)`, offset >= 0 && offset <= 60);
      const top = firstMessage.getBoundingClientRect().top;
      const height = scroll.clientHeight;
      changeLayout(false); await new Promise<void>((resolve) => setTimeout(resolve, 360));
      check("canvas collapse keeps the first message in place", Math.abs(firstMessage.getBoundingClientRect().top - top) <= 1 && scroll.clientHeight === height);
      changeLayout(true); await new Promise<void>((resolve) => setTimeout(resolve, 360));
      check("canvas expansion keeps the first message in place", Math.abs(firstMessage.getBoundingClientRect().top - top) <= 1 && scroll.clientHeight === height);
      if (isNew) {
        changeLayout(true, "正在准备回答。"); await pause();
        check("later replies follow the first message from top to bottom", document.querySelector<HTMLElement>(".msg-assistant")!.getBoundingClientRect().top > firstMessage.getBoundingClientRect().bottom);
      }
      if (query.get("sample") === "layout-completed") { changeLayout(false); await new Promise<void>((resolve) => setTimeout(resolve, 360)); }
    }
    if (isChat) {
      check("Chat starts from the top without a work canvas", !document.querySelector(".harness-execution") && scroll.scrollTop === 0);
    } else
    if (query.get("sample") !== "layout-completed") {
      const canvas = document.querySelector<HTMLElement>(".harness-execution")!;
      check("canvas follows messages in the same scrollable document", canvas.closest(".chat-scroll") === scroll);
      const latest = document.querySelector<HTMLElement>(".task-telemetry")!;
      const gap = canvas.getBoundingClientRect().top - latest.getBoundingClientRect().bottom;
      check(`latest task feedback stays against the canvas (${Math.round(gap)}px)`, gap >= 0 && gap <= 20);
      const message = Array.from(document.querySelectorAll<HTMLElement>(".msg-assistant")).at(-1)!;
      check("message and canvas are separated only by compact task telemetry", canvas.getBoundingClientRect().top - message.getBoundingClientRect().bottom <= 60);
      check("chat has no composer-sized bottom reservation", parseFloat(getComputedStyle(document.querySelector(".chat-inner")!).paddingBottom) <= 12);
      if (query.get("sample") === "layout-long") {
        check("long running history remains scrollable", scroll.scrollHeight > scroll.clientHeight + 100);
        scroll.scrollTop = 0; scroll.dispatchEvent(new Event("scroll"));
        changeLayout(true, "测试通过，继续汇总结果。"); await pause();
        check("new feedback respects the user scrolling back", scroll.scrollTop === 0);
        changeLayout(false, "测试通过，继续汇总结果。"); await new Promise<void>((resolve) => setTimeout(resolve, 360));
        check("canvas collapse respects the user scrolling back", scroll.scrollTop === 0);
        changeLayout(true, "测试通过，继续汇总结果。"); await new Promise<void>((resolve) => setTimeout(resolve, 360));
        check("canvas expansion respects the user scrolling back", scroll.scrollTop === 0);
        scroll.scrollTop = scroll.scrollHeight; scroll.dispatchEvent(new Event("scroll"));
        changeLayout(true, "完成检查。".repeat(200)); await pause(); await pause();
        const tailGap = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight;
        check(`following the latest reply stays at the bottom as content grows (${Math.round(tailGap)}px)`, tailGap <= 2);
        changeLayout(true, "测试通过，继续汇总结果。"); await pause(); await pause();
      }
    } else {
      check("completed output has a changed-file collection", document.querySelector(".task-changes")!.textContent!.includes("snake.html") && document.querySelector(".task-changes")!.textContent!.includes("+324"));
      check("completed canvas is withdrawn", document.querySelector(".harness-execution")!.getAttribute("data-open") === "false");
      document.querySelector<HTMLButtonElement>(".task-file-list button")!.click();
      check("changed file opens directly from the result", opened === "snake.html");
    }
    const output = document.createElement("script"); output.id = "ui-qa-result"; output.type = "application/json"; output.textContent = JSON.stringify(results); document.body.append(output); return;
  }
  if (query.get("view") === "theme") {
    button("外观")!.click(); await pause();
    check("appearance offers classic, Fairy and Klee", document.querySelectorAll(".theme-preset").length === 3);
    const preset = query.get("preset") === "klee" ? "klee" : "fairy";
    document.querySelector<HTMLButtonElement>(`.theme-preset[data-preset="${preset}"]`)!.click(); await pause();
    check("character selection remains selected", document.querySelector(`.theme-preset[data-preset="${preset}"][aria-pressed="true"]`) !== null);
    check("character theme changes semantic palette", getComputedStyle(document.documentElement).getPropertyValue("--theme-ornament").trim() !== "");
    check("dark or light mode is independent of character", document.documentElement.classList.contains("dark") === (query.get("theme") !== "light"));
    check("Klee preview is bundled locally", preset !== "klee" || (document.querySelector<HTMLImageElement>('.theme-preset[data-preset="klee"] img')?.naturalWidth ?? 0) > 0);
    check("conversation uses the selected game avatar", (document.querySelector<HTMLImageElement>(".msg-avatar.assistant img")?.naturalWidth ?? 0) > 0);
    if (query.get("home") === "1") { document.querySelector<HTMLButtonElement>('.settings-dialog .dialog-head button[aria-label="关闭"]')!.click(); await pause(); }
  }
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
		check("personal renders a full local activity calendar", document.querySelectorAll(".usage-cell").length >= 365);
		check("personal lists actual popular skill counts", document.querySelector(".usage-skills")?.textContent?.includes("前端设计12 次") === true);
		const cells = Array.from(document.querySelectorAll<HTMLButtonElement>(".usage-cell"));
		const active = cells.find((cell) => cell.dataset.level !== "0" && !cell.disabled)!;
		active.click(); await pause();
		check("activity cell reveals its date and Token value", document.querySelector(".usage-chart-foot")?.textContent?.includes(active.getAttribute("aria-label")!) === true);
		button("每周")!.click(); await pause();
		check("weekly view aggregates weeks", document.querySelectorAll(".usage-week-bar").length >= 52 && document.querySelectorAll(".usage-cell").length === 0);
		button("累计总量")!.click(); await pause();
		check("cumulative view uses cumulative cell labels", document.querySelector(".usage-cell:not([disabled])")?.getAttribute("aria-label")?.includes("累计") === true);
		button("每天")!.click(); await pause();
		const calendar = document.querySelector<HTMLElement>(".usage-calendar")!;
		check("calendar fits its container without horizontal scrolling", calendar.scrollWidth <= calendar.clientWidth + 1);
		check("insights and Token breakdown are real tables", document.querySelectorAll(".usage-insights").length === 2 && document.querySelector(".usage-insights")!.textContent!.includes("60 / 32"));
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
  check("chat hides reasoning and tool payloads", !document.querySelector(".chat-inner")!.textContent!.includes("仅在画布") && !document.querySelector(".chat-inner")!.textContent!.includes("不应出现在对话"));
  check("answer Markdown renders emphasis, code and lists", !!document.querySelector(".msg-assistant strong") && !!document.querySelector(".msg-assistant code") && document.querySelectorAll(".msg-assistant li").length === 2);
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
  document.querySelector<HTMLElement>(".chat-scroll")!.scrollTop = 0;
  const output = document.createElement("script"); output.id = "ui-qa-result"; output.type = "application/json"; output.textContent = JSON.stringify(results); document.body.append(output);
})();
