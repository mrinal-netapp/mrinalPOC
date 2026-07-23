/**
 * Self-hosted modal copy. The strings render through `Typography` indirectly
 * via `CardHeader` (see `card.header.tsx`) — keeping them as named constants
 * makes the i18n hand-off explicit when `t(...)` lands and avoids inlining
 * string literals deep in the render path.
 */
const SELF_HOSTED_MODAL_TITLE = "Configure self-hosted model server";

const SELF_HOSTED_MODAL_SUBTITLE =
  "Connection and authentication for your self-hosted endpoint.";

export { SELF_HOSTED_MODAL_SUBTITLE, SELF_HOSTED_MODAL_TITLE };
