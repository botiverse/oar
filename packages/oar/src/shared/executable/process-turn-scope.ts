import { descendantsOf, killEntries, type ProcessEntry, type ProcessTable, type ProcessTableSource } from "./process-tree.js";

/*
 * The processes one turn of a long-lived runtime started, told apart by two
 * reads of the process table. Only the difference between them is ever a
 * target, so the runtime itself and what ran before the turn stay alive. A
 * caller holding a failed or unfinished read must not call these: an
 * unreadable table is not an empty one.
 */

/**
 * Whether `entry` runs in the root's own process group, on a platform with
 * groups. Codex gives each `exec_command` a session of its own and keeps its
 * own helpers (`git` for its plugin cache, started whenever it likes) in its
 * group ([env] codex 0.163.0 and 0.166.0, Linux), so a member of that group is
 * the runtime's work, not the turn's.
 */
function inRootGroup(root: number, table: ProcessTable, entry: ProcessEntry): boolean {
  const group = table.get(root)?.pgid;
  return group !== undefined && group > 1 && entry.pgid === group;
}

/** One successful read of the process table. */
export interface ProcessTableReading {
  readonly table: ProcessTable;
  readonly source: ProcessTableSource;
}

const identity = (entry: ProcessEntry): string => `${String(entry.pid)}/${entry.start}`;

function identities(table: ProcessTable): ReadonlySet<string> {
  return new Set([...table.values()].map((entry) => identity(entry)));
}

/**
 * Below `root` in `snapshot`, outside its group, and not in `baseline` as the
 * same process: a pid reused since the baseline counts as new, and the whole
 * baseline table counts as earlier, because a process it holds cannot have been
 * started afterwards. What an earlier process outside the root's group started
 * is that process's work, however recent (an MCP server's worker), so its
 * subtree is spared. An earlier process in the root's group is the runtime
 * itself, and may be the native binary behind a launcher, so what is reached
 * through it stays a candidate.
 */
export function turnEntries(root: number, baseline: ProcessTable, snapshot: ProcessTableReading): readonly ProcessEntry[] {
  const earlier = identities(baseline);
  const below = descendantsOf(snapshot.table, root, snapshot.source);
  const spared = new Set<number>();
  for (const entry of below) {
    if (earlier.has(identity(entry)) && !inRootGroup(root, snapshot.table, entry)) {
      for (const child of descendantsOf(snapshot.table, entry.pid, snapshot.source)) { spared.add(child.pid); }
    }
  }
  return below.filter((entry) => entry.pid !== root && !spared.has(entry.pid) && !inRootGroup(root, snapshot.table, entry) && !earlier.has(identity(entry)));
}

/**
 * Kill each of `targets` that `fresh` (read just before) still shows as the
 * same process, with what it started since. A process group is signalled only
 * when every member `fresh` shows is itself a target: a command can stay in
 * the runtime's group, or share one with an earlier process, and neither may
 * be hit through it. Returns how many processes were targeted.
 */
export function endTurnEntries(root: number, targets: readonly ProcessEntry[], baseline: ProcessTable, fresh: ProcessTableReading): number {
  const earlier = identities(baseline);
  const entries = new Map<number, ProcessEntry>();
  for (const target of targets) {
    if (fresh.table.get(target.pid)?.start === target.start && target.pid !== root && target.pid !== process.pid) {
      entries.set(target.pid, target);
      for (const child of descendantsOf(fresh.table, target.pid, fresh.source)) {
        if (child.pid !== root && child.pid !== process.pid && !inRootGroup(root, fresh.table, child) && !earlier.has(identity(child))) { entries.set(child.pid, child); }
      }
    }
  }
  const everyMemberTargeted = (group: number): boolean => [...fresh.table.values()].every((entry) => entry.pgid !== group || entries.has(entry.pid));
  killEntries(entries.values(), fresh.table, everyMemberTargeted);
  return entries.size;
}
