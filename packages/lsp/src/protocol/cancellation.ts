/**
 * Cooperative request cancellation (`$/cancelRequest`). A handler receives a
 * {@link CancellationToken} and may poll {@link CancellationToken.isCancellationRequested} at safe
 * points, or subscribe via {@link CancellationToken.onCancellationRequested} to react immediately.
 * Ferrule Script's own analyses (parse/check) are synchronous and fast enough that most handlers
 * just check the token once at the start and once before returning a large result.
 */

export interface CancellationToken {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): void;
}

/** A token that can never be cancelled, for handlers invoked outside of a request context. */
export const CancellationToken_None: CancellationToken = {
  isCancellationRequested: false,
  onCancellationRequested: () => {},
};

/** The source side of a {@link CancellationToken}: created per in-flight request, cancelled once. */
export class CancellationTokenSource {
  private cancelled = false;
  private readonly listeners: Array<() => void> = [];

  readonly token: CancellationToken = {
    isCancellationRequested: false,
    onCancellationRequested: (listener: () => void) => {
      if (this.cancelled) {
        listener();
      } else {
        this.listeners.push(listener);
      }
    },
  };

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    (this.token as { isCancellationRequested: boolean }).isCancellationRequested = true;
    for (const listener of this.listeners.splice(0)) listener();
  }
}

/** Raised (or used as a rejection) to signal that a handler stopped early because of cancellation. */
export class CancellationError extends Error {
  constructor() {
    super('request cancelled');
    this.name = 'CancellationError';
  }
}
