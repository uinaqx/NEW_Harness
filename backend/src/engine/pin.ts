/**
 * Harness backend — the pinned engine version.
 *
 * `PIN.json` is the single source of truth; it is copied verbatim from what
 * `scripts/fetch-opencode.mjs` downloaded and verified. Anything that needs the
 * exact upstream version, artifact URL or digest reads it from here — there is
 * no floating `latest` anywhere in the build.
 *
 * The JSON is inlined at bundle time, so the compiled backend has no runtime
 * dependency on the vendor directory.
 */
import pin from "../../../vendor/opencode/PIN.json";

export interface OpenCodePin {
	version: string;
	channel: string;
	server: {
		package: string;
		artifactUrl: string;
		tarballSha256: string;
		tarballSize: number;
		binaryPath: string;
		binarySize: number;
		binarySha256: string;
	};
	cli: { package: string; artifactUrl: string; tarballSha256: string; tarballSize: number };
	sdk: { package: string; artifactUrl: string; tarballSha256: string; tarballSize: number };
}

export const OPENCODE_PIN: OpenCodePin = pin as OpenCodePin;

export const ENGINE_VERSION = OPENCODE_PIN.version;
export const ENGINE_BINARY_SHA256 = OPENCODE_PIN.server.binarySha256;
export const ENGINE_BINARY_SIZE = OPENCODE_PIN.server.binarySize;
export const ENGINE_LICENSE = "MIT (Copyright (c) 2025 opencode)";
export const ENGINE_UPSTREAM = `npm ${OPENCODE_PIN.server.package}@${OPENCODE_PIN.version}`;
export const ENGINE_SDK_VERSION = `@opencode-ai/sdk@${OPENCODE_PIN.version}`;
