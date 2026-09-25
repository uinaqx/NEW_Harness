#!/usr/bin/env bun
/**
 * Build a source snapshot archive for delivery.
 *
 * Excludes derived output and third-party payloads that are re-fetched by
 * `scripts/fetch-opencode.mjs` (which is itself included, together with the
 * pinned manifest, so the snapshot is reproducible).
 *
 * Usage: bun scripts/package-source.mjs
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

const ROOT = join(import.meta.dir, "..");
const DELIVERY = join(ROOT, "delivery", "0.5.0");
const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const EXCLUDES = [
	"node_modules",
	"dist",
	"build",
	"out",
	"gen",
	"target",
	".next",
	".git",
	"delivery",
	// Keep `vendor/opencode/PIN.json` and the licence: `fetch-opencode.mjs` needs
	// the pinned manifest to know what to download, so a snapshot without it
	// cannot be rebuilt. Only the large payloads are excluded.
	"vendor/opencode/bin",
	"vendor/opencode/sdk",
	"shell/src-tauri/bin",
	"shell/src-tauri/icons/android",
	"shell/src-tauri/icons/ios",
	"shell/src-tauri/icons/128x128@2x.png",
	"shell/src-tauri/icons/64x64.png",
	"shell/src-tauri/icons/icon.icns",
	"shell/src-tauri/icons/icon.png",
	"shell/src-tauri/icons/Square*.png",
	"shell/src-tauri/icons/StoreLogo.png",
	"*.log",
	"*-report.json",
	"real-model-*.json",
	"*.tgz",
	"*.removed",
	".stale-*",
	"*.stale-*",
	"release",
];
const INCLUDE = ["backend", "webview", "shell", "shared", "scripts", "testing", "vendor/opencode/PIN.json", "vendor/opencode/LICENSE", "vendor/skills", ".gitignore", "package.json", "bun.lock", "tsconfig.json", "README.md", "AGENTS.md", "HARNESS.md", "UPSTREAM.md", "VALIDATION.md", "VALIDATION-0.2.0.md", "THIRD-PARTY-NOTICES.md"].filter((entry) =>
	existsSync(join(ROOT, entry)),
);

function run(cmd) {
	const result = Bun.spawnSync({ cmd, cwd: ROOT, stdout: "inherit", stderr: "inherit" });
	return result.exitCode === 0;
}

function main() {
	mkdirSync(DELIVERY, { recursive: true });
	// Overwrite in place rather than deleting first: some hosts (and sandboxes)
	// forbid deleting/renaming files while still allowing them to be written.
	const previous = readdirSync(DELIVERY).filter((file) => /-source\.(zip|tar\.gz)$/.test(file));
	for (const stale of previous) {
		try {
			rmSync(join(DELIVERY, stale));
		} catch {
			console.log(`[source] ${stale} cannot be removed; overwriting it in place`);
		}
	}

	const zip = join(DELIVERY, `某科学的Agent-${version}-source.zip`);
	// Build into a scratch file first: some hosts refuse to delete or rename an
	// existing deliverable while still allowing it to be written, and tar itself
	// gives up if it cannot create the output. Writing the bytes afterwards always
	// refreshes the canonical filename.
	const scratch = join(tmpdir(), `harness-source-${version}-${Date.now()}.zip`);
	const zipArgs = ["tar", "-c", "-f", scratch, "--format", "zip"];
	for (const pattern of EXCLUDES) zipArgs.push(`--exclude=${pattern}`);
	zipArgs.push(...INCLUDE);
	if (run(zipArgs)) {
		try {
			writeFileSync(zip, readFileSync(scratch));
			rmSync(scratch, { force: true });
			console.log(`[source] ${zip} (${statSync(zip).size} bytes)`);
			return;
		} catch (error) {
			// The canonical .zip exists but cannot be rewritten on this host; fall
			// through to the tarball rather than shipping a stale archive.
			console.log(`[source] cannot refresh ${basename(zip)} (${error.message}); writing a tarball instead`);
		}
	}

	// bsdtar without zip support (or no scratch space): gzipped tarball.
	const tarball = join(DELIVERY, `某科学的Agent-${version}-source.tar.gz`);
	const fallback = ["tar", "-c", "-z", "-f", tarball];
	for (const pattern of EXCLUDES) fallback.push(`--exclude=${pattern}`);
	fallback.push(...INCLUDE);
	if (!run(fallback)) throw new Error("failed to create the source snapshot");
	console.log(`[source] ${tarball} (${statSync(tarball).size} bytes)`);
}

main();
