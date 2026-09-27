/** Tauri resets the build binary to UNK after packaging; NSIS embeds NSS. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const installedDir = process.argv[2] ?? join(process.env.LOCALAPPDATA ?? "", "某科学的Agent");
const built = await readFile(join(root, "shell", "src-tauri", "target", "release", "harness-shell.exe"));
const installed = await readFile(join(installedDir, "harness-shell.exe"));
const marker = Buffer.from("__TAURI_BUNDLE_TYPE_VAR_");
const unbundledMarker = Buffer.concat([marker, Buffer.from("UNK")]);
const offset = built.indexOf(unbundledMarker);
if (offset < 0 || built.indexOf(unbundledMarker, offset + 1) !== -1 || !installed.subarray(offset, offset + marker.length).equals(marker)) throw new Error("Missing or ambiguous Tauri bundle type marker.");
const valueOffset = offset + marker.length;
if (built.subarray(valueOffset, valueOffset + 3).toString() !== "UNK" || installed.subarray(valueOffset, valueOffset + 3).toString() !== "NSS") throw new Error("Unexpected Tauri bundle type value.");
const normalized = Buffer.from(installed);
built.copy(normalized, valueOffset, valueOffset, valueOffset + 3);
if (!normalized.equals(built)) throw new Error("Installed shell differs beyond the documented three-byte NSIS bundle type marker.");
const pin = JSON.parse(await readFile(join(root, "vendor", "opencode", "PIN.json"), "utf8"));
const engine = await readFile(join(installedDir, "opencode", "opencode.exe"));
const sha256 = (buffer: Buffer) => createHash("sha256").update(buffer).digest("hex");
if (sha256(engine) !== pin.server.binarySha256) throw new Error("Installed OpenCode engine hash mismatch.");
console.log(JSON.stringify({ passed: true, bundleType: "UNK -> NSS (only three bytes differ)", installedShellSha256: sha256(installed), builtShellSha256: sha256(built), engineSha256: sha256(engine) }, null, 2));
