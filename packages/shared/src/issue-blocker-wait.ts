/**
 * Why a blocked issue waits on a blocker (`issue_relations.wait_kind`).
 *
 * - `completion`: the blocked issue needs the blocker's result. Only a `done`
 *   blocker releases it; a `cancelled` one can never deliver the result, so it is
 *   escalated to the CEO to analyse and fix, or to ask the board to decide.
 * - `resource`: the blocker only holds something the blocked issue needs (a
 *   machine, a device, a workspace). A `done` or `cancelled` blocker no longer
 *   holds it, so either releases the blocked issue and it runs on automatically.
 */
export const ISSUE_BLOCKER_WAIT_KINDS = ["completion", "resource"] as const;
export type IssueBlockerWaitKind = (typeof ISSUE_BLOCKER_WAIT_KINDS)[number];

/** A cancelled blocker that held only a resource: it no longer blocks. */
export function isReleasedResourceBlocker(
  blockerStatus: string,
  waitKind: string | null | undefined,
): boolean {
  return blockerStatus === "cancelled" && waitKind === "resource";
}

/** Whether a blocker no longer holds back the issue it blocks. */
export function isIssueBlockerResolved(
  blockerStatus: string,
  waitKind: string | null | undefined,
): boolean {
  return blockerStatus === "done" || isReleasedResourceBlocker(blockerStatus, waitKind);
}
