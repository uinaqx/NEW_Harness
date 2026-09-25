import { Sparkles, Folder, FileCode, Terminal } from "lucide-react";
import { BrandMark } from "@/components/brand-mark";

interface Props {
	onPick: (prompt: string) => void;
	hasWorkspace: boolean;
	kind: "work" | "chat";
	onOpenSettings: () => void;
}

const EXAMPLES = [
	{ icon: Folder, title: "梳理项目结构", prompt: "列出当前工作区的主要文件和目录结构，帮我快速了解这个项目。" },
	{ icon: FileCode, title: "解释某段代码", prompt: "读一下入口文件，给我讲讲这个项目的启动流程。" },
	{ icon: Terminal, title: "跑一次构建", prompt: "在当前工作区执行一次构建命令，把结果汇总给我。" },
	{ icon: Sparkles, title: "修个小问题", prompt: "帮我看看有没有明显的 TODO 或待修复问题，先列出来再处理。" },
];

export function Welcome({ onPick, hasWorkspace, kind, onOpenSettings }: Props) {
	return (
		<div className="welcome">
			<div className="logo"><BrandMark size={72} /></div>
			<h1>{kind === "chat" ? "点击开聊" : "开始一个新对话"}</h1>
			<p>{kind === "chat" ? "Chat 模式只进行文字对话，不访问或修改本地文件。选择模型后直接发送消息。" : "选好访问位置和模型，然后描述你想完成的任务。执行过程会在输入框上方实时展开。"}</p>
			{kind === "work" && !hasWorkspace && (
				<button className="btn" onClick={onOpenSettings} style={{ marginTop: 8 }}>
					选择项目文件夹
				</button>
			)}
			{kind === "work" && hasWorkspace && (
				<div className="examples">
					{EXAMPLES.map((ex) => (
						<button key={ex.title} className="ex" onClick={() => onPick(ex.prompt)}>
							<ex.icon size={16} /> {ex.title}
							<small>{ex.prompt}</small>
						</button>
					))}
				</div>
			)}
		</div>
	);
}
