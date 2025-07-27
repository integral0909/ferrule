import { LimitExceededError, ParseError } from '@ferrule/core';

export { LimitExceededError };

/**
 * Malformed input rejected by one of the codecs in this package. `codec` names the format
 * (`logfmt`, `csv`, `syslog`, `proto`, `frame`, ...) and `code` is a stable, per-format code such
 * as `E_LOGFMT_SYNTAX`, useful for matching in tests and calling code.
 */
export class CodecSyntaxError extends ParseError {
  readonly codec: string;

  constructor(
    codec: string,
    code: string,
    message: string,
    offset?: number,
    options?: ErrorOptions,
  ) {
    super(code, `${codec}: ${message}`, offset, options);
    this.name = 'CodecSyntaxError';
    this.codec = codec;
  }
}

/** Raised by the codec registry when asked for a codec name that has not been registered. */
export class UnknownCodecError extends ParseError {
  readonly codecName: string;

  constructor(codecName: string) {
    super('E_UNKNOWN_CODEC', `no codec is registered with the name ${JSON.stringify(codecName)}`);
    this.name = 'UnknownCodecError';
    this.codecName = codecName;
  }
}

/**
 * Raised when a compiled {@link https://github.com/ pattern} (see `patterns/`) fails to match
 * input it was asked to decode.
 */
export class PatternNoMatchError extends ParseError {
  constructor(patternName: string, offset?: number) {
    super(
      'E_PATTERN_NO_MATCH',
      `input does not match pattern ${JSON.stringify(patternName)}`,
      offset,
    );
    this.name = 'PatternNoMatchError';
  }
}
