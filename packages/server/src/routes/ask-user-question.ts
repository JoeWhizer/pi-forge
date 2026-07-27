import type { FastifyPluginAsync } from "fastify";
import { getSession } from "../session-registry.js";
import { answerPending, getPendingForSession } from "../ask-user-question/registry.js";
import { buildResult } from "../ask-user-question/envelope.js";
import type {
  AskUserQuestionPresentation,
  ForgeCustomDialogField,
  QuestionAnswer,
} from "../ask-user-question/types.js";
import { errorSchema } from "./_schemas.js";

/**
 * POST /sessions/:id/ask-user-question/answer
 *
 * The browser modal calls this with the user's answers (or with
 * `cancelled: true` when they pick "Chat about this" / close the
 * modal). Resolves the pending entry in the registry, which
 * propagates back to the tool's awaiting `execute()` — the agent
 * gets a clean tool result and continues.
 *
 * Per-call ownership is enforced by matching `requestId` against
 * this session's pending list. A spoofed requestId from a session
 * the caller doesn't own returns 404.
 */
const answerBodySchema = {
  type: "object",
  required: ["requestId"],
  additionalProperties: false,
  properties: {
    requestId: { type: "string", minLength: 1 },
    cancelled: { type: "boolean" },
    answers: {
      type: "array",
      items: {
        type: "object",
        required: ["questionIndex", "question", "kind"],
        properties: {
          questionIndex: { type: "integer", minimum: 0 },
          question: { type: "string" },
          kind: { type: "string", enum: ["option", "custom", "chat", "multi"] },
          answer: { type: ["string", "null"] },
          selected: { type: "array", items: { type: "string" } },
          notes: { type: "string" },
          preview: { type: "string" },
        },
      },
    },
  },
} as const;

interface AnswerBody {
  requestId: string;
  cancelled?: boolean;
  answers?: QuestionAnswer[];
}

function isValidConfirmationResponse(body: AnswerBody, expectedQuestion: string): boolean {
  if (body.cancelled === true || !Array.isArray(body.answers) || body.answers.length !== 1) {
    return false;
  }
  const [answer] = body.answers;
  return (
    answer !== undefined &&
    answer.questionIndex === 0 &&
    answer.question === expectedQuestion &&
    answer.kind === "option" &&
    (answer.answer === "Approve" || answer.answer === "Reject")
  );
}

function isValidCustomValue(field: ForgeCustomDialogField, value: unknown): boolean {
  if (field.type === "checkbox") return typeof value === "boolean";
  if (typeof value !== "string") return false;
  if (field.required === true && value.trim().length === 0) return false;
  if (field.maxLength !== undefined && value.length > field.maxLength) return false;
  if (field.type !== "select") return true;
  return value.length === 0 && field.required !== true
    ? true
    : field.options?.includes(value) === true;
}

function isValidExtensionResponse(
  body: AnswerBody,
  presentation: AskUserQuestionPresentation,
): boolean {
  if (body.cancelled === true) return true;
  if (!Array.isArray(body.answers) || body.answers.length !== 1) return false;
  const [answer] = body.answers;
  if (
    answer === undefined ||
    answer.questionIndex !== 0 ||
    (answer.kind !== "custom" && answer.kind !== "option")
  ) {
    return false;
  }
  if (presentation.kind === "extension_select") {
    return (
      answer.kind === "option" &&
      typeof answer.answer === "string" &&
      presentation.options.includes(answer.answer)
    );
  }
  if (presentation.kind === "extension_input") {
    return (
      answer.kind === "custom" && typeof answer.answer === "string" && answer.answer.length <= 4_000
    );
  }
  if (presentation.kind === "extension_editor") {
    return (
      answer.kind === "custom" &&
      typeof answer.answer === "string" &&
      answer.answer.length <= 12_000
    );
  }
  if (
    presentation.kind !== "extension_custom" ||
    answer.kind !== "custom" ||
    typeof answer.answer !== "string"
  ) {
    return false;
  }
  try {
    const values: unknown = JSON.parse(answer.answer);
    if (values === null || typeof values !== "object" || Array.isArray(values)) return false;
    const record = values as Record<string, unknown>;
    return (
      Object.keys(record).length === presentation.schema.fields.length &&
      presentation.schema.fields.every(
        (field) =>
          Object.prototype.hasOwnProperty.call(record, field.id) &&
          isValidCustomValue(field, record[field.id]),
      )
    );
  } catch {
    return false;
  }
}

