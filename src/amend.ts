import { computePlan, linkableBranches, publishSteps, shortSha } from './plan.ts';
import type { AmendMeta, Plan, PlanStep, Stack } from './model.ts';

/**
 * Building the plan for folding uncommitted work into a commit that already
 * exists, anywhere in the stack.
 *
 * Node-free, beside plan.ts and for the same reason: the harness bundles it, so
 * the plan a browser renders is computed by the code the extension runs. It
 * returns an ordinary `Plan`, which `PlanView` renders unchanged — every
 * command is on screen before anything runs, and the amend gets no exception
 * from that.
 *
 * One shape for every target, including a branch tip. `git commit --amend`
 * would be the shortcut there and it is deliberately not taken: fixup plus
 * autosquash means one preview to read, one conflict path in the runner, and
 * one rollback. The cascade above the target has to run either way, so the
 * shortcut would save a rewritten SHA and cost a second code path.
 */

/**
 * Where the fixup commit is stashed between being made and being folded in.
 *
 * Load-bearing, not a convenience. The fixup commit does not exist when the
 * plan is built, so no later step can name its SHA — and a step whose argv were
 * filled in at run time would break the rule that what the panel shows is what
 * runs. Naming it with a ref keeps every step literal. It also gives undo a
 * durable handle on the parked commit and keeps it off the reflog's mercy: a
 * ref is a gc root.
 *
 * Left behind after a successful amend on purpose. `update-ref` overwrites
 * unconditionally, so there is nothing to clean up, and one ref under
 * `refs/restack/` is a useful breadcrumb rather than litter.
 */
export const PARKED_REF = 'refs/restack/parked';

export interface AmendTarget {
  /** Branch holding the commit being folded into. */
  branch: string;
  /** Full SHA of that commit. */
  sha: string;
  /** Its subject line — what `amend!` matches on, and what the notes quote. */
  subject: string;
}

export interface AmendOptions {
  /** Branch HEAD is on right now. Absent when detached. */
  head?: string;
  /**
   * Tip of `head` before anything runs. Only the carry shape needs it: it is
   * where the head branch is rewound to after the fixup commit is parked.
   */
  headTip?: string;
  /** The index already holds changes to fold. */
  staged: boolean;
  /** There are tracked modifications that are not staged. */
  unstaged: boolean;
  /**
   * Replacement commit message. With no content to fold this is a pure reword;
   * with content it replaces the message and folds in the same commit.
   */
  message?: string;
}

/** The branch that sits directly on `branch`, and so inherits any rewrite. */
export function branchAbove(stack: Stack, branch: string): string | undefined {
  const index = stack.branches.findIndex((b) => b.name === branch);
  return index < 0 ? undefined : stack.branches[index + 1]?.name;
}

function step(
  kind: PlanStep['kind'],
  args: string[],
  note: string,
  branch?: string,
): PlanStep {
  return {
    kind,
    branch,
    command: `git ${args.join(' ')}`,
    exec: { file: 'git', args },
    note,
  };
}

/**
 * The commit that carries the change, in whichever of its two forms applies.
 *
 * `--fixup=<sha>` keeps the target's message. Anything that changes the message
 * has to be built by hand: `--fixup=reword:` and `--fixup=amend:` both reject
 * `-m` and `-F` outright (`fatal: options '-m' and '--fixup:amend' cannot be
 * used together`), and there is no editor to fall back on. Autosquash
 * recognises an `amend!` subject regardless of who wrote it, so writing the
 * header by hand is the whole workaround.
 *
 * `--only --allow-empty` with no paths commits nothing, which is precisely how
 * git defines `--fixup=reword:`. It is added only when there is no content to
 * fold; with content, the same command without those two flags folds and
 * rewords in one commit.
 */
function commitStep(target: AmendTarget, options: AmendOptions, hasContent: boolean): PlanStep {
  if (options.message === undefined) {
    return step(
      'commit',
      ['commit', `--fixup=${target.sha}`],
      `Record the change as a fixup for ${shortSha(target.sha)}. Autosquash folds it in below; the commit count does not grow.`,
      target.branch,
    );
  }

  const args = ['commit'];
  if (!hasContent) {
    args.push('--only', '--allow-empty');
  }
  args.push('-m', `amend! ${target.subject}`, '-m', options.message);

  return step(
    'commit',
    args,
    hasContent
      ? `Fold the change into ${shortSha(target.sha)} and replace its message.`
      : `Replace the message of ${shortSha(target.sha)}. --only with no paths commits nothing, so the content is untouched.`,
    target.branch,
  );
}

