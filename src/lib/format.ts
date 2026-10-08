export const short = (addr: string, head = 4, tail = 4) =>
  addr.length <= head + tail + 2 ? addr : `${addr.slice(0, head + 2)}...${addr.slice(-tail)}`;

export function countdown(sec: number | null) {
  if (sec == null || sec <= 0) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h) return `${h}h ${m}m`;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

export function ago(sec: number) {
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}
