import type { FastifyPluginAsync } from "fastify";
import { listExternalSubagentFleetRuns } from "../subagents-external.js";

const lifecycleStateSchema = {
  type: "string",
  enum: ["queued", "running", "complete", "failed", "paused", "stopped"],
} as const;

const optionalTimestampProperties = {
  startedAt: { type: "number", minimum: 0 },
  endedAt: { type: "number", minimum: 0 },
  durationMs: { type: "number", minimum: 0 },
} as const;

/** Read-only lifecycle view over pi-subagents' native status artifacts. */
export const subagentFleetRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/subagent-fleet",
    {
      schema: {
        description:
          "List active and terminal pi-subagents runs with stable parent, run, and child session ids.",
        tags: ["sessions"],
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
    async () => ({ runs: await listExternalSubagentFleetRuns() }),
  );
};
