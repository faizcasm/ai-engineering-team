/** Time helpers. */

export function nowIso(): string {
  return new Date().toISOString();
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new Error("aborted"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** "2026-10-03 14:02" style short timestamp for UI. */
export function shortTimestamp(date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Relative human time like "3m ago" / "in 2h". */
export function timeAgo(timestamp: number | string | Date): string {
  const then = typeof timestamp === "number" ? timestamp : new Date(timestamp).getTime();
  const diff = Date.now() - then;
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? "ago" : "from now";
  const units: Array<[number, string]> = [
    [1000, "s"],
    [60_000, "m"],
    [3_600_000, "h"],
    [86_400_000, "d"],
    [604_800_000, "w"],
  ];
  let value = abs / 1000;
  let label = "s";
  for (const [size, name] of units) {
    if (abs >= size) {
      value = abs / size;
      label = name;
    }
  }
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded}${label} ${suffix}`;
}
