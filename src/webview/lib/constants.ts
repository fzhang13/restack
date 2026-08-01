import type { Plan } from '../../model';

/** Droppable id for the tray, distinct from any branch name. */
export const TRAY_ID = '__tray__';
/** The init view's stack column, droppable so the first branch has a target. */
export const STACK_ID = '__stack__';

export const EMPTY_PLAN: Plan = {
  steps: [],
  proposedOrder: [],
  isNoop: true,
  mergedBranches: [],
  insertedBranches: [],
  removedBranches: [],
};

/**
 * Node colours cycle by the branch's position in the *current* stack, so a
 * branch keeps its colour when dragged. An out-of-sequence colour run in the
 * proposed column is the reorder, visible at a glance.
 */
export const NODE_COLORS = ['#4c8dff', '#3fb950', '#d4a72c', '#e07a3f', '#a371f7', '#ec6cb9'];

export const STATUS_MARK: Record<string, string> = {
  pending: '·',
  running: '▶',
  done: '✓',
  failed: '✗',
  skipped: '–',
};
