#!/usr/bin/env bun
/**
 * Fetch the pinned OpenCode build into harness/vendor/opencode.
 *
 * - The version and digests live in vendor/opencode/PIN.json; nothing uses a
 *   floating `latest`.
 * - Every download is verified against the recorded SHA-256 before it is used,
 *   and a mismatch refuses to overwrite a good local copy silently.
 *
 * Usage: bun scripts/fetch-opencode.mjs [--force]
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const VENDOR = join(ROOT, "vendor", "opencode");
const PIN_PATH = join(VENDOR, "PIN.json");
const FORCE = process.argv.includes("--force");

function sha256(buffer) {
	return createHash("sha256").update(buffer).digest("hex");
}

async function download(url, label) {
	console.log(`  downloading ${label} …`);
	const response = await fetch(url);
	if (!response.ok) throw new Error(`${label}: HTTP ${response.status}`);
	return Buffer.from(await response.arrayBuffer());
}

/** Extract a single member from a .tgz without external tools. */
function extractMember(tarball, memberName) {
	// Bun ships DecompressionStream; gunzip then walk the tar records.
	const gz = Bun.gunzipSync(tarball);
	let offset = 0;
	while (offset + 512 <= gz.length) {
		const header = gz.subarray(offset, offset + 512);
		const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
		if (!name) break;
		const size = parseInt(header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim() || "0", 8);
		const contentStart = offset + 512;
		if (name === memberName || name.endsWith(`/${memberName}`)) {
			return gz.subarray(contentStart, contentStart + size);
		}
		offset = contentStart + Math.ceil(size / 512) * 512;
	}
	throw new Error(`member ${memberName} not found in the archive`);
}

/** Extract the whole archive into a directory. */
function extractAll(tarball, destination) {
	const gz = Bun.gunzipSync(tarball);
	let offset = 0;
	while (offset + 512 <= gz.length) {
		const header = gz.subarray(offset, offset + 512);
		const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
		if (!name) break;
		const size = parseInt(header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim() || "0", 8);
		const type = String.fromCharCode(header[156]);
		const contentStart = offset + 512;
		if (type === "0" || type === "\0") {
			const relative = name.replace(/^package\//, "");
			const target = join(destination, relative);
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, gz.subarray(contentStart, contentStart + size));
		}
		offset = contentStart + Math.ceil(size / 512) * 512;
	}
}

async function main() {
	if (!existsSync(PIN_PATH)) {
		rmSync(VENDOR, { recursive: true, force: true });
		throw new Error(`missing ${PIN_PATH}; restore the pinned manifest from the source snapshot first`);
	}
	const pin = JSON.parse(readFileSync(PIN_PATH, "utf8"));
	console.log(`[fetch-opencode] pinned OpenCode ${pin.version} (${pin.server.package})`);

	const binaryPath = join(VENDOR, pin.server.binaryPath);
	if (existsSync(binaryPath) && !FORCE) {
		const digest = sha256(readFileSync(binaryPath));
		if (digest === pin.server.binarySha256) {
			console.log(`[fetch-opencode] engine already present and verified: ${binaryPath}`);
		} else {
			throw new Error(
				`[fetch-opencode] local engine digest mismatch.\n  expected ${pin.server.binarySha256}\n  actual   ${digest}\nRe-run with --force to re-download.`,
			);
		}
	} else {
		const tarball = await download(pin.server.artifactUrl, pin.server.package);
		const digest = sha256(tarball);
		if (digest !== pin.server.tarballSha256) {
			throw new Error(`[fetch-opencode] tarball digest mismatch.\n  expected ${pin.server.tarballSha256}\n  actual   ${digest}`);
		}
		const binary = extractMember(tarball, pin.server.binaryPath);
		const binaryDigest = sha256(binary);
		if (binaryDigest !== pin.server.binarySha256) {
			throw new Error(
				`[fetch-opencode] engine digest mismatch.\n  expected ${pin.server.binarySha256}\n  actual   ${binaryDigest}`,
			);
		}
		mkdirSync(dirname(binaryPath), { recursive: true });
		const staging = `${binaryPath}.tmp`;
		writeFileSync(staging, binary);
		renameSync(staging, binaryPath);
		console.log(`[fetch-opencode] engine staged: ${binaryPath} (${binary.length} bytes, sha256 verified)`);
	}

	// The SDK is vendored so the backend bundles it at build time.
	const sdkDir = join(VENDOR, "sdk");
	if (!existsSync(join(sdkDir, "dist", "client.js")) || FORCE) {
		const tarball = await download(pin.sdk.artifactUrl, pin.sdk.package);
		const digest = sha256(tarball);
		if (digest !== pin.sdk.tarballSha256) {
			throw new Error(`[fetch-opencode] SDK digest mismatch.\n  expected ${pin.sdk.tarballSha256}\n  actual   ${digest}`);
		}
		extractAll(tarball, sdkDir);
		console.log(`[fetch-opencode] SDK staged: ${sdkDir}`);
	} else {
		console.log(`[fetch-opencode] SDK already present: ${sdkDir}`);
	}

	// Keep the upstream licence alongside the binary.
	const licence = join(VENDOR, "LICENSE");
	if (!existsSync(licence) || FORCE) {
		const tarball = await download(pin.cli.artifactUrl, pin.cli.package);
		writeFileSync(licence, extractMember(tarball, "LICENSE"));
		console.log(`[fetch-opencode] upstream licence written: ${licence}`);
	}
	console.log("[fetch-opencode] done");
}

await main();
