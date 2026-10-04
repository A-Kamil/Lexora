import { MemoryQueue, type JobQueue } from '@lexora/shared/pipeline';

/**
 * PROVISIONAL (memory store only): the in-memory queue does not cross processes, so the API runs the
 * worker's job itself, after the webhook has answered Kapso. With packages/db this becomes pg-boss.
 */
export class InProcessQueue implements JobQueue {
  readonly inner = new MemoryQueue();
  constructor(private readonly onJob: (messageId: string) => Promise<void>) {}

  async enqueue(name: 'process-inbound', payload: { messageId: string }): Promise<void> {
    await this.inner.enqueue(name, payload);
    setImmediate(() => void this.onJob(payload.messageId));
  }
}
