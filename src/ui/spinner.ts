/** Terminal spinner + status animation (writes to stderr to keep stdout clean). */

import { style, stripAnsi } from "../util/color.js";

const FRAMES = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"];
const SLOW_FRAMES = ["-", "\\", "|", "/"];

export interface SpinnerOptions {
  stream?: NodeJS.WriteStream;
  enabled?: boolean;
  intervalMs?: number;
}

export class Spinner {
  private readonly stream: NodeJS.WriteStream;
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private timer?: NodeJS.Timeout;
  private frame = 0;
  private text = "";
  private lastWidth = 0;
  private spinning = false;

  constructor(private readonly options: SpinnerOptions = {}) {
    this.stream = options.stream ?? process.stderr;
    this.enabled = options.enabled ?? Boolean(this.stream.isTTY);
    this.intervalMs = options.intervalMs ?? 90;
  }

  get isSpinning(): boolean {
    return this.spinning;
  }

  start(text: string): void {
    this.text = text;
    if (!this.enabled || this.spinning) {
      this.update(text, false);
      return;
    }
    this.spinning = true;
    this.timer = setInterval(() => this.render(), this.intervalMs);
    this.timer.unref?.();
    this.render();
  }

  update(text: string, rerender = true): void {
    this.text = text;
    if (rerender && this.spinning) this.render();
  }

  /** Erase the current line without printing anything. */
  clear(): void {
    if (!this.enabled) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.spinning = false;
    this.eraseLine();
  }

  /** Stop and print a final message on the spinner line. */
  stop(final?: string): void {
    if (!this.enabled) {
      if (final) this.stream.write(`${final}\n`);
      return;
    }
    this.clear();
    if (final) {
      this.eraseLine();
      this.stream.write(`${final}\n`);
      this.lastWidth = 0;
    }
  }

  private render(): void {
    const frames = this.intervalMs > 200 ? SLOW_FRAMES : FRAMES;
    const glyph = frames[this.frame % frames.length]!;
    this.frame += 1;
    const line = `${style.cyan(glyph)} ${style.dim(this.text)}`;
    const width = stripAnsi(line).length;
    const pad = Math.max(0, this.lastWidth - width);
    this.eraseLine();
    this.stream.write(`${line}${" ".repeat(pad)}`);
    this.lastWidth = width;
  }

  private eraseLine(): void {
    if (this.lastWidth > 0 || this.spinning) {
      this.stream.write("\r\u001b[2K");
      this.lastWidth = 0;
    }
  }
}

/** Run an async task with a spinner, always cleaning it up. */
export async function withSpinner<T>(text: string, fn: (spinner: Spinner) => Promise<T>, options: SpinnerOptions = {}): Promise<T> {
  const spinner = new Spinner(options);
  spinner.start(text);
  try {
    return await fn(spinner);
  } finally {
    spinner.stop();
  }
}
