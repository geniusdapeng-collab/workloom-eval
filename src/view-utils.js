import { num } from "./api";

export function matches(row, q) {
  return (
    !q ||
    [row.name, row.role, row.description, row.label, row.title, row.id]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(q.toLowerCase())
  );
}
export function asArray(x) {
  return Array.isArray(x) ? x : [];
}
export function metric(run, key) {
  return run?.metrics?.[key];
}
export function score(value) {
  return value === undefined || value === null ? "—" : num(value, 1);
}
export function rate(value) {
  return value === undefined || value === null
    ? "—"
    : num(value <= 1 ? value * 100 : value, 1) + "%";
}
export function recordName(kind, id, data) {
  const r = (data[kind] || []).find((v) => v.id === id);
  return r?.name || r?.label || r?.title || id || "—";
}
