#!/usr/bin/env bun
/**
 * Harness build pipeline (cross-platform, no absolute machine paths).
 *
 * Steps:
 *   1. make sure the pinned OpenCode engine + SDK are vendored and hash-verified
 *   2. build the webview bundle
 *   3. typecheck backend + webview
 *   4. compile the Bun backend into a single executable
 *   5. stage that executable where the Tauri shell embeds it from
 *   6. run `tauri build` (produces the NSIS installer)
 *   7. copy the artefacts into delivery/ and rewrite SHA256SUMS.txt
 *
 * Usage:
 *   bun scripts/build.mjs              # full build
 *   bun scripts/build.mjs --skip-shell # everything except the installer
 *   HARNESS_TAURI_CLI=/path/to/tauri bun scripts/build.mjs
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";

const ROOT = join(import.meta.dir, "..");
const REPO = join(ROOT, "..");
const VENDOR = join(ROOT, "vendor", "opencode");
const BACKEND_DIR = join(ROOT, "backend");
const WEBVIEW_DIR = join(ROOT, "webview");
const SHELL_DIR = join(ROOT, "shell");
const TAURI_DIR = join(SHELL_DIR, "src-tauri");
const DELIVERY = join(ROOT, "delivery", "0.4.0");
const PRODUCT_NAME = "某科学的Agent";
const SKIP_SHELL = process.argv.includes("--skip-shell");
/** Jump straight to the installer (useful while iterating on the Rust shell). */
const ONLY_SHELL = process.argv.includes("--only-shell");
/** Repack the existing installer with fresh docs + digests; compiles nothing. */
const DELIVERY_ONLY = process.argv.includes("--delivery-only");

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const APP_VERSION = pkg.version;

function log(step, message) {
	console.log(`[build] ${step.padEnd(12)} ${message}`);
}

function run(cmd, options = {}) {
	const result = Bun.spawnSync({ cmd, cwd: options.cwd ?? ROOT, env: { ...process.env, ...(options.env ?? {}) }, stdout: "inherit", stderr: "inherit" });
	if (result.exitCode !== 0) throw new Error(`command failed (${result.exitCode}): ${cmd.join(" ")}`);
}

