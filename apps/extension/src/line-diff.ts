/** The most cells the LCS table may have; past it the changed lines are shown as removed, then added. */
export const MAX_DIFF_CELLS = 4_000_000;

export interface DiffLine {
  kind: "same" | "removed" | "added";
  text: string;
}

/** The lines of `after` against those of `before`: kept, removed and added, in order. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const old = before.split("\n");
  const changed = after.split("\n");
  let prefix = 0;
  while (prefix < old.length && prefix < changed.length && old[prefix] === changed[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < old.length - prefix &&
    suffix < changed.length - prefix &&
    old[old.length - 1 - suffix] === changed[changed.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const x = old.slice(prefix, old.length - suffix);
  const y = changed.slice(prefix, changed.length - suffix);
  return [
    ...lines("same", old.slice(0, prefix)),
    ...middle(x, y),
    ...lines("same", old.slice(old.length - suffix)),
  ];
}

function lines(kind: DiffLine["kind"], texts: readonly string[]): DiffLine[] {
  return texts.map((text) => ({ kind, text }));
}

function middle(x: readonly string[], y: readonly string[]): DiffLine[] {
  const n = x.length;
  const m = y.length;
  if ((n + 1) * (m + 1) > MAX_DIFF_CELLS) {
    return [...lines("removed", x), ...lines("added", y)];
  }
  // cell(i, j) is the length of the longest common subsequence of x[i..] and y[j..], at most
  // min(n, m). Under the cap min(n, m) < 2,000, so every cell fits in 16 bits.
  const width = m + 1;
  const table = new Uint16Array((n + 1) * width);
  const cell = (i: number, j: number): number => table[i * width + j] ?? 0;
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        x[i] === y[j] ? cell(i + 1, j + 1) + 1 : Math.max(cell(i + 1, j), cell(i, j + 1));
    }
  }
  const diff: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const removed = x[i] ?? "";
    const added = y[j] ?? "";
    if (removed === added) {
      diff.push({ kind: "same", text: removed });
      i += 1;
      j += 1;
    } else if (cell(i + 1, j) >= cell(i, j + 1)) {
      diff.push({ kind: "removed", text: removed });
      i += 1;
    } else {
      diff.push({ kind: "added", text: added });
      j += 1;
    }
  }
  return [...diff, ...lines("removed", x.slice(i)), ...lines("added", y.slice(j))];
}
