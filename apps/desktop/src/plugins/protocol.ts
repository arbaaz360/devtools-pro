import type { Limits } from "../../../../packages/plugin-sdk/src/context.ts";

/** One run per worker: the request is posted once, the outcome comes back once. */
export interface RunRequest {
  type: "run";
  jobId: string;
  packageDir: string;
  pluginId: string;
  toolId: string;
  operationId: string;
  options: Record<string, unknown>;
  inputs: Record<string, Uint8Array>;
  limits: Limits;
}

export interface RunError {
  name: string;
  message: string;
  code?: string;
  data?: unknown;
}

export type RunOutcome =
  | {
      type: "finished";
      jobId: string;
      ok: true;
      outputs: Record<string, Uint8Array>;
      values: Record<string, unknown>;
      elapsedMs: number;
    }
  | {
      type: "finished";
      jobId: string;
      ok: false;
      cancelled: boolean;
      error: RunError;
      elapsedMs: number;
    };
