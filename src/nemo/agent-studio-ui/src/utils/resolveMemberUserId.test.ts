import { describe, expect, it } from "vitest";

import { isMemberIdentifier, normalizeMemberUserId } from "./resolveMemberUserId";

describe("normalizeMemberUserId", () => {
  it("[tag:member-user-id] returns Keycloak UUID as-is", () => {
    const userId = "550e8400-e29b-41d4-a716-446655440000";
    expect(normalizeMemberUserId(userId)).toBe(userId);
  });

  it("[tag:member-user-id] returns email as-is", () => {
    expect(normalizeMemberUserId("alice@example.com")).toBe("alice@example.com");
  });

  it("[tag:member-user-id] rejects invalid identifiers", () => {
    expect(() => normalizeMemberUserId("not-an-email")).toThrow(
      "Enter a valid email address or Keycloak user ID",
    );
  });
});

describe("isMemberIdentifier", () => {
  it("[tag:member-user-id] accepts email and UUID", () => {
    expect(isMemberIdentifier("alice@example.com")).toBe(true);
    expect(isMemberIdentifier("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    expect(isMemberIdentifier("invalid")).toBe(false);
  });
});
