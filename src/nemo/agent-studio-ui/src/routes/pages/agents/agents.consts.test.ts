import { describe, expect, it } from "vitest";

import {
  DEPLOY_LOCKED_CLASS,
  isDeployActivationLocked,
} from "./agents.consts";

describe("isDeployActivationLocked", () => {
  it("[tag:agents-consts][tag:deploy-lock] treats null as locked while LOCK_AGENT_DEPLOY is true", () => {
    expect(isDeployActivationLocked(null)).toBe(true);
  });

  it("[tag:agents-consts][tag:deploy-lock] treats non-Element EventTarget as locked", () => {
    expect(isDeployActivationLocked(document.createTextNode("locked"))).toBe(true);
  });

  it("[tag:agents-consts][tag:deploy-lock] treats Element with marker class as locked", () => {
    const el = document.createElement("div");
    el.className = DEPLOY_LOCKED_CLASS;
    expect(isDeployActivationLocked(el)).toBe(true);
  });

  it("[tag:agents-consts][tag:deploy-lock] treats Element without marker as unlocked (devtools path)", () => {
    const el = document.createElement("div");
    expect(isDeployActivationLocked(el)).toBe(false);
  });
});
