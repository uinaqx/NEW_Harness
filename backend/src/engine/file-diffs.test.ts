import { expect, test } from "bun:test";
import { createTwoFilesPatch } from "diff";
import { completedToolDiffs, normalizeDiffs } from "./file-diffs";
import { resolve } from "node:path";

const root = resolve("test-workspace");
const user = (id: string) => ({ info: { role: "user", id }, parts: [] });
const write = (parentID: string, file: string, content: string, status = "completed") => ({ info: { role: "assistant", parentID }, parts: [{ type: "tool", tool: "write", state: { status, input: { filePath: resolve(root, file), content }, metadata: { filepath: resolve(root, file), exists: false } } }] });
const edit = (parentID: string, file: string, before: string, after: string) => ({ info: { role: "assistant", parentID }, parts: [{ type: "tool", tool: "edit", state: { status: "completed", metadata: { filediff: { file: resolve(root, file), patch: createTwoFilesPatch(file, file, before, after), additions: 1, deletions: 1 } } } }] });

test("non-Git new file includes actual content counts and a readable patch", async () => {
	const diffs = await completedToolDiffs([user("u"), write("u", "新文件.html", "<html>\n游戏\n</html>\n")], root, "u");
	expect(diffs).toHaveLength(1);
	expect(diffs[0]).toMatchObject({ file: "新文件.html", additions: 3, deletions: 0, status: "added" });
	expect(diffs[0]!.patch).toContain("+游戏");
});

test("only the selected user turn contributes successful changes", async () => {
	const messages = [user("old"), write("old", "old.txt", "old"), user("now"), write("now", "new.txt", "new"), write("old", "wrong-parent.txt", "x"), write("now", "denied.txt", "x", "error"), user("next"), write("next", "later.txt", "later")];
	expect((await completedToolDiffs(messages, root, "now")).map((diff) => diff.file)).toEqual(["new.txt"]);
	expect(await completedToolDiffs(messages, root, "missing")).toEqual([]);
	expect(await completedToolDiffs([user("read-only")], root, "read-only")).toEqual([]);
});

test("new file and repeated edits merge into one net result", async () => {
	const diffs = await completedToolDiffs([user("u"), write("u", "game.html", "one\ntwo\n"), edit("u", "game.html", "one\ntwo\n", "one\nthree\nfour\n")], root, "u");
	expect(diffs[0]).toMatchObject({ additions: 3, deletions: 0 });
	expect(diffs[0]!.patch).not.toContain("+two");
});

test("existing file edits produce net counts and omit fully reverted changes", async () => {
	const messages = [user("u"), edit("u", "a.txt", "a\nb\n", "a\nc\n"), edit("u", "a.txt", "a\nc\n", "a\nd\ne\n")];
	const diffs = await completedToolDiffs(messages, root, "u", async () => "a\nd\ne\n");
	expect(diffs[0]).toMatchObject({ additions: 2, deletions: 1 });
	expect(await completedToolDiffs([user("u"), edit("u", "a.txt", "a\n", "b\n"), edit("u", "a.txt", "b\n", "a\n")], root, "u", async () => "a\n")).toEqual([]);
});

test("snapshot before/after content becomes a usable unified patch", () => {
	const [diff] = normalizeDiffs([{ file: "a.ts", before: "old\n", after: "new\n" }], root);
	expect(diff).toMatchObject({ additions: 1, deletions: 1 });
	expect(diff!.patch).toContain("-old\n+new");
});

test("multiple files from apply_patch are listed separately", async () => {
	const entry = { info: { role: "assistant", parentID: "u" }, parts: [{ type: "tool", tool: "apply_patch", state: { status: "completed", metadata: { files: ["a", "b"].map((file) => ({ filePath: resolve(root, file), type: "add", patch: createTwoFilesPatch(file, file, "", file + "\n"), additions: 1, deletions: 0 })) } } }] };
	expect((await completedToolDiffs([user("u"), entry], root, "u")).map((diff) => [diff.file, diff.additions])).toEqual([["a", 1], ["b", 1]]);
});
