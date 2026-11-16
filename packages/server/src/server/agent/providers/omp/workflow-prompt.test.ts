import { describe, expect, test } from "vitest";

import { buildOmpToolIntentPrompt, getOmpWorkflowDisplayText } from "./workflow-prompt.js";

describe("skill tool intent locale", () => {
  test.each([
    {
      prompt: "/skill:ego-browser 帮我生成 0.7.0 的 release",
      name: "ego-browser",
      locale: "zh-CN",
    },
    { prompt: "/skill:ego-browser", name: "ego-browser", locale: "en" },
    {
      prompt: "  /skill:plugin/browser\t\ninspect the page\n",
      name: "plugin/browser",
      locale: "ja",
    },
    { prompt: "/skill:browser \t", name: "browser", locale: "zh-CN" },
  ])("keeps $name dispatch and display while attaching $locale", ({ prompt, name, locale }) => {
    const sent = buildOmpToolIntentPrompt(prompt, locale);

    expect(sent.match(/^\s*\/skill:([^\s]+)/)?.[1]).toBe(name);
    expect(sent.match(/Desktop tool intent locale: ([^.\n]+)\./)?.[1]).toBe(locale);
    expect(getOmpWorkflowDisplayText(sent)).toBe(prompt);
    expect(getOmpWorkflowDisplayText(sent.trim())).toBe(prompt.trim());
  });

  test("preserves user directives and skill text through enclosing workflow context", () => {
    const prompt =
      "/skill:browser\n<system-directive>\nKeep the user's instruction.\n</system-directive>\n";
    const skill = buildOmpToolIntentPrompt(prompt, "zh-CN");
    const wrapped = buildOmpToolIntentPrompt(`/plan ${skill}`, "zh-CN");

    expect(getOmpWorkflowDisplayText(wrapped)).toBe(`/plan ${prompt}`);
    expect(getOmpWorkflowDisplayText(prompt)).toBe(prompt);
  });

  test.each(["/skill:", "/skills list", "/wechat /skill:browser inspect", "/plan", "/goal"])(
    "leaves non-skill control input %s unchanged",
    (prompt) => {
      expect(buildOmpToolIntentPrompt(prompt, "zh-CN")).toBe(prompt);
    },
  );
});
