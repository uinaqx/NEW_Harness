/** Use the Windows per-user proxy when a desktop launch has no proxy env vars. */
const INTERNET_SETTINGS = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

function registryValue(name: string): string | undefined {
	try {
		const result = Bun.spawnSync(["reg", "query", INTERNET_SETTINGS, "/v", name], {
			stdout: "pipe", stderr: "ignore", windowsHide: true,
		});
		if (result.exitCode !== 0) return;
		const line = result.stdout.toString().split(/\r?\n/).find((entry) => entry.includes(name) && entry.includes("REG_"));
		return line?.match(/REG_\w+\s+(.+)$/)?.[1]?.trim();
	} catch { return; }
}

function systemProxy(protocol: "http:" | "https:"): string | undefined {
	if (process.platform !== "win32" || registryValue("ProxyEnable") !== "0x1") return;
	const raw = registryValue("ProxyServer");
	if (!raw) return;
	const server = raw.includes("=")
		? raw.split(";").map((part) => part.trim()).find((part) => part.toLowerCase().startsWith(`${protocol.slice(0, -1)}=`))?.split("=").slice(1).join("=")
		: raw;
	if (!server) return;
	const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(server) ? server : `http://${server}`;
	try { return new URL(candidate).toString(); } catch { return; }
}

/** Set before starting OpenCode; its outbound HTTP client reads these at spawn. */
export function applySystemProxy(): void {
	if (process.platform !== "win32") return;
	for (const [protocol, key] of [["http:", "HTTP_PROXY"], ["https:", "HTTPS_PROXY"]] as const) {
		if (process.env[key] || process.env[key.toLowerCase()]) continue;
		const proxy = systemProxy(protocol);
		if (proxy) process.env[key] = proxy;
	}
	if (!process.env.NO_PROXY && !process.env.no_proxy) process.env.NO_PROXY = "127.0.0.1,localhost,::1";
}

/** Bun's fetch snapshots proxy environment early, so pass it per request too. */
export function proxyForUrl(url: string): string | undefined {
	let parsed: URL;
	try { parsed = new URL(url); } catch { return; }
	if (["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname)) return;
	const key = parsed.protocol === "https:" ? "HTTPS_PROXY" : "HTTP_PROXY";
	return process.env[key] || process.env[key.toLowerCase()] || systemProxy(parsed.protocol as "http:" | "https:");
}
