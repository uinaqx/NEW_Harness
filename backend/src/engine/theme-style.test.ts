import { expect, test } from "bun:test";
import { themeStyleGuidance } from "./theme-style";
import { buildOpenCodeConfig } from "./provider";
import { defaultSettings } from "../app-settings";

test("classic keeps the existing prompt unchanged", () => {
	expect(themeStyleGuidance("classic")).toBe("");
});

test("character work agents keep questions and chat agents keep all tools disabled", () => {
	const config = buildOpenCodeConfig({ settings: defaultSettings(), apiKey: "test-only" });
	for (const theme of ["fairy", "klee"]) {
		const agents = config.agent as Record<string, any>;
		expect(agents[`harness-${theme}-work`].permission.question).toBe("allow");
		expect(agents[`harness-${theme}-plan`].permission.edit).toBe("deny");
		expect(agents[`harness-${theme}-plan`].permission.question).toBe("allow");
		expect(agents[`harness-${theme}-chat`].tools.question).toBe(false);
		expect(agents[`harness-${theme}-chat`].permission["*"]).toBe("deny");
	}
});

test("each character contributes distinct style without replacing task safeguards", () => {
	const fairy = themeStyleGuidance("fairy");
	const klee = themeStyleGuidance("klee");
	expect(fairy).toContain("冷静");
	expect(klee).toContain("轻快");
	expect(fairy).toContain("玲和哲");
	expect(fairy).toContain("“主人”");
	expect(klee).toContain("“荣誉骑士”或“旅行者”");
	for (const style of [fairy, klee]) {
		expect(style).toContain("遵守用户任务、工具授权和步骤格式");
		expect(style).toContain("不要自称 OpenCode");
		expect(style).toContain("最终答复只用中文");
		expect(style).toContain("不要编造");
	}
});