export const askUserQuestionRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Params: { id: string } }>(
    "/sessions/:id/ask-user-question/pending",
    {
      schema: {
        description:
          "List ask_user_question requests currently waiting on an answer " +
          "for this session. The browser modal uses this on initial mount " +
          "as a fallback to the SSE snapshot re-delivery path.",
        tags: ["sessions"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            required: ["pending"],
            properties: {
              pending: {
                type: "array",
                items: {
                  type: "object",
                  required: ["requestId", "questions"],
                  properties: {
                    requestId: { type: "string" },
                    questions: { type: "array" },
                    presentation: {
                      anyOf: [
                        {
                          type: "object",
                          required: ["kind", "title", "message"],
                          properties: {
                            kind: { type: "string", const: "confirmation" },
                            extension: { type: "string" },
                            title: { type: "string" },
                            message: { type: "string" },
                          },
                        },
                        {
                          type: "object",
                          required: ["kind", "title", "options"],
                          properties: {
                            kind: { type: "string", const: "extension_select" },
                            extension: { type: "string" },
                            title: { type: "string" },
                            options: { type: "array", items: { type: "string" } },
                          },
                        },
                        {
                          type: "object",
                          required: ["kind", "title"],
                          properties: {
                            kind: { type: "string", enum: ["extension_input", "extension_editor"] },
                            extension: { type: "string" },
                            title: { type: "string" },
                            placeholder: { type: "string" },
                            prefill: { type: "string" },
                          },
                        },
                        {
                          type: "object",
                          required: ["kind", "schema"],
                          properties: {
                            kind: { type: "string", const: "extension_custom" },
                            extension: { type: "string" },
                            schema: { type: "object" },
                          },
                        },
                      ],
                    },
                  },
                },
              },
            },
          },
          404: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const live = getSession(req.params.id);
      if (live === undefined) {
        return reply.code(404).send({ error: "session_not_found" });
      }
      const pending = getPendingForSession(req.params.id).map((p) => ({
        requestId: p.requestId,
        questions: p.questions,
        ...(p.presentation !== undefined ? { presentation: p.presentation } : {}),
      }));
      return { pending };
    },
  );

  fastify.post<{ Params: { id: string }; Body: AnswerBody }>(
    "/sessions/:id/ask-user-question/answer",
    {
      schema: {
        description:
          "Submit a user's answers to an in-flight ask_user_question " +
          "tool call. Pass `cancelled: true` (with or without partial " +
          "answers) when the user dismissed the modal or picked the " +
          "'Chat about this' escape. The tool's execute() resolves " +
          "with the constructed envelope; the agent then continues.",
        tags: ["sessions"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        body: answerBodySchema,
        response: {
          204: { type: "null" },
          400: errorSchema,
          404: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const live = getSession(req.params.id);
      if (live === undefined) {
        return reply.code(404).send({ error: "session_not_found" });
      }
      const cancelled = req.body.cancelled === true;
      const answers = Array.isArray(req.body.answers) ? req.body.answers : [];
      // Total question count is whatever the registry has on file —
      // the envelope's "partial cancel" summary line reads it from
      // here to phrase correctly. Look it up before answering since
      // the registry entry vanishes on resolve.
      const pending = getPendingForSession(req.params.id).find(
        (p) => p.requestId === req.body.requestId,
      );
      if (
        pending?.presentation?.kind === "confirmation" &&
        !isValidConfirmationResponse(req.body, pending.questions[0]?.question ?? "")
      ) {
        return reply.code(400).send({ error: "invalid_confirmation_response" });
      }
      if (
        pending?.presentation !== undefined &&
        pending.presentation.kind !== "confirmation" &&
        !isValidExtensionResponse(req.body, pending.presentation)
      ) {
        return reply.code(400).send({ error: "invalid_extension_dialog_response" });
      }
      const questionCount = pending?.questions.length ?? answers.length;
      const envelope = buildResult(answers, { cancelled, questionCount });
      const ok = answerPending(req.body.requestId, req.params.id, envelope);
      if (!ok) {
        // Either unknown requestId or one that belongs to another
        // session (defense against cross-session spoofing).
        return reply.code(404).send({ error: "request_not_found" });
      }
      return reply.code(204).send();
    },
  );
};
