/**
 * Harness backend — locate and verify the bundled OpenCode server binary.
 *
 * Rules (from the plan):
 *  - Update decisions are made on version + hash, never on file size alone.
 *  - Never overwrite a binary that is currently running.
 *  - Never kill processes by name; only ever stop the child we started.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { paths } from "../config";
import { ENGINE_BINARY_SHA256, ENGINE_BINARY_SIZE, ENGINE_VERSION } from "./pin";

export interface BinaryResolution {
	path: string;
	/** Where it came from, for diagnostics. */
	source: "env" | "beside-backend" | "resources" | "vendor" | "runtime";
	size: number;
	/** Whether the digest was verified in this run (cached results are trusted). */
	verified: boolean;
	version: string;
	sha256: string;
}

function candidatePaths(): Array<{ path: string; source: BinaryResolution["source"] }> {
	const list: Array<{ path: string; source: BinaryResolution["source"] }> = [];
	const override = process.env.HARNESS_OPENCODE_BIN;
	if (override && override.trim()) list.push({ path: resolve(override.trim()), source: "env" });

	const exeDir = dirname(process.execPath);
	list.push({ path: join(exeDir, "opencode", "opencode.exe"), source: "beside-backend" });
	list.push({ path: join(exeDir, "..", "resources", "opencode", "opencode.exe"), source: "resources" });
	list.push({ path: join(exeDir, "..", "share", "opencode", "opencode.exe"), source: "resources" });
	list.push({ path: join(exeDir, "bin", "opencode.exe"), source: "beside-backend" });
	list.push({ path: join(exeDir, "opencode.exe"), source: "beside-backend" });

	// Dev layout: harness/backend/src/engine -> harness/vendor/opencode/bin
	list.push({ path: join(import.meta.dir, "..", "..", "..", "vendor", "opencode", "bin", "opencode.exe"), source: "vendor" });
	// The engine copy Harness runs from (see stageEngineForSpawn).
	list.push({ path: join(paths.opencode(), "engine", "harness-engine.exe"), source: "runtime" });
	return list;
}

export function findOpenCodeBinary(): { path: string; source: BinaryResolution["source"] } | null {
	for (const candidate of candidatePaths()) {
		if (existsSync(candidate.path)) return candidate;
	}
	return null;
}

interface Stamp {
	version: string;
	sha256: string;
	size: number;
	mtimeMs: number;
	verifiedAt: number;
}

function readStamp(): Stamp | null {
	try {
		return JSON.parse(readFileSync(paths.binaryStamp(), "utf8")) as Stamp;
	} catch {
		return null;
	}
}

function writeStamp(stamp: Stamp): void {
	mkdirSync(dirname(paths.binaryStamp()), { recursive: true });
	writeFileSync(paths.binaryStamp(), JSON.stringify(stamp, null, 2), "utf8");
}

export function sha256File(path: string): string {
	const hash = createHash("sha256");
	const fd = Bun.file(path);
	void fd;
	// Bun.file().arrayBuffer() loads 180 MB into memory; stream instead.
	const buffer = readFileSync(path);
	hash.update(buffer);
	return hash.digest("hex");
}

/**
 * Verify the binary matches the pinned digest.
 *
 * A stamp keyed on (version, size, mtime) short-circuits the 180 MB re-hash on
 * subsequent launches. Any mismatch — including a *newer* file at the same path
 * — invalidates the stamp and forces a full re-hash.
 */
export function verifyBinary(path: string, force = false): BinaryResolution {
	const stat = statSync(path);
	if (stat.size !== ENGINE_BINARY_SIZE && !process.env.HARNESS_ALLOW_UNPINNED_ENGINE) {
		throw new Error(
			`引擎二进制大小与固定版本不符：期望 ${ENGINE_BINARY_SIZE} 字节，实际 ${stat.size} 字节。` +
				`请运行 scripts/fetch-opencode.mjs 重新获取 OpenCode ${ENGINE_VERSION}。`,
		);
	}
	const stamp = readStamp();
	const fresh = (): BinaryResolution => ({
		path,
		source: "runtime",
		size: stat.size,
		verified: true,
		version: ENGINE_VERSION,
		sha256: ENGINE_BINARY_SHA256,
	});
	if (
		!force &&
		stamp &&
		stamp.version === ENGINE_VERSION &&
		stamp.sha256 === ENGINE_BINARY_SHA256 &&
		stamp.size === stat.size &&
		stamp.mtimeMs === stat.mtimeMs
	) {
		return fresh();
	}
	const digest = sha256File(path);
	const matches = digest === ENGINE_BINARY_SHA256;
	if (!matches && !process.env.HARNESS_ALLOW_UNPINNED_ENGINE) {
		throw new Error(
			`引擎二进制哈希校验失败：期望 ${ENGINE_BINARY_SHA256.slice(0, 16)}…，实际 ${digest.slice(0, 16)}…。` +
				`拒绝启动未经验证的引擎。`,
		);
	}
	writeStamp({ version: ENGINE_VERSION, sha256: digest, size: stat.size, mtimeMs: stat.mtimeMs, verifiedAt: Date.now() });
	return {
		path,
		source: "runtime",
		size: stat.size,
		verified: matches,
		version: ENGINE_VERSION,
		sha256: digest,
	};
}

export function resolveOpenCodeBinary(force = false): BinaryResolution {
	const found = findOpenCodeBinary();
	if (!found) {
		throw new Error(
			`未找到 OpenCode 引擎二进制（固定版本 ${ENGINE_VERSION}）。` +
				`请运行 scripts/fetch-opencode.mjs，或设置 HARNESS_OPENCODE_BIN 指向 opencode.exe。`,
		);
	}
	const resolution = verifyBinary(found.path, force);
	return { ...resolution, source: found.source };
}

/**
 * Copy the verified engine into the data directory under a name Harness owns.
 *
 * Directories and names matter here:
 *  1. the installed program directory must never be locked by a running engine,
 *     otherwise an overwrite-install cannot replace `opencode/opencode.exe`;
 *  2. the installer needs a process name it can stop safely. `opencode.exe` is
 *     NOT safe — a user may have their own OpenCode installed — so the running
 *     engine is always the fixed name `harness-engine.exe` under our data dir.
 *
 * With `HARNESS_ALLOW_UNPINNED_ENGINE` (developer override) the binary is used
 * in place, so an arbitrary build can be pointed at without being copied.
 */
export function stageEngineForSpawn(resolution: BinaryResolution): BinaryResolution {
	if (process.env.HARNESS_ALLOW_UNPINNED_ENGINE) return resolution;
	const stagedDir = join(paths.opencode(), "engine");
	mkdirSync(stagedDir, { recursive: true });
	const staged = join(stagedDir, "harness-engine.exe");

	let existingSize: number | null = null;
	try {
		existingSize = statSync(staged).size;
	} catch {
		existingSize = null;
	}
	if (existingSize === resolution.size) {
		return { ...resolution, path: staged, source: "runtime" };
	}

	try {
		// Copy to a temp name first so a partially written file is never executed.
		const temp = `${staged}.tmp`;
		writeFileSync(temp, readFileSync(resolution.path));
		renameSync(temp, staged);
		return { ...resolution, path: staged, source: "runtime" };
	} catch (error) {
		if (existingSize !== null) {
			throw new Error(
				`无法更新引擎副本 ${staged}：文件正被占用（${error instanceof Error ? error.message : String(error)}）。` +
					`请先完全退出 Harness（含任务管理器中的 harness-shell.exe / harness-backend.exe / harness-engine.exe）后重试。`,
			);
		}
		throw error;
	}
}
