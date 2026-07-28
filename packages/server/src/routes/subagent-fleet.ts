import type { FastifyPluginAsync } from "fastify";
import { config } from "../config.js";
import {
  listExternalSubagentFleetRuns,
  listExternalSupervisorRequests,
  replyExternalSupervisorRequest,
  queueExternalSubagentSteer,
  queueExternalSubagentStop,
} from "../subagents-external.js";

const lifecycleStateSchema = {
  type: "string",
  enum: ["queued", "running", "complete", "failed", "paused", "stopped"],
} as const;

const optionalTimestampProperties = {
  startedAt: { type: "number", minimum: 0 },
  endedAt: { type: "number", minimum: 0 },
  durationMs: { type: "number", minimum: 0 },
} as const;

const steeringStateSchema = {
  type: "string",
  enum: ["queued", "scheduled", "routed", "delivered", "late", "failed", "recovered"],
} as const;

const steeringSchema = {
  type: "array",
  items: {
    type: "object",
    required: ["requestId", "submittedAt", "messagePreview", "targets"],
    properties: {
      requestId: { type: "string" },
      submittedAt: { type: "number", minimum: 0 },
      messagePreview: { type: "string" },
      targets: {
        type: "array",
        items: {
          type: "object",
          required: ["index", "state"],
          properties: {
            index: { type: "integer", minimum: 0 },
            state: steeringStateSchema,
            updatedAt: { type: "number", minimum: 0 },
            reason: { type: "string" },
          },
        },
      },
    },
  },
} as const;

const supervisorStatusSchema = {
  type: "string",
  enum: ["open", "answered", "cancelled", "expired"],
} as const;

const supervisorRequestSchema = {
  type: "object",
  required: [
    "requestId",
    "parentSessionId",
    "runId",
    "agent",
    "childIndex",
    "reason",
    "expectsReply",
    "createdAt",
    "message",
    "status",
  ],
  properties: {
    requestId: { type: "string" },
    parentSessionId: { type: "string" },
    runId: { type: "string" },
    agent: { type: "string" },
    childIndex: { type: "integer", minimum: 0 },
    reason: { type: "string", enum: ["need_decision", "interview_request", "progress_update"] },
    expectsReply: { type: "boolean" },
    createdAt: { type: "number", minimum: 0 },
    expiresAt: { type: "number", minimum: 0 },
    message: { type: "string" },
    interview: {},
    status: supervisorStatusSchema,
    repliedAt: { type: "number", minimum: 0 },
  },
} as const;

const supervisorReplyResponseSchema = {
  type: "object",
  required: ["accepted", "status", "repliedAt"],
  properties: {
    accepted: { const: true },
    status: { type: "string", enum: ["answered", "cancelled"] },
    repliedAt: { type: "number", minimum: 0 },
  },
} as const;

