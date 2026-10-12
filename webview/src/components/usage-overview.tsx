import { useMemo, useState } from "react";
import { Blocks, Clock3, Code2, Flame, LayoutTemplate, Lightbulb, Palette, PencilLine, Terminal, TestTubeDiagonal, Wrench } from "lucide-react";
import { BUILTIN_SKILLS } from "@shared/skills";
import type { UsageOverviewPayload } from "@shared/types";
import { activityCalendar, activityLevel, dayTokens, type ActivityMode } from "@/lib/usage-activity";
import { formatDuration } from "@/lib/execution-window";

const skillIcons = { "frontend-design": LayoutTemplate, "brainstorming": Lightbulb, "systematic-debugging": Wrench, "webapp-testing": TestTubeDiagonal, "theme-factory": Palette, "writing-plans": PencilLine, "web-artifacts-builder": Code2 };
const number = (value: number) => value.toLocaleString();

export function UsageOverview({ usage }: { usage: UsageOverviewPayload }) {
	const [mode, setMode] = useState<ActivityMode>("daily");
	const [selected, setSelected] = useState<string | null>(null);
	const weeks = useMemo(() => activityCalendar(usage.days), [usage.days]);
	const max = Math.max(0, ...weeks.flatMap((week) => mode === "weekly" ? [week.tokens] : week.cells.filter((cell) => !cell.future).map((cell) => mode === "cumulative" ? cell.cumulative : cell.tokens)));
	const total = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens;
	const activeDays = usage.days.filter((day) => dayTokens(day) > 0 || day.turns > 0).length;
	const peak = Math.max(0, ...usage.days.map(dayTokens));
	const topModel = usage.models[0];
	const skillsTotal = usage.skills.reduce((sum, skill) => sum + skill.calls, 0);
	const insights = [
		["Work / Chat 已完成轮次", `${number(usage.workTurns)} / ${number(usage.chatTurns)}`],
		["最常用的模型", topModel ? `${topModel.id} · ${total ? Math.round(topModel.tokens / total * 100) : 0}% Token` : "暂无记录"],
		["工具调用总数", number(usage.toolCalls)],
		["已使用技能种类", number(usage.skills.length)],
		["技能调用总数", number(skillsTotal)],
		["平均任务耗时", usage.turns ? formatDuration(usage.totalDurationMs / usage.turns) : "暂无记录"],
		["最长任务耗时", usage.turns ? formatDuration(usage.longestTurnMs) : "暂无记录"],
	];
	return <div className="usage-overview">
		<div className="usage-summary">
			{[[Terminal, number(total), "累计 Token"], [Flame, number(peak), "单日峰值 Token"], [Clock3, number(activeDays), "活跃天数"], [Blocks, number(usage.turns), "已完成轮次"]].map(([Icon, value, label]) => { const MetricIcon = Icon as typeof Terminal; return <div key={String(label)}><MetricIcon size={16} /><strong>{String(value)}</strong><span>{String(label)}</span></div>; })}
		</div>
		<section className="usage-section" aria-label="Token 活动">
			<div className="usage-section-head"><h4>Token 活动</h4><div className="usage-period" role="group" aria-label="统计周期">{([["daily", "每天"], ["weekly", "每周"], ["cumulative", "累计总量"]] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={mode === value} onClick={() => { setMode(value); setSelected(null); }}>{label}</button>)}</div></div>
			<div className="usage-calendar" data-mode={mode} style={{ gridTemplateColumns: `repeat(${weeks.length}, minmax(0, 1fr))` }} aria-label={mode === "weekly" ? "最近一年每周 Token 活动图" : "最近一年 Token 活动热力图"}>
				{weeks.map((week) => <div className="usage-week" key={week.start}>{mode === "weekly" ? <button type="button" className="usage-week-bar" data-level={activityLevel(week.tokens, max)} style={{ height: `${Math.max(6, max ? week.tokens / max * 100 : 0)}%` }} title={`${week.start} 至 ${week.end}：${number(week.tokens)} Token`} aria-label={`${week.start} 至 ${week.end}：${number(week.tokens)} Token`} onClick={() => setSelected(`${week.start} 至 ${week.end} · ${number(week.tokens)} Token`)} /> : week.cells.map((cell) => { const value = mode === "cumulative" ? cell.cumulative : cell.tokens; const label = `${cell.date} · ${mode === "cumulative" ? "累计 " : ""}${number(value)} Token${mode === "daily" ? ` · ${cell.turns} 轮` : ""}`; return <button key={cell.date} type="button" className="usage-cell" data-level={activityLevel(value, max)} data-future={cell.future} disabled={cell.future} title={label} aria-label={label} tabIndex={value ? 0 : -1} onClick={() => setSelected(label)} />; })}</div>)}
			</div>
			<div className="usage-months" style={{ gridTemplateColumns: `repeat(${weeks.length}, minmax(0, 1fr))` }} aria-hidden="true">{weeks.map((week, index) => <span key={week.start}>{index === 0 || week.cells[0].month !== weeks[index - 1].cells[0].month ? `${week.cells[0].month}月` : ""}</span>)}</div>
			<div className="usage-chart-foot"><span aria-live="polite">{selected ?? "最近一年 · 点击色块查看用量"}</span><span className="usage-legend">少{[0, 1, 2, 3, 4].map((level) => <i key={level} data-level={level} />)}多</span></div>
			{!total && <p>还没有 Token 记录，完成一次对话后会显示真实用量。</p>}
		</section>
		<section className="usage-section"><div className="usage-section-head"><h4>常用技能</h4><small>按实际成功调用次数</small></div>{usage.skills.length ? <div className="usage-skills">{usage.skills.slice(0, 6).map((skill) => { const Icon = skillIcons[skill.id as keyof typeof skillIcons] ?? Blocks; const label = BUILTIN_SKILLS.find((item) => item.id === skill.id)?.label ?? skill.id; return <div key={skill.id} title={skill.id}><span className="usage-skill-icon"><Icon size={23} strokeWidth={1.6} /></span><strong>{label}</strong><small>{number(skill.calls)} 次</small></div>; })}</div> : <p>还没有技能调用记录。</p>}</section>
		<section className="usage-section"><h4>使用洞察</h4><table className="usage-insights" aria-label="使用统计表"><tbody>{insights.map(([label, value]) => <tr key={label}><th scope="row">{label}</th><td>{value}</td></tr>)}</tbody></table></section>
		<section className="usage-section"><h4>Token 明细</h4><table className="usage-insights" aria-label="Token 统计表"><tbody>{[["输入 Token", usage.inputTokens], ["输出 Token", usage.outputTokens], ["缓存读取 Token", usage.cacheReadTokens], ["已保存会话", usage.sessions]].map(([label, value]) => <tr key={String(label)}><th scope="row">{label}</th><td>{number(Number(value))}</td></tr>)}</tbody></table></section>
		<p className="usage-note">统计仅包含本机当前保留的会话；Token 用量以模型服务返回的记录为准。删除会话后，其用量将不再计入。</p>
		{usage.unavailableSessions > 0 && <p>{usage.unavailableSessions} 个会话暂时无法读取，未计入统计。</p>}
		{usage.truncatedSessions > 0 && <p>{usage.truncatedSessions} 个超长会话仅统计最近 10,000 条消息。</p>}
	</div>;
}
