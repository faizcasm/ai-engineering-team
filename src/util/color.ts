/**
 * Tiny ANSI styling layer with a global color switch.
 * Zero dependencies - honours NO_COLOR, FORCE_COLOR and TTY detection.
 */

const ESC = "\u001b[";

let colorEnabled: boolean =
  !process.env.NO_COLOR &&
  (process.env.FORCE_COLOR !== "0") &&
  (Boolean(process.env.FORCE_COLOR) || Boolean(process.stdout.isTTY));

export function setColorEnabled(enabled: boolean): void {
  colorEnabled = enabled;
}

export function isColorEnabled(): boolean {
  return colorEnabled;
}

const ANSI_RE = /\u001b\[[0-9;]*m/g;

export function stripAnsi(input: string): string {
  return input.replace(ANSI_RE, "");
}

function paint(open: number, close: number): (text: string) => string {
  return (text: string): string =>
    colorEnabled ? `${ESC}${open}m${text}${ESC}${close}m` : text;
}

export const style = {
  reset: paint(0, 0),
  bold: paint(1, 22),
  dim: paint(2, 22),
  italic: paint(3, 23),
  underline: paint(4, 24),
  inverse: paint(7, 27),
  red: paint(31, 39),
  green: paint(32, 39),
  yellow: paint(33, 39),
  blue: paint(34, 39),
  magenta: paint(35, 39),
  cyan: paint(36, 39),
  white: paint(37, 39),
  gray: paint(90, 39),
  bgRed: paint(41, 49),
  bgGreen: paint(42, 49),
  bgYellow: paint(43, 49),
  bgBlue: paint(44, 49),
  bgGray: paint(100, 49),
  heading: (text: string): string => style.bold(style.cyan(text)),
  success: (text: string): string => style.green(text),
  warning: (text: string): string => style.yellow(text),
  error: (text: string): string => style.red(text),
  muted: (text: string): string => style.gray(text),
  code: (text: string): string => style.yellow(text),
  path: (text: string): string => style.blue(text),
};

/** Width of a string ignoring ANSI escape sequences. */
export function visibleWidth(text: string): number {
  return stripAnsi(text).length;
}
