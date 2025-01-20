import { FerruleError } from './errors.js';

/**
 * Terminal outcome of an event.
 *
 * - `delivered`: accepted by every sink it was routed to.
 * - `errored`: a transient failure (network error, sink unavailable); the source may retry.
 * - `rejected`: a permanent failure (invalid data, schema mismatch); retrying will not help.
 */
export type DeliveryStatus = 'delivered' | 'errored' | 'rejected';

const STATUS_RANK: Record<DeliveryStatus, number> = { delivered: 0, errored: 1, rejected: 2 };

/** Combines two statuses, keeping the more severe one. */
export function worseStatus(a: DeliveryStatus, b: DeliveryStatus): DeliveryStatus {
  return STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;
}

/**
 * Tracks a group of events produced from one unit of upstream work (an HTTP request, a Kafka
 * fetch, a chunk of a file) and reports once all of them reach a terminal state.
 *
 * Usage by a source:
 * ```ts
 * const batch = new BatchNotifier();
 * for (const record of records) {
 *   const event = decode(record);
 *   event.metadata.finalizers.add(batch.createFinalizer());
 *   await output.send(event);
 * }
 * batch.seal();
 * const status = await batch.completion; // then commit, checkpoint, or respond
 * ```
 *
 * The batch cannot complete before {@link seal} is called, so it never reports early while the
 * source is still producing events. A sealed batch with no events completes as `delivered`.
 */
export class BatchNotifier {
  readonly completion: Promise<DeliveryStatus>;
  private pending = 0;
  private sealed = false;
  private completed = false;
  private status: DeliveryStatus = 'delivered';
  private resolve!: (status: DeliveryStatus) => void;

  constructor(private readonly onComplete?: (status: DeliveryStatus) => void) {
    this.completion = new Promise<DeliveryStatus>((resolve) => {
      this.resolve = resolve;
    });
  }

  /** Creates a finalizer bound to this batch. Attach it to exactly one event. */
  createFinalizer(): EventFinalizer {
    return new EventFinalizer(this);
  }

  /** Declares that no more finalizers will be created by the source. */
  seal(): void {
    this.sealed = true;
    this.maybeComplete();
  }

  get isSealed(): boolean {
    return this.sealed;
  }

  get isComplete(): boolean {
    return this.completed;
  }

  /** Number of finalizers (including clones) that have not finished yet. */
  get pendingCount(): number {
    return this.pending;
  }

  /** @internal Called by {@link EventFinalizer}; not part of the public contract. */
  acquire(): void {
    if (this.completed) {
      throw new FerruleError('E_BATCH_COMPLETE', 'cannot add a finalizer to a completed batch');
    }
    this.pending++;
  }

  /** @internal Called by {@link EventFinalizer}; not part of the public contract. */
  release(status: DeliveryStatus): void {
    this.status = worseStatus(this.status, status);
    this.pending--;
    this.maybeComplete();
  }

  private maybeComplete(): void {
    if (this.completed || !this.sealed || this.pending > 0) return;
    this.completed = true;
    this.onComplete?.(this.status);
    this.resolve(this.status);
  }
}

/**
 * A handle held by one event (or one copy of an event) that must eventually be finished with a
 * status. Finishing twice is a no-op, so error paths can finish defensively.
 */
export class EventFinalizer {
  private status: DeliveryStatus = 'delivered';
  private finished = false;

  constructor(private readonly batch: BatchNotifier) {
    batch.acquire();
  }

  /** Records a status without finishing. The most severe recorded status wins. */
  update(status: DeliveryStatus): void {
    this.status = worseStatus(this.status, status);
  }

  /** Finishes this finalizer, reporting its recorded status (combined with `status`, if given). */
  finish(status?: DeliveryStatus): void {
    if (this.finished) return;
    if (status !== undefined) this.update(status);
    this.finished = true;
    this.batch.release(this.status);
  }

  /** A new finalizer on the same batch, for when the owning event is copied (fan-out). */
  clone(): EventFinalizer {
    const copy = new EventFinalizer(this.batch);
    copy.status = this.status;
    return copy;
  }

  get isFinished(): boolean {
    return this.finished;
  }
}

/**
 * The set of finalizers attached to one event. An event can carry several: for example, an
 * aggregate built from many input events carries all of their finalizers.
 */
export class Finalizers {
  private items: EventFinalizer[] = [];

  add(finalizer: EventFinalizer): void {
    this.items.push(finalizer);
  }

  /** Moves all finalizers from `other` into this set, leaving `other` empty. */
  merge(other: Finalizers): void {
    if (other === this || other.items.length === 0) return;
    for (const f of other.items) this.items.push(f);
    other.items = [];
  }

  /** Records `status` on every finalizer without finishing them. */
  update(status: DeliveryStatus): void {
    for (const f of this.items) f.update(status);
  }

  /** Finishes every finalizer with `status` and empties the set. */
  finish(status: DeliveryStatus = 'delivered'): void {
    const items = this.items;
    this.items = [];
    for (const f of items) f.finish(status);
  }

  /** Clones every finalizer, for a copy of the owning event. */
  clone(): Finalizers {
    const copy = new Finalizers();
    for (const f of this.items) copy.items.push(f.clone());
    return copy;
  }

  /** Removes and returns all finalizers, leaving this set empty. */
  take(): Finalizers {
    const taken = new Finalizers();
    taken.items = this.items;
    this.items = [];
    return taken;
  }

  get size(): number {
    return this.items.length;
  }

  get isEmpty(): boolean {
    return this.items.length === 0;
  }
}
