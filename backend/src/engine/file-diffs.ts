import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { applyPatch, createTwoFilesPatch, diffLines, parsePatch, reversePatch } from "diff";
import type { FileDiffEntry } from "./index";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value && typeof value === "object" ? value as RecordValue : {};
const text = (value: unknown) => typeof value === "string" ? value : "";

function displayPath(directory: string, file: string) {
	const path = relative(directory, resolve(directory, file));
	return (path.startsWith("..") || isAbsolute(path) ? file : path).replaceAll("\\", "/");
}

function textDiff(file: string, before: string, after: string, status: FileDiffEntry["status"] = "modified"): FileDiffEntry {
	const changes = diffLines(before, after);
	return { file, patch: createTwoFilesPatch(file, file, before, after), additions: changes.reduce((sum, part) => sum + (part.added ? part.count ?? 0 : 0), 0), deletions: changes.reduce((sum, part) => sum + (part.removed ? part.count ?? 0 : 0), 0), status };
}

export function normalizeDiffs(raw: RecordValue[], directory: string): FileDiffEntry[] {
	return raw.filter((entry) => text(entry.file)).map((entry) => {
		const file = displayPath(directory, text(entry.file));
		const status = ["added", "modified", "deleted"].includes(text(entry.status)) ? entry.status as FileDiffEntry["status"] : "unknown";
		if (typeof entry.before === "string" && typeof entry.after === "string") return textDiff(file, entry.before, entry.after, status);
		const patch = text(entry.patch);
		return { file, patch, additions: Number(entry.additions ?? 0), deletions: Number(entry.deletions ?? 0), status, unavailable: patch ? undefined : "引擎未提供此文件的文本差异。" };
	});
}

/** Restrict fallback file reads to regular, bounded files in this workspace. */
async function readCurrentFile(directory: string, file: string): Promise<string | undefined> {
	try {
		const [root, target] = await Promise.all([realpath(directory), realpath(resolve(directory, file))]);
		const path = relative(root, target);
		if (path.startsWith("..") || isAbsolute(path)) return undefined;
		const info = await stat(target);
		if (!info.isFile() || info.size > 2 * 1024 * 1024) return undefined;
		const bytes = await readFile(target);
		return bytes.includes(0) ? undefined : bytes.toString("utf8").replace(/^\uFEFF/, "");
	} catch { return undefined; }
}

type Change = { patch: string; after?: string; added?: boolean; deleted?: boolean; additions?: number; deletions?: number };

/** Non-Git projects have no engine snapshots. Use successful tools from this user turn only. */
export async function completedToolDiffs(messages: RecordValue[], directory: string, messageId: string, readCurrent = readCurrentFile): Promise<FileDiffEntry[]> {
	const start = messages.findIndex((entry) => record(entry.info).id === messageId && record(entry.info).role === "user");
	if (start < 0) return [];
	const next = messages.findIndex((entry, index) => index > start && record(entry.info).role === "user");
	const changes = new Map<string, Change[]>();
	const append = (file: string, change: Change) => { if (file) { const path = displayPath(directory, file); changes.set(path, [...changes.get(path) ?? [], change]); } };
	for (const entry of messages.slice(start + 1, next < 0 ? undefined : next)) {
		const info = record(entry.info);
		if (info.role !== "assistant" || (info.parentID && info.parentID !== messageId)) continue;
		for (const part of Array.isArray(entry.parts) ? entry.parts : []) {
			const tool = record(part), state = record(tool.state), meta = record(state.metadata), input = record(state.input);
			if (tool.type !== "tool" || state.status !== "completed" || (typeof meta.exit === "number" && meta.exit !== 0)) continue;
			if (Array.isArray(meta.files) && /patch/.test(text(tool.tool))) {
				for (const item of meta.files) {
					const file = record(item);
					append(text(file.movePath) || text(file.filePath), { patch: text(file.patch), added: file.type === "add", deleted: file.type === "delete", additions: Number(file.additions ?? 0), deletions: Number(file.deletions ?? 0) });
				}
				continue;
			}
			if (!/^(?:write|edit)$/.test(text(tool.tool))) continue;
			const diff = record(meta.filediff);
			const file = text(diff.file) || text(meta.filepath) || text(input.filePath);
			const added = tool.tool === "write" && meta.exists === false;
			append(file, { patch: text(diff.patch) || text(meta.diff), after: tool.tool === "write" ? text(input.content).replace(/^\uFEFF/, "") : undefined, added, additions: typeof diff.additions === "number" ? diff.additions : undefined, deletions: typeof diff.deletions === "number" ? diff.deletions : undefined });
		}
	}
	const out: FileDiffEntry[] = [];
	for (const [file, chain] of changes) {
		const first = chain[0]!, last = chain.at(-1)!;
		let before: string | undefined, after: string | undefined;
		if (first.added) {
			before = "";
			after = "";
			for (const change of chain) {
				if (change.after !== undefined) after = change.after;
				else if (change.patch && after !== undefined) { try { const next = applyPatch(after, change.patch); after = next === false ? undefined : next; } catch { after = undefined; } }
				else after = undefined;
			}
		} else if (chain.every((change) => change.patch)) {
			after = last.deleted ? "" : await readCurrent(directory, file);
			before = after;
			for (const change of [...chain].reverse()) {
				if (before === undefined) break;
				try { const previous = applyPatch(before, reversePatch(parsePatch(change.patch)[0]!)); before = previous === false ? undefined : previous; } catch { before = undefined; }
			}
		}
		if (before !== undefined && after !== undefined) {
			if (before !== after) out.push(textDiff(file, before, after, first.added ? "added" : last.deleted ? "deleted" : "modified"));
		} else {
			// Keep file access available even when the engine did not expose a baseline.
			const sole = chain.length === 1 ? first : undefined;
			out.push({ file, patch: sole?.patch ?? "", additions: sole?.additions ?? 0, deletions: sole?.deletions ?? 0, status: "modified", unavailable: sole?.patch ? undefined : "文件已修改，但引擎未提供可验证的本轮文本差异与增删行数。" });
		}
	}
	return out;
}
