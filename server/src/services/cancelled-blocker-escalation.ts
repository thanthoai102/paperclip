import { and, eq, isNull, notInArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issueRelations, issues } from "@paperclipai/db";
import { isAgentInvokable } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { buildIssueGraphLivenessIncidentKey, RECOVERY_ORIGIN_KINDS } from "./recovery/origins.js";
import { issueService } from "./issues.js";

/**
 * Escalate a cancelled blocker that other issues wait on for its result.
 *
 * A `completion` wait (see `issue-blocker-wait.ts` in `@paperclipai/shared`)
 * needs the blocker's result, so a cancelled blocker strands the waiting issue
 * for good. For each open waiting issue this opens one critical recovery issue
 * assigned to the company's CEO agent: the CEO analyses the failure and either
 * fixes it (reopens or replaces the blocker, or drops it when the result is no
 * longer needed) or asks the board to decide. Without an invokable CEO the
 * issue stays unassigned and shows in the blocked inbox for the board.
 *
 * A `resource` wait is not escalated: readiness treats the cancelled blocker as
 * released and the waiting issue is woken like any resolved dependency.
 *
 * The recovery issue uses the issue-graph liveness origin and incident key, so
 * the blocked inbox links it as the recovery path, and the open-incident unique
 * index keeps a repeated cancellation from opening a second one.
 */
export async function escalateCancelledCompletionBlocker(
  db: Db,
  input: {
    companyId: string;
    blockerIssueId: string;
    actor: { agentId?: string | null; userId?: string | null };
  },
): Promise<Array<{ id: string; assigneeAgentId: string | null; status: string }>> {
  const dependents = await db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
      projectId: issues.projectId,
      goalId: issues.goalId,
    })
    .from(issueRelations)
    .innerJoin(issues, eq(issueRelations.relatedIssueId, issues.id))
    .where(
      and(
        eq(issueRelations.companyId, input.companyId),
        eq(issueRelations.type, "blocks"),
        eq(issueRelations.waitKind, "completion"),
        eq(issueRelations.issueId, input.blockerIssueId),
        eq(issues.companyId, input.companyId),
        isNull(issues.hiddenAt),
        notInArray(issues.status, ["done", "cancelled"]),
      ),
    );
  if (dependents.length === 0) return [];

  const blocker = await db
    .select({ id: issues.id, identifier: issues.identifier, title: issues.title })
    .from(issues)
    .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.blockerIssueId)))
    .then((rows) => rows[0] ?? null);
  if (!blocker) return [];

  const ceoAgentId = await findInvokableCeoAgentId(db, input.companyId);
  const blockerLabel = blocker.identifier ?? blocker.title;
  const svc = issueService(db);
  const created: Array<{ id: string; assigneeAgentId: string | null; status: string }> = [];

  for (const dependent of dependents) {
    const originId = buildIssueGraphLivenessIncidentKey({
      companyId: input.companyId,
      issueId: dependent.id,
      state: "blocked_by_cancelled_issue",
      blockerIssueId: blocker.id,
    });
    const open = await db
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, input.companyId),
          eq(issues.originKind, RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation),
          eq(issues.originId, originId),
          isNull(issues.hiddenAt),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      )
      .limit(1);
    if (open.length > 0) continue;

    const dependentLabel = dependent.identifier ?? dependent.title;
    try {
      const issue = await svc.create(input.companyId, {
        title: `Critical: ${dependentLabel} is stranded because ${blockerLabel} was cancelled`,
        description: [
          `${dependentLabel} ("${dependent.title}") waits for ${blockerLabel} ("${blocker.title}") to complete and needs its result, but ${blockerLabel} was cancelled. ${dependentLabel} cannot start on its own.`,
          "",
          "Analyse why it was cancelled, then do one of:",
          `- Fix it: reopen or redo ${blockerLabel}, or replace it in ${dependentLabel}'s blockers with an actionable issue that produces the result.`,
          `- Drop the dependency: remove ${blockerLabel} from ${dependentLabel}'s blockers if the result is no longer needed.`,
          `- Ask the owner: when the decision is not yours to make, ask the board with a request_confirmation interaction that explains the options and your recommendation.`,
          "",
          "Close this issue once the dependent issue can move again.",
        ].join("\n"),
        status: "todo",
        priority: "critical",
        projectId: dependent.projectId,
        goalId: dependent.goalId,
        assigneeAgentId: ceoAgentId,
        originKind: RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation,
        originId,
        createdByAgentId: input.actor.agentId ?? null,
        createdByUserId: input.actor.userId ?? null,
      });
      created.push({ id: issue.id, assigneeAgentId: issue.assigneeAgentId, status: issue.status });
    } catch (err) {
      // A concurrent cancellation may have opened the same incident first.
      logger.warn(
        { err, companyId: input.companyId, blockerIssueId: blocker.id, dependentIssueId: dependent.id },
        "failed to escalate cancelled completion blocker",
      );
    }
  }
  return created;
}

async function findInvokableCeoAgentId(db: Db, companyId: string): Promise<string | null> {
  const companyAgents = await db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      name: agents.name,
      role: agents.role,
      status: agents.status,
      reportsTo: agents.reportsTo,
    })
    .from(agents)
    .where(eq(agents.companyId, companyId));
  const ceo = companyAgents
    .filter((agent) => agent.role.trim().toLowerCase() === "ceo")
    .sort((left, right) => left.id.localeCompare(right.id))
    .find((agent) => isAgentInvokable({ agent, agents: companyAgents }));
  return ceo?.id ?? null;
}
