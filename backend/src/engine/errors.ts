/**
 * Harness backend — engine call diagnostics.
 *
 * Every failure surfaced to the user is classified so the message can say what
 * actually went wrong (bad key, missing model, wrong protocol, network, timeout)
 * instead of dumping a raw fetch error. Messages never contain the API key.
 */

export type EngineErrorKind =
	| "engine-not-running"
	| "engine-crashed"
	| "engine-timeout"
	| "auth"
	| "model-not-found"
	| "protocol-mismatch"
	| "rate-limited"
	| "network"
	| "aborted"
	| "unknown";

export interface EngineFailure {
	kind: EngineErrorKind;
	message: string;
	/** Redacted technical detail for the diagnostics panel. */
	detail?: string;
	/** Whether a retry is likely to help. */
	retryable: boolean;
}

const MESSAGES: Record<EngineErrorKind, string> = {
	"engine-not-running": "执行引擎未运行。请重试；若反复失败，请打开诊断查看引擎日志。",
	"engine-crashed": "执行引擎意外退出，当前任务已标记为中断。不会自动重发你的消息或命令。",
	"engine-timeout": "执行引擎响应超时。",
	auth: "API Key 无效或已过期，请在设置中重新填写。",
	"model-not-found": "模型不存在或无权访问，请检查模型 ID 是否正确。",
	"protocol-mismatch": "接口协议不兼容：请确认所选协议（Chat Completions / Anthropic Messages）与端点匹配。",
	"rate-limited": "请求被限流（429），请稍后重试或更换 Key。",
	network: "网络请求失败，无法连接模型服务。",
	aborted: "任务已取消。",
	unknown: "执行引擎调用失败。",
};

function redact(text: string): string {
	return text
		.replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***")
		.replace(/(api[-_]?key|authorization|token)["'\s:=]+[A-Za-z0-9._-]{8,}/gi, "$1=***")
		.replace(/Basic\s+[A-Za-z0-9+/=]{8,}/gi, "Basic ***");
}

function collectText(error: unknown, depth = 0): string {
	if (depth > 4 || error == null) return "";
	if (typeof error === "string") return error;
	if (error instanceof Error) {
		const cause = (error as Error & { cause?: unknown }).cause;
		const code = typeof (error as Error & { code?: unknown }).code === "string" ? String((error as Error & { code?: unknown }).code) : "";
		return [error.name, error.message, code, collectText(cause, depth + 1)].filter(Boolean).join(" | ");
	}
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

export function classifyEngineError(error: unknown): EngineFailure {
	const text = collectText(error);
	const lower = text.toLowerCase();
	let kind: EngineErrorKind = "unknown";

	if (/abort/i.test(text)) kind = "aborted";
	else if (/timeout|timed out|etimedout/.test(lower)) kind = "engine-timeout";
	else if (/401|unauthor|invalid[_ ]api[_ ]key|authentication|no api key|missing.*credential/.test(lower)) kind = "auth";
	else if (/429|rate.?limit|quota/.test(lower)) kind = "rate-limited";
	else if (/supported api model names|model.?(not|does not).?(exist|found)|unknown model|no such model|invalid model|404/.test(lower))
		kind = "model-not-found";
	else if (
		/unable to connect|econnrefused|enotfound|econnreset|econnaborted|epipe|fetch failed|failed to fetch|network|connection (refused|closed|reset)|socket|dns|proxy/.test(
			lower,
		)
	)
		kind = "network";
	else if (/unsupported|not supported|responses api|incompatible|invalid[_ ]request|400/.test(lower))
		kind = "protocol-mismatch";
	else if (/engine not running|not running|未启动/.test(lower)) kind = "engine-not-running";
	else if (/exited|crash/.test(lower)) kind = "engine-crashed";

	const retryable = kind === "network" || kind === "rate-limited" || kind === "engine-timeout" || kind === "engine-not-running";
	return { kind, message: MESSAGES[kind], detail: redact(text).slice(0, 1200), retryable };
}

/** An error whose message is already user-facing and must not be re-classified. */
export class UserFacingError extends Error {
	readonly userFacing = true;
	constructor(message: string) {
		super(message);
		this.name = "UserFacingError";
	}
}

export function userError(message: string): UserFacingError {
	return new UserFacingError(message);
}

/** Wrap any error into a user-facing Error while keeping the classification. */
export function engineError(error: unknown): Error & { failure: EngineFailure } {
	const failure = classifyEngineError(error);	const wrapped = new Error(`${failure.message}${failure.detail ? `（${failure.detail}）` : ""}`) as Error & {
		failure: EngineFailure;
	};
	wrapped.failure = failure;
	return wrapped;
}

export function redactText(text: string): string {
	return redact(text);
}
