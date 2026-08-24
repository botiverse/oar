export function formatReset(value: string | undefined): string {
  if (value === undefined) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return ` · resets ${date.toLocaleString([], {
    dateStyle: "short",
    timeStyle: "short",
  })}`;
}
