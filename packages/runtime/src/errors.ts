import { FerruleError } from '@ferrule/core';
import type { ComponentKind, Transform } from './component.js';

/**
 * Runtime-specific errors. {@link ShutdownError} and {@link UnknownComponentTypeError} live in
 * {@link "./registry.js"} because they predate this module; everything else the runtime throws
 * is defined here.
 */

/** Raised when a bounded channel rejects a send because it is closed. */
export class ChannelClosedError extends FerruleError {
  constructor(readonly channelId: string) {
    super('E_CHANNEL_CLOSED', `channel ${JSON.stringify(channelId)} is closed`);
    this.name = 'ChannelClosedError';
  }
}

/**
 * Raised when a component pushes or sends an event on a port it did not declare. Per the
 * component contract this is a bug in the component and fails it.
 */
export class InvalidPortError extends FerruleError {
  constructor(
    readonly componentId: string,
    readonly port: string,
    readonly declaredPorts: readonly string[],
  ) {
    super(
      'E_INVALID_PORT',
      `component ${JSON.stringify(componentId)} pushed to undeclared port ${JSON.stringify(port)} ` +
        `(declared ports: ${declaredPorts.map((p) => JSON.stringify(p)).join(', ')})`,
    );
    this.name = 'InvalidPortError';
  }
}

/** Wraps the cause of a component failure with the component's identity. */
export class ComponentFailureError extends FerruleError {
  constructor(
    readonly componentId: string,
    readonly componentKind: ComponentKind,
    cause: unknown,
  ) {
    super(
      'E_COMPONENT_FAILED',
      `component ${JSON.stringify(componentId)} (${componentKind}) failed`,
      {
        cause,
      },
    );
    this.name = 'ComponentFailureError';
  }
}

/**
 * Raised when a built transform instance implements neither, or both, of `process` /
 * `processAsync`. The contract requires exactly one; see the `Transform` interface in
 * `component.ts`.
 */
export class TransformContractError extends FerruleError {
  constructor(
    readonly componentId: string,
    readonly reason: 'missing' | 'both',
  ) {
    super(
      'E_TRANSFORM_CONTRACT',
      reason === 'missing'
        ? `transform ${JSON.stringify(componentId)} implements neither process() nor ` +
          'processAsync(); a transform must implement exactly one'
        : `transform ${JSON.stringify(componentId)} implements both process() and ` +
          'processAsync(); a transform must implement exactly one',
    );
    this.name = 'TransformContractError';
  }
}

/**
 * Validates that a built transform instance implements exactly one of `process` / `processAsync`.
 * Called at build time — by `buildTopology` for every real pipeline, and by the testkit's
 * `testTransform` for unit tests — so a component author sees a clear error instead of the
 * runtime silently preferring one or the other.
 */
export function validateTransformContract(transform: Transform, componentId: string): void {
  const hasSync = transform.process !== undefined;
  const hasAsync = transform.processAsync !== undefined;
  if (hasSync === hasAsync) {
    throw new TransformContractError(componentId, hasSync ? 'both' : 'missing');
  }
}

/** Severity of one topology validation finding. Warnings do not prevent the topology from building. */
export type IssueSeverity = 'error' | 'warning';

/** One problem found while validating or building a topology. */
export interface TopologyIssue {
  severity: IssueSeverity;
  code: string;
  message: string;
  componentId?: string;
}

/** Raised when a topology fails to validate or build. Carries every issue found. */
export class TopologyValidationError extends FerruleError {
  readonly issues: readonly TopologyIssue[];

  constructor(issues: readonly TopologyIssue[]) {
    const lines = issues
      .filter((i) => i.severity === 'error')
      .map((i) => `  - ${i.componentId === undefined ? '' : `${i.componentId}: `}${i.message}`);
    super('E_TOPOLOGY_INVALID', `invalid topology:\n${lines.join('\n')}`);
    this.name = 'TopologyValidationError';
    this.issues = issues;
  }
}

/** Raised when a disk-backed (or other) event buffer rejects an operation because it is closed. */
export class BufferClosedError extends FerruleError {
  constructor(readonly bufferId: string) {
    super('E_BUFFER_CLOSED', `buffer ${JSON.stringify(bufferId)} is closed`);
    this.name = 'BufferClosedError';
  }
}

export function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || (error as { code?: string }).code === 'ABORT_ERR')
  );
}

/** Formats an unknown thrown value for logging without losing information. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
  return String(error);
}
