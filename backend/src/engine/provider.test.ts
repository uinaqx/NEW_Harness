import { expect, test } from "bun:test";
import { defaultSettings } from "../app-settings";
import { buildOpenCodeConfig } from "./provider";

test("approval modes preserve the requested permission boundary", () => {
	const settings = defaultSettings();
	const permission = () => buildOpenCodeConfig({ settings, apiKey: "test" }).permission;
	expect(permission()).toMatchObject({ edit: "ask", bash: "ask", external_directory: "ask", webfetch: "deny" });
	settings.autoApproveEdits = true;
	settings.autoApproveCommands = true;
	expect(permission()).toMatchObject({ edit: "allow", bash: "allow", external_directory: "ask", webfetch: "deny" });
	settings.fullAccess = true;
	expect(permission()).toMatchObject({ edit: "allow", bash: "allow", external_directory: "allow", webfetch: "allow" });
	settings.autoApproveEdits = false;
	settings.autoApproveCommands = false;
	expect(permission()).toMatchObject({ edit: "allow", bash: "allow", external_directory: "allow", webfetch: "allow" });
});
