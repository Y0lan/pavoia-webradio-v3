// In-memory registry mapping stageId → StageController.
//
// The HTTP layer (/api/stages/:id/now, /hls/* later) needs to look up
// a controller by stage id. The supervisor itself is wiring-agnostic;
// this module is the bridge between the per-stage supervisors that
// `index.ts` will spin up (Slice B) and the request handlers in app.ts
// that need to read their state.
//
// Single-process scope. No persistence — the registry is rebuilt every
// engine restart from `@pavoia/shared/STAGES`.

import type { StageController } from "./supervisor.ts";

export interface StageRegistry {
  /**
   * Insert (or replace) a controller for the given stage id. Replacing
   * does NOT stop the previous controller — callers must stop it
   * themselves first if they want clean handoff.
   */
  register(controller: StageController): void;
  get(stageId: string): StageController | undefined;
  /** Snapshot of all registered controllers in insertion order. */
  all(): StageController[];
  /** Stop every registered controller in parallel; resolves when all
   *  have transitioned to "stopped". Errors from individual stops are
   *  swallowed so one bad controller doesn't block the others. */
  stopAll(): Promise<void>;
  readonly size: number;
}

export function createStageRegistry(): StageRegistry {
  const controllers = new Map<string, StageController>();

  return {
    register(controller) {
      controllers.set(controller.stageId, controller);
    },
    get(stageId) {
      return controllers.get(stageId);
    },
    all() {
      return Array.from(controllers.values());
    },
    async stopAll() {
      await Promise.all(
        Array.from(controllers.values()).map((c) =>
          c.stop().catch(() => {}),
        ),
      );
    },
    get size() {
      return controllers.size;
    },
  };
}
