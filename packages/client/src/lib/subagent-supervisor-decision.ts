import type { SubagentSupervisorDecision } from "./api-client/types";

/**
 * The only decision states Forge records. Text is intentionally never parsed:
 * native supervisor replies are transport messages, not decision protocol.
 */
export const NO_SUPERVISOR_DECISION: SubagentSupervisorDecision = "no-decision";

export function supervisorDecisionFromValue(value: unknown): SubagentSupervisorDecision {
  return value === "approved" || value === "rejected" ? value : NO_SUPERVISOR_DECISION;
}

export function isExplicitSupervisorDecision(
  decision: SubagentSupervisorDecision,
): decision is "approved" | "rejected" {
  return decision === "approved" || decision === "rejected";
}

export interface SupervisorDecisionPresentation {
  label: string;
  className: string;
  toneClassName: string;
}

/** Shared Fleet/Chat presentation for persisted Forge classifications. */
export function supervisorDecisionPresentation(value: unknown): SupervisorDecisionPresentation {
  const decision = supervisorDecisionFromValue(value);
  if (decision === "approved") {
    return {
      label: "Approved",
      className:
        "border-emerald-700 bg-emerald-950/50 text-emerald-100 light:border-emerald-400 light:bg-emerald-50 light:text-emerald-900",
      toneClassName: "text-emerald-200 light:text-emerald-900",
    };
  }
  if (decision === "rejected") {
    return {
      label: "Rejected",
      className:
        "border-red-700 bg-red-950/50 text-red-100 light:border-red-400 light:bg-red-50 light:text-red-900",
      toneClassName: "text-red-200 light:text-red-900",
    };
  }
  return {
    label: "No decision recorded",
    className:
      "border-neutral-700 bg-neutral-900 text-neutral-200 light:border-neutral-300 light:bg-white light:text-neutral-700",
    toneClassName: "text-sky-200 light:text-sky-900",
  };
}

/**
 * Browser replies are the sole chat events that carry Forge's durable decision
 * classification. Native tool result metadata deliberately has no decision.
 */
export function supervisorDecisionFromForgeReplyEvent(
  details: unknown,
): SubagentSupervisorDecision {
  if (typeof details !== "object" || details === null) return NO_SUPERVISOR_DECISION;
  const value = details as Record<string, unknown>;
  return value.source === "pi-forge" && value.kind === "supervisor-reply"
    ? supervisorDecisionFromValue(value.decision)
    : NO_SUPERVISOR_DECISION;
}