/** Lifecycle view and conservative steer control over pi-subagents artifacts. */
export const subagentFleetRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/subagent-supervisor/requests",
    {
      schema: {
        description:
          "List persisted pi-subagents native supervisor requests with exact parent, run, and request correlation.",
        tags: ["sessions"],
        response: {
          200: {
            type: "object",
            required: ["requests"],
            properties: { requests: { type: "array", items: supervisorRequestSchema } },
          },
        },
      },
    },
    async () => ({ requests: await listExternalSupervisorRequests() }),
  );

  for (const action of ["reply", "decline"] as const) {
    fastify.post<{ Params: { requestId: string }; Body: { message?: string } }>(
      `/subagent-supervisor/requests/:requestId/${action}`,
      {
        config: {
          rateLimit: {
            max: config.rateLimits.promptMax,
            timeWindow: config.rateLimits.promptWindowMs,
          },
        },
        schema: {
          description:
            action === "reply"
              ? "Atomically answer one exact pi-subagents native supervisor request."
              : "Atomically decline one exact pi-subagents native supervisor request with a safe reply.",
          tags: ["sessions"],
          params: {
            type: "object",
            required: ["requestId"],
            properties: { requestId: { type: "string", minLength: 1, maxLength: 256 } },
          },
          body: {
            type: "object",
            additionalProperties: { not: {} },
            properties: { message: { type: "string", minLength: 1, maxLength: 65536 } },
            ...(action === "reply" ? { required: ["message"] } : {}),
          },
          response: {
            202: supervisorReplyResponseSchema,
            404: {
              type: "object",
              required: ["error", "message"],
              properties: { error: { const: "request_not_found" }, message: { type: "string" } },
            },
            409: {
              type: "object",
              required: ["error", "message"],
              properties: {
                error: {
                  type: "string",
                  enum: ["request_not_open", "request_expired", "request_already_answered"],
                },
                message: { type: "string" },
              },
            },
          },
        },
      },
      async (req, reply) => {
        const message =
          action === "decline"
            ? req.body?.message?.trim() || "Declined by supervisor."
            : req.body?.message;
        const result = await replyExternalSupervisorRequest(
          req.params.requestId,
          message ?? "",
          action === "decline",
        );
        if (result.accepted) return reply.code(202).send(result);
        return reply
          .code(result.code === "request_not_found" ? 404 : 409)
          .send({ error: result.code, message: result.message });
      },
    );
  }

  fastify.get<{ Querystring: { refresh?: string } }>(
    "/subagent-fleet",
    {
      schema: {
        description:
          "List active and terminal pi-subagents runs with stable parent, run, and child session ids.",
        tags: ["sessions"],
        querystring: {
          type: "object",
          properties: { refresh: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            required: ["runs"],
            properties: {
              runs: {
                type: "array",
                items: {
                  type: "object",
                  required: ["runId", "state", "children"],
                  properties: {
                    runId: { type: "string" },
                    parentSessionId: { type: "string" },
                    state: lifecycleStateSchema,
                    mode: { type: "string" },
                    model: { type: "string" },
                    ...optionalTimestampProperties,
                    lastActivityAt: { type: "number", minimum: 0 },
                    error: { type: "string" },
                    steering: steeringSchema,
                    children: {
                      type: "array",
                      items: {
                        type: "object",
                        required: ["childId", "state"],
                        properties: {
                          childId: { type: "string" },
                          state: lifecycleStateSchema,
                          agent: { type: "string" },
                          model: { type: "string" },
                          sessionId: { type: "string" },
                          ...optionalTimestampProperties,
                          error: { type: "string" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (req) => ({ runs: await listExternalSubagentFleetRuns(req.query.refresh !== undefined) }),
  );

  fastify.post<{ Params: { runId: string } }>(
    "/subagent-fleet/:runId/stop",
    {
      schema: {
        description:
          "Request an irreversible stop for an exact running pi-subagents top-level async run.",
        tags: ["sessions"],
        params: {
          type: "object",
          required: ["runId"],
          properties: { runId: { type: "string", minLength: 1, maxLength: 4096 } },
        },
        response: {
          202: {
            type: "object",
            required: ["accepted", "requestedAt"],
            properties: {
              accepted: { const: true },
              requestedAt: { type: "number", minimum: 0 },
            },
          },
          404: {
            type: "object",
            required: ["error", "message"],
            properties: { error: { const: "run_not_found" }, message: { type: "string" } },
          },
          409: {
            type: "object",
            required: ["error", "message"],
            properties: {
              error: { type: "string", enum: ["run_not_stoppable", "run_stale"] },
              message: { type: "string" },
            },
          },
        },
      },
    },
    async (req, reply) => {
      const result = await queueExternalSubagentStop(req.params.runId);
      if (result.accepted) return reply.code(202).send(result);
      const status = result.code === "run_not_found" ? 404 : 409;
      return reply.code(status).send({ error: result.code, message: result.message });
    },
  );

  fastify.post<{ Params: { runId: string }; Body: { text: string } }>(
    "/subagent-fleet/:runId/steer",
    {
      config: {
        rateLimit: {
          max: config.rateLimits.promptMax,
          timeWindow: config.rateLimits.promptWindowMs,
        },
      },
      schema: {
        description:
          "Queue a steer for an exact running pi-subagents run without interrupting its current tool or turn.",
        tags: ["sessions"],
        params: {
          type: "object",
          required: ["runId"],
          properties: { runId: { type: "string", minLength: 1, maxLength: 4096 } },
        },
        body: {
          type: "object",
          required: ["text"],
          // Fastify's default validator silently removes unknown fields for
          // `additionalProperties: false`; this equivalent rejects them.
          additionalProperties: { not: {} },
          properties: { text: { type: "string", minLength: 1, maxLength: 131072 } },
        },
        response: {
          202: {
            type: "object",
            required: ["accepted", "requestId", "submittedAt"],
            properties: {
              accepted: { const: true },
              requestId: { type: "string" },
              submittedAt: { type: "number", minimum: 0 },
            },
          },
          404: {
            type: "object",
            required: ["error", "message"],
            properties: { error: { const: "run_not_found" }, message: { type: "string" } },
          },
          409: {
            type: "object",
            required: ["error", "message"],
            properties: {
              error: { type: "string", enum: ["run_not_steerable", "run_stale"] },
              message: { type: "string" },
            },
          },
        },
      },
    },
    async (req, reply) => {
      const result = await queueExternalSubagentSteer(req.params.runId, req.body.text);
      if (result.accepted) return reply.code(202).send(result);
      const status = result.code === "run_not_found" ? 404 : 409;
      return reply.code(status).send({ error: result.code, message: result.message });
    },
  );
};