/**
 * Fold staged work into `target`, then replay everything above it.
 *
 * Three shapes, chosen by where HEAD is standing:
 *
 * | HEAD | Plan |
 * | --- | --- |
 * | On the target's branch | In-branch |
 * | On another stack branch, with content to carry | Carry |
 * | Anywhere else, or nothing to carry | Leading `git checkout`, then in-branch |
 *
 * The cascade is free: `computePlan` with the branch above the target marked
 * drifted already emits `git rebase --onto <parent> <recordedBase> <branch>`
 * for every branch above, anchored on pre-rebase SHAs, followed by the metadata
 * write and the publish steps. The target's own branch is *not* marked drifted
 * — the amend has already rewritten it, and marking it would emit a pointless
 * replay of it onto its own unchanged parent.
 *
 * The cascade is built from `stack` as it is *now*, before the amend runs,
 * while the recorded bases still describe the pre-amend world. Building it
 * afterwards would anchor every step on SHAs that no longer mean what they
 * meant.
 */
export function amendPlan(stack: Stack, target: AmendTarget, options: AmendOptions): Plan {
  const order = stack.branches.map((b) => b.name);
  const base = stack.branches.find((b) => b.name === target.branch)?.base ?? stack.trunk;
  const hasContent = options.staged || options.unstaged;

  const steps: PlanStep[] = [];

  // Carry needs HEAD to be a stack branch other than the target's, with a tip
  // to rewind to and something to actually carry. Anything else that is not
  // already standing on the target checks out instead and leans on git's own
  // refusal to overwrite local changes — and because that is the first step, a
  // refusal costs nothing.
  const carrying =
    hasContent &&
    options.head !== undefined &&
    options.head !== target.branch &&
    options.headTip !== undefined &&
    order.includes(options.head);

  if (!carrying && options.head !== target.branch) {
    steps.push(
      step(
        'checkout',
        ['checkout', target.branch],
        `Stand on ${target.branch} to amend it. Git refuses rather than overwriting local changes, and this is the first step, so a refusal costs nothing.`,
        target.branch,
      ),
    );
  }

  if (options.unstaged && !options.staged) {
    steps.push(
      step(
        'stage',
        ['add', '-u'],
        'Stage the tracked modifications. Only what is staged is folded in, and the rebase that follows needs a clean tree.',
      ),
    );
  }

  steps.push(commitStep(target, options, hasContent));

  // A pure reword parks nothing: its commit is empty by construction, and
  // cherry-picking an empty commit errors rather than restoring anything. Those
  // sessions roll back on refs alone, which is the whole of what they changed.
  const parked = hasContent;
  if (parked) {
    steps.push(
      step(
        'ref',
        ['update-ref', PARKED_REF, 'HEAD'],
        'Park the fixup commit under a ref. Later steps name it rather than a SHA that does not exist yet, and undo needs a durable handle on it.',
      ),
    );
  }

  if (carrying) {
    steps.push(
      step(
        'checkout',
        ['checkout', '--detach'],
        'Detach before moving the branch ref. update-ref moves a ref without touching the index, so moving the one HEAD is on leaves the tree reading as dirty against the new tip.',
      ),
      step(
        'ref',
        ['update-ref', `refs/heads/${options.head}`, options.headTip!],
        `Rewind ${options.head} to where it was. The fixup commit is going onto ${target.branch} instead, and it is safe on ${PARKED_REF}.`,
        options.head,
      ),
      step(
        'checkout',
        ['checkout', target.branch],
        `Stand on ${target.branch} to fold the change in.`,
        target.branch,
      ),
      step(
        'pick',
        ['cherry-pick', PARKED_REF],
        `Bring the parked commit across to ${target.branch}. Conflicts here pause the plan the same way a rebase does.`,
        target.branch,
      ),
    );
  }

  steps.push(
    step(
      'autosquash',
      ['rebase', '-i', '--autosquash', base],
      `Fold the fixup into ${shortSha(target.sha)}. GIT_SEQUENCE_EDITOR=true accepts the todo list autosquash generates, so nothing is interactive.`,
      target.branch,
    ),
  );

  const above = branchAbove(stack, target.branch);
  const cascade = computePlan(stack, order, [], {
    force: true,
    drifted: above ? [above] : [],
  });

  steps.push(...cascade.steps);

  // With the target at the top of the stack nothing above it moves, so the
  // cascade is empty — and with it the metadata write, correctly: no branch's
  // recorded base changed, since a base is the tip of the branch *below*. The
  // publish steps still have to be offered, so they are added here instead.
  if (cascade.steps.length === 0) {
    steps.push(...publishSteps(stack.trunk, linkableBranches(stack, order)));
  }

  const amend: AmendMeta = {
    targetBranch: target.branch,
    targetSha: target.sha,
    parked,
  };

  return {
    steps,
    proposedOrder: order,
    isNoop: false,
    mergedBranches: stack.branches.filter((b) => b.isMerged).map((b) => b.name),
    insertedBranches: [],
    removedBranches: [],
    amend,
  };
}
