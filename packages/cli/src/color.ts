/**
 * Colour support, honouring `NO_COLOR` (https://no-color.org), `FORCE_COLOR`, and TTY detection,
 * in that order of precedence.
 */
export interface ColorCapableStream {
  readonly isTTY?: boolean;
}

export function shouldUseColor(
  env: Readonly<Record<string, string | undefined>>,
  stream: ColorCapableStream,
): boolean {
  const noColor = env['NO_COLOR'];
  if (noColor !== undefined && noColor !== '') return false;
  const forceColor = env['FORCE_COLOR'];
  if (forceColor !== undefined) return forceColor !== '0' && forceColor !== '';
  return stream.isTTY === true;
}

const CODES = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
} as const;

export type ColorName = keyof typeof CODES;

/** A tiny paint helper bound to whether colour is enabled, so call sites don't repeat the check. */
export class Painter {
  constructor(readonly enabled: boolean) {}

  paint(name: ColorName, text: string): string {
    return this.enabled ? `${CODES[name]}${text}${CODES.reset}` : text;
  }

  bold(text: string): string {
    return this.paint('bold', text);
  }

  dim(text: string): string {
    return this.paint('dim', text);
  }

  red(text: string): string {
    return this.paint('red', text);
  }

  green(text: string): string {
    return this.paint('green', text);
  }

  yellow(text: string): string {
    return this.paint('yellow', text);
  }

  cyan(text: string): string {
    return this.paint('cyan', text);
  }
}
