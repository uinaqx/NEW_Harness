import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export async function resolveWorkspaceFile(workspace: string, file: string): Promise<{ root: string; target: string; relativePath: string }> {
	const root = await realpath(workspace);
	const target = await realpath(resolve(root, file));
	const relativePath = relative(root, target);
	if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) throw new Error("文件不在当前项目内。");
	const info = await (await import("node:fs/promises")).stat(target);
	if (!info.isFile()) throw new Error("所选路径不是文件。");
	return { root, target, relativePath };
}

/** Read a bounded text file, resolving symlinks before enforcing the workspace boundary. */
export async function readWorkspaceFile(workspace: string, file: string): Promise<{ file: string; content: string; truncated: boolean }> {
	const { target, relativePath: path } = await resolveWorkspaceFile(workspace, file);
	const handle = await open(target, "r");
	try {
		const info = await handle.stat();
		if (!info.isFile()) throw new Error("所选路径不是文件。");
		const limit = 1024 * 1024;
		const buffer = Buffer.alloc(Math.min(info.size, limit));
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		const bytes = buffer.subarray(0, bytesRead);
		if (bytes.includes(0)) throw new Error("该文件为二进制内容，无法作为代码预览。");
		return { file: path, content: bytes.toString("utf8"), truncated: info.size > limit };
	} finally { await handle.close(); }
}