function capture(cmd, options = {}) {
	const result = Bun.spawnSync({ cmd, cwd: options.cwd ?? ROOT, env: { ...process.env, ...(options.env ?? {}) }, stdout: "pipe", stderr: "pipe" });
	return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

function sha256File(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Remove a directory even when files are locked on Windows. */
function cleanDir(path) {
	if (!existsSync(path)) return;
	try {
		rmSync(path, { recursive: true, force: true });
		return;
	} catch {
		// Fall back to moving it aside: never delete something we cannot verify.
		const aside = `${path}.stale-${Date.now()}`;
		renameSync(path, aside);
		log("clean", `moved ${relative(ROOT, path)} aside to ${relative(ROOT, aside)}`);
	}
}

/* ------------------------------------------------------------------ */
/* 1. vendored engine                                                  */
/* ------------------------------------------------------------------ */

function ensureEngine() {
	const pinPath = join(VENDOR, "PIN.json");
	if (!existsSync(pinPath)) throw new Error(`missing pinned engine manifest at ${pinPath}`);
	const pin = JSON.parse(readFileSync(pinPath, "utf8"));
	const binary = join(VENDOR, pin.server.binaryPath);
	if (!existsSync(binary)) {
		log("engine", "not vendored yet; fetching the pinned build");
		run(["bun", join(ROOT, "scripts", "fetch-opencode.mjs")]);
	}
	const digest = sha256File(binary);
	if (digest !== pin.server.binarySha256) {
		throw new Error(
			`[build] engine digest mismatch.\n  expected ${pin.server.binarySha256}\n  actual   ${digest}\n` +
				`Run: bun scripts/fetch-opencode.mjs --force`,
		);
	}
	log("engine", `OpenCode ${pin.version} verified (${statSync(binary).size} bytes)`);
	return pin;
}

/* ------------------------------------------------------------------ */
/* 2 + 3. webview + typecheck                                          */
/* ------------------------------------------------------------------ */

function buildWebview() {
	cleanDir(join(WEBVIEW_DIR, "dist"));
	run(["bun", "run", "build"], { cwd: WEBVIEW_DIR });
	log("webview", "bundle written to webview/dist");
}

function typecheck() {
	run(["bun", "run", "typecheck"], { cwd: BACKEND_DIR });
	log("typecheck", "backend ok");
	run(["bun", "run", "typecheck"], { cwd: WEBVIEW_DIR });
	log("typecheck", "webview ok");
}

/* ------------------------------------------------------------------ */
/* 4. backend executable                                               */
/* ------------------------------------------------------------------ */

/**
 * `bun build --compile` copies the *running* bun executable to a temp file, so a
 * bun installed under a non-ASCII path (common for Chinese user names on
 * Windows) fails with ENOENT. Copying bun to an ASCII staging directory first
 * makes the step portable without hard-coding anyone's machine layout.
 */
function bunForCompile() {
	const execPath = process.execPath;
	if (/^[\x20-\x7e]+$/.test(execPath)) return execPath;
	const candidates = [process.env.PUBLIC, process.env.SystemDrive ? `${process.env.SystemDrive}\\` : null, tmpdir()].filter(Boolean);
	for (const base of candidates) {
		const dir = join(base, "harness-build");
		try {
			mkdirSync(dir, { recursive: true });
			const target = join(dir, basename(execPath));
			if (!existsSync(target) || statSync(target).size !== statSync(execPath).size) {
				writeFileSync(target, readFileSync(execPath));
			}
			log("backend", `using an ASCII-path copy of bun: ${target}`);
			return target;
		} catch {
			/* try the next candidate */
		}
	}
	log("backend", "WARNING: bun lives under a non-ASCII path and no staging dir was writable; --compile may fail");
	return execPath;
}

function buildBackend() {
	const dist = join(BACKEND_DIR, "dist");
	mkdirSync(dist, { recursive: true });
	// Compile to a unique name first: the canonical file may be locked (antivirus,
	// indexers, or a running build), and failing the whole build for that would be
	// needless. We then try to promote it to the canonical path.
	const unique = join(dist, `harness-backend.${Date.now()}.exe`);
	cleanDir(unique);
	const bun = bunForCompile();
	run([bun, "build", "./src/index.ts", "--outfile", unique, "--target", "bun", "--compile"], { cwd: BACKEND_DIR });
	if (!existsSync(unique)) throw new Error("backend build produced no output");

	const canonical = join(dist, "harness-backend.exe");
	let produced = unique;
	try {
		rmSync(canonical, { force: true });
		renameSync(unique, canonical);
		produced = canonical;
	} catch {
		log("backend", `could not replace ${relative(ROOT, canonical)}; keeping ${relative(ROOT, unique)}`);
	}
	log("backend", `compiled ${relative(ROOT, produced)} (${statSync(produced).size} bytes)`);
	return produced;
}

/* ------------------------------------------------------------------ */
/* 5. stage for the shell                                              */
/* ------------------------------------------------------------------ */

/**
 * Put the freshly built backend where the shell embeds it from.
 *
 * `include_bytes!("../bin/harness-backend.exe")` needs the *canonical* name, so
 * unlike the runtime materialisation step there is no versioned fallback here:
 * embedding a stale backend silently would be worse than failing the build.
 */
function stageBackend(binary) {
	const binDir = join(TAURI_DIR, "bin");
	mkdirSync(binDir, { recursive: true });
	const canonical = join(binDir, "harness-backend.exe");
	const bytes = readFileSync(binary);
	const fresh = createHash("sha256").update(bytes).digest("hex");

	// Already identical? Nothing to do (and nothing to lock).
	if (existsSync(canonical)) {
		const existing = createHash("sha256").update(readFileSync(canonical)).digest("hex");
		if (existing === fresh) {
			log("stage", "backend already up to date in shell/src-tauri/bin");
			return;
		}
	}

	const temp = join(binDir, `harness-backend.new.exe`);
	writeFileSync(temp, bytes);
	try {
		rmSync(canonical, { force: true });
		renameSync(temp, canonical);
	} catch (error) {
		try {
			rmSync(temp, { force: true });
		} catch {}
		throw new Error(
			`cannot replace shell/src-tauri/bin/harness-backend.exe (${error.message}).\n` +
				`Close any running Harness/build and remove the file manually, then rebuild.`,
		);
	}
	const staged = createHash("sha256").update(readFileSync(canonical)).digest("hex");
	if (staged !== fresh) throw new Error("staged backend does not match the fresh build");
	log("stage", "backend staged into shell/src-tauri/bin (digest matches the fresh build)");
}

/* ------------------------------------------------------------------ */
/* 6. installer                                                        */
/* ------------------------------------------------------------------ */

/**
 * Resolve a runnable Tauri CLI without assuming a specific shell.
 *
 * Preference order:
 *   1. `HARNESS_TAURI_CLI` (any command prefix; a `.js` entry is run with node)
 *   2. the workspace's `@tauri-apps/cli` JS entry, run with a real `node`
 *   3. the POSIX `node_modules/.bin/tauri` shim
 *   4. `bunx @tauri-apps/cli` (downloads on demand)
 */
function resolveTauriCli() {
	const override = process.env.HARNESS_TAURI_CLI;
	if (override) {
		return override.endsWith(".js") ? [...nodeCommand(), override] : [override];
	}
	const cliMain = join(ROOT, "node_modules", "@tauri-apps", "cli", "tauri.js");
	if (existsSync(cliMain)) return [...nodeCommand(), cliMain];
	const shim = join(ROOT, "node_modules", ".bin", "tauri");
	if (existsSync(shim)) return [shim];
	return ["bunx", "@tauri-apps/cli"];
}

/** A node executable to run the Tauri CLI JS entry with. */
function nodeCommand() {
	const explicit = process.env.HARNESS_NODE;
	if (explicit && existsSync(explicit)) return [explicit];
	const found = Bun.which("node");
	if (found) return [found];
	const managed = join(homedir(), ".workbuddy", "binaries", "node", "versions", "22.22.2", "node.exe");
	if (existsSync(managed)) return [managed];
	return ["node"];
}

function buildShell() {
	const cli = resolveTauriCli();
	// The Cargo target directory is configurable: shared or CI machines sometimes
	// have an unusable `target/` (ACLs, A/V holds, a crashed build's lock files),
	// and re-pointing cargo is the only reliable escape.
	const targetDir = process.env.HARNESS_CARGO_TARGET_DIR
		? resolve(process.env.HARNESS_CARGO_TARGET_DIR)
		: join(TAURI_DIR, "target");
	log("shell", `using tauri cli: ${cli.join(" ")}`);
	log("shell", `cargo target dir: ${targetDir}`);
	run([...cli, "build", "--", ...(targetDir !== join(TAURI_DIR, "target") ? ["--target-dir", targetDir] : [])], { cwd: SHELL_DIR });
	const bundleDir = join(targetDir, "release", "bundle", "nsis");
	if (!existsSync(bundleDir)) throw new Error(`expected the NSIS output at ${bundleDir}`);
	const installers = readdirSync(bundleDir).filter((file) => file.endsWith(`_${APP_VERSION}_x64-setup.exe`));
	if (!installers.length) throw new Error("no installer was produced");
	log("shell", `installer: ${installers.join(", ")}`);
	return installers.map((file) => join(bundleDir, file));
}

/* ------------------------------------------------------------------ */
/* 7. delivery                                                         */
/* ------------------------------------------------------------------ */

function collectDelivery(installers) {
	mkdirSync(DELIVERY, { recursive: true });
	const copied = [];
	for (const installer of installers) {
		const target = join(DELIVERY, `${PRODUCT_NAME}_${APP_VERSION}_x64-setup.exe`);
		const bytes = readFileSync(installer);
		writeFileSync(target, bytes);
		copied.push(target);
		log("delivery", `${basename(installer)} -> ${relative(ROOT, target)}`);
	}
	for (const doc of ["HARNESS.md", "UPSTREAM.md", "VALIDATION.md", "THIRD-PARTY-NOTICES.md"]) {
		const source = join(ROOT, doc);
		if (!existsSync(source)) continue;
		const target = join(DELIVERY, doc);
		writeFileSync(target, readFileSync(source));
		copied.push(target);
	}
	const manifest = [`# ${PRODUCT_NAME} delivery manifest`, `# version: ${APP_VERSION}`, `# generated: ${new Date().toISOString()}`, ""];
	for (const file of copied.sort()) {
		manifest.push(`${sha256File(file)}  ${basename(file)}`);
	}
	// Include the newest source snapshot. If several exist (a stale archive that
	// the host will not let us delete), only the freshest one is a deliverable.
	const snapshots = readdirSync(DELIVERY)
		.filter((file) => file.endsWith(`-${APP_VERSION}-source.zip`) || file.endsWith(`-${APP_VERSION}-source.tar.gz`))
		.map((file) => ({ file, mtime: statSync(join(DELIVERY, file)).mtimeMs }))
		.sort((a, b) => b.mtime - a.mtime);
	const snapshot = snapshots[0];
	if (snapshot) {
		manifest.push(`${sha256File(join(DELIVERY, snapshot.file))}  ${snapshot.file}`);
		for (const stale of snapshots.slice(1)) {
			manifest.push(`# NOTE: ${stale.file} is stale and could not be deleted by the build; remove it manually.`);
		}
	}
	writeFileSync(join(DELIVERY, "SHA256SUMS.txt"), manifest.join("\n") + "\n", "utf8");
	log("delivery", `SHA256SUMS.txt rewritten for ${manifest.filter((line) => !line.startsWith("#")).length} files`);
}

/* ------------------------------------------------------------------ */

function main() {
	log("version", `${APP_VERSION} (repo ${relative(REPO, ROOT)})`);
	if (DELIVERY_ONLY) {
		// Repack an already-built installer with the current docs + digests, without
		// recompiling anything. Used when only documentation changed.
		const targetDir = process.env.HARNESS_CARGO_TARGET_DIR
			? resolve(process.env.HARNESS_CARGO_TARGET_DIR)
			: join(TAURI_DIR, "target");
		const bundleDir = join(targetDir, "release", "bundle", "nsis");
		if (!existsSync(bundleDir)) throw new Error(`no bundle at ${bundleDir}`);
		const installers = readdirSync(bundleDir)
			.filter((file) => file.endsWith(`_${APP_VERSION}_x64-setup.exe`))
			.map((file) => join(bundleDir, file));
		collectDelivery(installers);
		log("done", "delivery refreshed (--delivery-only)");
		return;
	}
	ensureEngine();
	if (!ONLY_SHELL) {
		buildWebview();
		typecheck();
		const backend = buildBackend();
		stageBackend(backend);
	} else {
		log("skip", "webview / typecheck / backend (--only-shell)");
	}
	if (SKIP_SHELL) {
		log("done", "skipped the installer step (--skip-shell)");
		return;
	}
	const installers = buildShell();
	collectDelivery(installers);
	log("done", "build complete");
}

main();
