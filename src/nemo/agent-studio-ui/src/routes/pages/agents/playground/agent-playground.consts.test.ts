import { describe, expect, it } from "vitest";

import { ROUTES } from "@/routes/routes.consts";
import { agentPlaygroundPaths } from "./agent-playground.consts";

describe("agentPlaygroundPaths", () => {
  it("[tag:agent-playground-consts] builds the workspace path with the agent id", () => {
    expect(agentPlaygroundPaths.workspace("ag-1234")).toBe(
      `/${ROUTES.AGENT_PLAYGROUND}/${ROUTES.AGENT_PLAYGROUND_WORKSPACE}/ag-1234`,
    );
  });
});

