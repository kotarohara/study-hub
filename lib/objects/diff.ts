// Line-based diff for document version comparison (spec §3.3: version
// history + diffing). Classic LCS; document sizes are small enough that
// O(n·m) is fine.

export interface DiffLine {
  type: "same" | "added" | "removed";
  line: string;
}

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");

  // lcs[i][j] = LCS length of a[i:] and b[j:]
  const lcs: number[][] = Array.from(
    { length: a.length + 1 },
    () => new Array(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j]
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ type: "same", line: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ type: "removed", line: a[i] });
      i++;
    } else {
      out.push({ type: "added", line: b[j] });
      j++;
    }
  }
  while (i < a.length) out.push({ type: "removed", line: a[i++] });
  while (j < b.length) out.push({ type: "added", line: b[j++] });
  return out;
}

export function diffStats(
  diff: DiffLine[],
): { added: number; removed: number } {
  return {
    added: diff.filter((d) => d.type === "added").length,
    removed: diff.filter((d) => d.type === "removed").length,
  };
}
