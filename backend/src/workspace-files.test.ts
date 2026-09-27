import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWorkspaceFile } from "./workspace-files";

test("file preview permits project text, bounds size, rejects escape and binary", async () => {
	const dir = await mkdtemp(join(tmpdir(), "harness-preview-"));
	try {
		const workspace = join(dir, "project");
		await mkdir(workspace);
		await writeFile(join(workspace, "中文.ts"), "hello\nworld");
		await writeFile(join(dir, "outside.txt"), "outside");
		await writeFile(join(workspace, "binary.bin"), Buffer.from([0, 1, 2]));
		await writeFile(join(workspace, "large.txt"), "x".repeat(1024 * 1024 + 100));
		expect((await readWorkspaceFile(workspace, "中文.ts")).content).toBe("hello\nworld");
		await expect(readWorkspaceFile(workspace, "../outside.txt")).rejects.toThrow("项目内");
		await expect(readWorkspaceFile(workspace, "binary.bin")).rejects.toThrow("二进制");
		const large = await readWorkspaceFile(workspace, "large.txt");
		expect(large.truncated).toBe(true);
		expect(large.content.length).toBe(1024 * 1024);
	} finally {
		if (!dir.startsWith(join(tmpdir(), "harness-preview-"))) throw new Error("Unexpected test directory");
		await rm(dir, { recursive: true, force: true });
	}
});
