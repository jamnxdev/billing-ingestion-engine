/** Minimal CSV serialization for an array of flat records — no quoting/escaping needed, every field here is a plain number or short identifier string with no commas. */
export function toCsv<T extends object>(rows: readonly T[]): string {
  if (rows.length === 0) {
    return "";
  }
  const headers = Object.keys(rows[0] as object) as (keyof T)[];
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => String(row[h])).join(","));
  }
  return lines.join("\n") + "\n";
}
