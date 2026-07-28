import type { FastifyPluginAsync } from "fastify";
import {
  listExternalSubagentFleetRuns,
  queueExternalSubagentSteer,
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

/** Lifecycle view and conservative steer control over pi-subagents artifacts. */
export const subagentFleetRoutes: FastifyPluginAsync = async (fastify) => {
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

  fastify.post<{ Params: { runId: string }; Body: { text: string } }>(
    "/subagent-fleet/:runId/steer",
    {
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
          additionalProperties: false,
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
