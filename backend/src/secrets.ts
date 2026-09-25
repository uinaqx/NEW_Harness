/**
 * Harness backend — credential protection.
 *
 * Secrets (the provider API key) are wrapped with the Windows Data Protection
 * API in the caller's user scope, via a direct crypt32.dll FFI call. No
 * synchronous PowerShell subprocess, no key material in argv, no plaintext on
 * disk. Decryption only succeeds for the same Windows user on the same machine.
 *
 * On non-Windows platforms there is no DPAPI; we fall back to a 0600 file with
 * an explicit marker so that a failure to protect is visible rather than silent.
 */
import { dlopen, FFIType, ptr, toArrayBuffer } from "bun:ffi";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const CRYPTPROTECT_UI_FORBIDDEN = 0x1;
/** The DATA_BLOB struct is { DWORD cbData; BYTE *pbData; } — 16 bytes on x64. */
const BLOB_SIZE = 16;

/** Optional entropy binds the ciphertext to this application. */
const ENTROPY = new TextEncoder().encode("AgentHarness/credentials/v1");

/**
 * Typed-array views handed to native code must outlive the call. Bun does not
 * keep JS values alive merely because their pointer was taken, so we hold the
 * backing buffers in a module-level list and release them right after use.
 */
const pinned: Uint8Array[] = [];
function pin(buffer: Uint8Array): Uint8Array {
	pinned.push(buffer);
	return buffer;
}

type NativeLib = ReturnType<typeof dlopen>;

/** CryptProtectData / CryptUnprotectData share this signature shape (7 args). */
type ProtectFn = (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => number;

let crypt32: NativeLib | null | undefined;
let kernel: NativeLib | null | undefined;

function isWindows(): boolean {
	return process.platform === "win32";
}

function library(): NativeLib | null {
	if (crypt32 === undefined) {
		try {
			crypt32 = dlopen("crypt32.dll", {
				CryptProtectData: {
					args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr],
					returns: FFIType.i32,
				},
				CryptUnprotectData: {
					args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr],
					returns: FFIType.i32,
				},
			});
			kernel = dlopen("kernel32.dll", { LocalFree: { args: [FFIType.ptr], returns: FFIType.ptr } });
		} catch {
			crypt32 = null;
			kernel = null;
		}
	}
	return crypt32 ?? null;
}

/** Fill a DATA_BLOB at `blobPtr` with a copy of `data`; returns the payload ptr. */
function writeBlob(blobPtr: number, data: Uint8Array): number {
	const payload = new Uint8Array(data.length + 1);
	payload.set(data, 0);
	pin(payload);
	const dataPtr = Number(ptr(payload));
	new DataView(toArrayBuffer(blobPtr, 0, BLOB_SIZE)).setUint32(0, data.length, true);
	new BigUint64Array(toArrayBuffer(blobPtr, 8, 8))[0] = BigInt(dataPtr);
	return dataPtr;
}

function allocateBlob(): number {
	const buffer = new Uint8Array(BLOB_SIZE);
	pin(buffer);
	return Number(ptr(buffer));
}

function readBlob(blobPtr: number): Uint8Array {
	const view = new DataView(toArrayBuffer(blobPtr, 0, BLOB_SIZE));
	const length = view.getUint32(0, true);
	const dataPtr = Number(new BigUint64Array(toArrayBuffer(blobPtr, 8, 8))[0]);
	if (!length || !dataPtr) return new Uint8Array(0);
	const out = new Uint8Array(toArrayBuffer(dataPtr, 0, length));
	const copy = new Uint8Array(out);
	try {
		const free = kernel?.symbols.LocalFree as unknown as ((ptr: number) => number) | undefined;
		free?.(dataPtr);
	} catch {
		/* best effort */
	}
	return copy;
}

export interface ProtectResult {
	/** Ciphertext bytes (DPAPI blob, or the AES-less plaintext fallback). */
	data: Uint8Array;
	/** "dpapi" when the OS protected it, "plaintext-fallback" otherwise. */
	method: "dpapi" | "plaintext-fallback";
}

export function protect(secret: Uint8Array): ProtectResult {
	const lib = library();
	const call = lib?.symbols.CryptProtectData as unknown as ProtectFn | undefined;
	if (!call) {
		return { data: secret, method: "plaintext-fallback" };
	}
	try {
		const inBlob = allocateBlob();
		writeBlob(inBlob, secret);
		const entropyBlob = allocateBlob();
		writeBlob(entropyBlob, ENTROPY);
		const outBlob = allocateBlob();
		const ok = call(inBlob, 0, entropyBlob, 0, 0, CRYPTPROTECT_UI_FORBIDDEN, outBlob);
		if (!ok) throw new Error("CryptProtectData returned 0");
		return { data: readBlob(outBlob), method: "dpapi" };
	} finally {
		pinned.length = 0;
	}
}

export function unprotect(ciphertext: Uint8Array): { data: Uint8Array; method: ProtectResult["method"] } {
	const lib = library();
	const call = lib?.symbols.CryptUnprotectData as unknown as ProtectFn | undefined;
	if (!call) {
		return { data: ciphertext, method: "plaintext-fallback" };
	}
	try {
		const inBlob = allocateBlob();
		writeBlob(inBlob, ciphertext);
		const entropyBlob = allocateBlob();
		writeBlob(entropyBlob, ENTROPY);
		const outBlob = allocateBlob();
		const ok = call(inBlob, 0, entropyBlob, 0, 0, CRYPTPROTECT_UI_FORBIDDEN, outBlob);
		if (!ok) throw new Error("CryptUnprotectData returned 0");
		return { data: readBlob(outBlob), method: "dpapi" };
	} finally {
		pinned.length = 0;
	}
}

export function isOsProtected(): boolean {
	if (!isWindows()) return false;
	const lib = library();
	return !!lib?.symbols.CryptProtectData;
}

/* ------------------------------------------------------------------ */
/* File-backed credential store                                        */
/* ------------------------------------------------------------------ */

interface CredentialFile {
	version: 1;
	method: ProtectResult["method"];
	/** Base64 of the protected payload. */
	payload: string;
	updatedAt: number;
}

function decode(file: string): Uint8Array | null {
	if (!existsSync(file)) return null;
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as CredentialFile;
		if (!parsed?.payload) return null;
		return new Uint8Array(Buffer.from(parsed.payload, "base64"));
	} catch {
		return null;
	}
}

export function saveCredential(file: string, secret: string): ProtectResult["method"] {
	mkdirSync(dirname(file), { recursive: true });
	const { data, method } = protect(new TextEncoder().encode(secret));
	const body: CredentialFile = {
		version: 1,
		method,
		payload: Buffer.from(data).toString("base64"),
		updatedAt: Date.now(),
	};
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, JSON.stringify(body), { encoding: "utf8" });
	if (process.platform !== "win32") {
		try {
			chmodSync(tmp, 0o600);
		} catch {}
	}
	renameSync(tmp, file);
	return method;
}

export function loadCredential(file: string): string | null {
	const ciphertext = decode(file);
	if (!ciphertext) return null;
	try {
		const { data } = unprotect(ciphertext);
		return new TextDecoder().decode(data);
	} catch {
		return null;
	}
}

export function clearCredential(file: string): void {
	if (!existsSync(file)) return;
	writeFileSync(file, "", { encoding: "utf8" });
}

/** Never return the key itself — only whether it exists plus a display mask. */
export function maskSecret(secret: string | null): string | null {
	if (!secret) return null;
	if (secret.length <= 8) return "•".repeat(secret.length);
	return `${secret.slice(0, 3)}${"•".repeat(8)}${secret.slice(-4)}`;
}
