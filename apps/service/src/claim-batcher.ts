import {
  acceptClaimBatch,
  type AcceptClaimInput,
  type AcceptedClaim,
  type DatabasePool,
} from "@goaldrop/db";

interface PendingClaim {
  input: AcceptClaimInput;
  resolve(value: AcceptedClaim): void;
  reject(error: unknown): void;
}

interface RoundQueue {
  pending: PendingClaim[];
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
}

export class ClaimAcceptanceBatcher {
  readonly #queues = new Map<string, RoundQueue>();

  constructor(private readonly pool: DatabasePool) {}

  accept(input: AcceptClaimInput): Promise<AcceptedClaim> {
    return new Promise((resolve, reject) => {
      const queue = this.#queues.get(input.round) ?? {
        pending: [],
        timer: null,
        running: false,
      };
      queue.pending.push({ input, resolve, reject });
      this.#queues.set(input.round, queue);
      if (!queue.running && !queue.timer) {
        queue.timer = setTimeout(() => {
          queue.timer = null;
          void this.#drain(input.round, queue);
        }, 12);
      }
      if (!queue.running && queue.pending.length >= 500) {
        if (queue.timer) clearTimeout(queue.timer);
        queue.timer = null;
        void this.#drain(input.round, queue);
      }
    });
  }

  async #drain(round: string, queue: RoundQueue): Promise<void> {
    if (queue.running) return;
    queue.running = true;
    try {
      while (queue.pending.length > 0) {
        const batch = queue.pending.splice(0, 500);
        try {
          const results = await acceptClaimBatch(
            this.pool,
            batch.map((entry) => entry.input),
          );
          for (let index = 0; index < batch.length; index += 1) {
            const entry = batch[index];
            const result = results[index];
            if (!entry) continue;
            if (result?.ok) entry.resolve(result.value);
            else
              entry.reject(
                result?.error ??
                  new Error("claim batch did not return a result"),
              );
          }
        } catch (error) {
          for (const entry of batch) entry.reject(error);
        }
      }
    } finally {
      queue.running = false;
      if (queue.pending.length > 0 && !queue.timer) {
        queue.timer = setTimeout(() => {
          queue.timer = null;
          void this.#drain(round, queue);
        }, 0);
      } else if (queue.pending.length === 0) {
        this.#queues.delete(round);
      }
    }
  }
}
