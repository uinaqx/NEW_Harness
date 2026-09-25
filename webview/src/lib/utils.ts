export function cn(...inputs: (string | false | null | undefined)[]): string {
	return inputs.filter(Boolean).join(" ");
}

export function formatTime(ts: number | string): string {
	const d = typeof ts === "number" ? new Date(ts) : new Date(ts);
	if (isNaN(d.getTime())) return "";
	return d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function shortId(id: string | null | undefined): string {
	if (!id) return "new";
	return id.length > 8 ? id.slice(-6) : id;
}
