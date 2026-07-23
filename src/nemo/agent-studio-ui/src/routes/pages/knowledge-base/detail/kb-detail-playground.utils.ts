import type { RelevanceTier } from "./kb-detail-playground.types";

const HIGHLY_RELEVANT_THRESHOLD = 90;
const RELEVANT_THRESHOLD = 80;

/**
 * Generate a UUID v4 using crypto.getRandomValues().
 * Works in all browsers including non-secure (HTTP) contexts,
 * unlike crypto.randomUUID() which requires HTTPS.
 */
export function generateId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  // Set version (4) and variant (RFC 4122) bits
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function getRelevanceLabel(score: number): RelevanceTier {
  const percentage = Math.round(score * 100);

  if (percentage >= HIGHLY_RELEVANT_THRESHOLD) {
    return {
      label: `${percentage}% (Highly relevant)`,
      color: "green",
      status: "success",
      description: "Excellent match! This content directly answers your question.",
    };
  }

  if (percentage >= RELEVANT_THRESHOLD) {
    return {
      label: `${percentage}% (Relevant)`,
      color: "blue",
      status: "info",
      description: "Good match. This content is closely related to your question.",
    };
  }

  return {
    label: `${percentage}% (Somewhat relevant)`,
    color: "orange",
    status: "warning",
    description: "Partial match. This content may contain useful information.",
  };
}
