import { describe, expect, it, vi } from "vitest";

import {
  rollbackCreatedTemplateMembers,
  type DeleteAgentFn,
} from "./template-member-rollback";

const PROJECT_ID = "proj-test";

function makeDeleteAgent(
  behavior: (id: string) => Promise<unknown>,
): DeleteAgentFn {
  return vi.fn(({ id }) => ({
    unwrap: () => behavior(id),
  }));
}

describe("rollbackCreatedTemplateMembers", () => {
  it("returns empty result when there are no member ids", async () => {
    const deleteAgent = makeDeleteAgent(() => Promise.resolve(undefined));

    const result = await rollbackCreatedTemplateMembers(PROJECT_ID, [], deleteAgent);

    expect(result).toEqual({ attempted: 0, deleted: [], failed: [] });
    expect(deleteAgent).not.toHaveBeenCalled();
  });

  it("deletes member ids in reverse creation order", async () => {
    const order: string[] = [];
    const deleteAgent = makeDeleteAgent(async (id) => {
      order.push(id);
    });

    const result = await rollbackCreatedTemplateMembers(
      PROJECT_ID,
      ["member-1", "member-2", "member-3"],
      deleteAgent,
    );

    expect(order).toEqual(["member-3", "member-2", "member-1"]);
    expect(result).toEqual({
      attempted: 3,
      deleted: ["member-3", "member-2", "member-1"],
      failed: [],
    });
    expect(deleteAgent).toHaveBeenCalledTimes(3);
  });

  it("continues deleting when one delete fails and collects failures", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const deleteAgent = makeDeleteAgent(async (id) => {
      if (id === "member-2") {
        throw new Error("delete failed");
      }
    });

    const result = await rollbackCreatedTemplateMembers(
      PROJECT_ID,
      ["member-1", "member-2", "member-3"],
      deleteAgent,
    );

    expect(result.attempted).toBe(3);
    expect(result.deleted).toEqual(["member-3", "member-1"]);
    expect(result.failed).toEqual([
      { id: "member-2", error: expect.any(Error) },
    ]);
    expect(deleteAgent).toHaveBeenCalledTimes(3);

    warnSpy.mockRestore();
  });

  it("treats 404 delete errors as success", async () => {
    const deleteAgent = makeDeleteAgent(async (id) => {
      if (id === "member-1") {
        throw { status: 404, data: { error: "Agent not found" } };
      }
    });

    const result = await rollbackCreatedTemplateMembers(
      PROJECT_ID,
      ["member-1", "member-2"],
      deleteAgent,
    );

    expect(result).toEqual({
      attempted: 2,
      deleted: ["member-2", "member-1"],
      failed: [],
    });
  });
});
