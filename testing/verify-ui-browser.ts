/** Production React components in Edge headless; not a substitute for native desktop clicking. */
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dir, "..");
const edge = process.env.HARNESS_BROWSER || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
if (!existsSync(edge)) throw new Error("Set HARNESS_BROWSER to a Chromium-based browser executable.");
const version = (await Bun.file(join(root, "package.json")).json() as { version: string }).version;
const out = join(root, "delivery", "qa", version);
await mkdir(out, { recursive: true });
const built = await Bun.build({ entrypoints: [join(root, "webview", "testing", "ui-browser-fixture.tsx")], target: "browser", minify: true });
if (!built.success) throw new Error(built.logs.map(String).join("\n"));
const css = (await Promise.all(["index.css", "index-engine.css", "index-codex.css", "theme-presets.css"].map((file) => readFile(join(root, "webview", "src", file), "utf8")))).join("\n");
await cp(join(root, "webview", "src", "assets", "theme"), join(out, "assets", "theme"), { recursive: true });
for (const asset of built.outputs.filter((output) => output.kind === "asset")) await writeFile(join(out, asset.path.split(/[\\/]/).at(-1)!), await asset.arrayBuffer());
const script = (await built.outputs.find((output) => output.kind === "entry-point")!.text()).replace(/<\/script/gi, "<\\/script");
const html = join(out, "ui.html");
await writeFile(html, `<!doctype html><meta charset="utf-8"><style>${css}</style><div id="root"></div><script>${script}</script>`);
const reports: unknown[] = [];
for (const sample of [
  { name: "layout-new-work", theme: "dark", width: 1280 },
  { name: "layout-new-chat", theme: "light", width: 1280 },
  { name: "layout-short", theme: "dark", width: 1280 },
  { name: "layout-long", theme: "dark", width: 900 },
  { name: "layout-completed", theme: "dark", width: 1280 },
  { name: "settings", theme: "dark", width: 1280 },
  { name: "personal", theme: "dark", width: 1280 },
  { name: "personal-light", theme: "light", width: 1280 },
  { name: "personal-narrow", theme: "dark", width: 900 },
  { name: "upload", theme: "dark", width: 1280 },
  { name: "question", theme: "dark", width: 1280 },
  { name: "trace-dark", theme: "dark", width: 1280 },
  { name: "trace-light", theme: "light", width: 1280 },
  { name: "trace-narrow", theme: "dark", width: 900 },
  { name: "fairy-dark", theme: "dark", width: 1280 },
  { name: "fairy-light", theme: "light", width: 1280 },
  { name: "klee-dark", theme: "dark", width: 1280 },
  { name: "klee-light", theme: "light", width: 1280 },
  { name: "fairy-work-dark", theme: "dark", width: 1280 },
  { name: "klee-work-light", theme: "light", width: 1280 },
]) {
  const profile = await mkdtemp(join(tmpdir(), "harness-ui-browser-"));
  const preset = sample.name.startsWith("fairy") ? "fairy" : sample.name.startsWith("klee") ? "klee" : "classic";
  const url = `${pathToFileURL(html).href}?view=${sample.name.startsWith("layout-") ? "layout" : preset !== "classic" ? "theme" : sample.name === "settings" ? "settings" : sample.name.startsWith("personal") ? "personal" : sample.name === "upload" ? "upload" : sample.name === "question" ? "question" : "trace"}&sample=${sample.name}&theme=${sample.theme}&preset=${preset}&home=${sample.name.includes("-work-") ? "1" : "0"}`;
  const proc = Bun.spawn({ cmd: [edge, "--headless=new", "--disable-gpu", "--no-first-run", "--allow-file-access-from-files", `--user-data-dir=${profile}`, `--window-size=${sample.width},900`, "--virtual-time-budget=5000", "--dump-dom", `--screenshot=${join(out, sample.name + ".png")}`, url], stdout: "pipe", stderr: "pipe", windowsHide: true });
  const dom = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;
  const match = dom.match(/<script id="ui-qa-result" type="application\/json">([\s\S]*?)<\/script>/);
  if (!match) { await writeFile(join(out, sample.name + ".dom.txt"), dom + "\n" + stderr); throw new Error(`Browser checks did not complete: ${sample.name}`); }
  const checks = JSON.parse(match[1]) as Array<{ name: string; ok: boolean }>;
  reports.push({ sample: sample.name, checks });
  for (const check of checks) console.log(`${check.ok ? "PASS" : "FAIL"} ${sample.name}: ${check.name}`);
  if (checks.some((check) => !check.ok)) throw new Error(`Browser check failed: ${sample.name}`);
}
await writeFile(join(out, "ui-report.json"), JSON.stringify(reports, null, 2));
console.log(`Browser interaction and visual samples passed: ${out}`);
