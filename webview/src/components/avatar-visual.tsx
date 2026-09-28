import { Atom, Bot, Moon, Sparkles, UserRound } from "lucide-react";
import { BrandMark } from "./brand-mark";

export const AVATAR_PRESETS = [
	{ id: "preset:user", label: "人物" },
	{ id: "preset:brand", label: "应用" },
	{ id: "preset:bot", label: "机器人" },
	{ id: "preset:spark", label: "灵感" },
	{ id: "preset:atom", label: "原子" },
	{ id: "preset:moon", label: "月亮" },
] as const;

export function AvatarVisual({ value, size = 26 }: { value?: string; size?: number }) {
	if (value && /^data:image\/(?:png|jpeg|webp);base64,/i.test(value)) return <img src={value} alt="自定义头像" width={size} height={size} draggable={false} />;
	const iconSize = Math.round(size * .58);
	switch (value) {
		case "preset:brand": return <BrandMark size={size} />;
		case "preset:bot": return <Bot size={iconSize} />;
		case "preset:spark": return <Sparkles size={iconSize} />;
		case "preset:atom": return <Atom size={iconSize} />;
		case "preset:moon": return <Moon size={iconSize} />;
		default: return <UserRound size={iconSize} />;
	}
}
