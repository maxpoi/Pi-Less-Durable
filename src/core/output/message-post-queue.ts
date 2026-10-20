export const MESSAGE_BATCH_WINDOW_MS = 800;

export interface MessageQueue {
	enqueue(operation: () => Promise<void>, errorContext: string): void;
	enqueueBatch?(
		key: string,
		text: string,
		post: (combinedText: string) => Promise<void>,
		errorContext: string,
	): void;
	enqueueBatchItems?<T>(
		key: string,
		item: T,
		post: (items: readonly T[]) => Promise<void>,
		errorContext: string,
	): void;
	/** Flush admitted batched output without closing the queue. */
	flush?(): void;
	/** Flush admitted output and permanently reject later operations. */
	close?(): void;
}

export interface BatchingMessageQueue extends MessageQueue {
	enqueueBatch(
		key: string,
		text: string,
		post: (combinedText: string) => Promise<void>,
		errorContext: string,
	): void;
	enqueueBatchItems<T>(
		key: string,
		item: T,
		post: (items: readonly T[]) => Promise<void>,
		errorContext: string,
	): void;
	flush(): void;
	close(): void;
}

export type MessagePostErrorHandler = (error: unknown, errorContext: string) => Promise<void> | void;

interface PendingBatch {
	key: string;
	items: unknown[];
	post(items: readonly unknown[]): Promise<void>;
	errorContext: string;
	timer?: ReturnType<typeof setTimeout>;
}

/**
 * Serial output queue for one foreground, isolated, or background source.
 * Compatibility keys are opaque; OutputPipe owns semantic classification.
 */
export class MessagePostQueue implements BatchingMessageQueue {
	private queueChain = Promise.resolve();
	private pendingBatch: PendingBatch | undefined;
	private closed = false;

	constructor(private readonly handleError: MessagePostErrorHandler) {}

	enqueue(operation: () => Promise<void>, errorContext: string): void {
		if (this.closed) return;
		this.flushPending();
		this.enqueueNow(operation, errorContext);
	}

	enqueueBatch(
		key: string,
		text: string,
		post: (combinedText: string) => Promise<void>,
		errorContext: string,
	): void {
		this.enqueueBatchItems(key, text, async items => {
			await post(items.join("\n"));
		}, errorContext);
	}

	enqueueBatchItems<T>(
		key: string,
		item: T,
		post: (items: readonly T[]) => Promise<void>,
		errorContext: string,
	): void {
		if (this.closed) return;
		if (this.pendingBatch?.key === key) {
			this.pendingBatch.items.push(item);
			return;
		}

		this.flushPending();
		const batch: PendingBatch = {
			key,
			items: [item],
			post: items => post(items as readonly T[]),
			errorContext,
		};
		batch.timer = setTimeout(() => {
			if (this.pendingBatch === batch) this.flushPending();
		}, MESSAGE_BATCH_WINDOW_MS);
		this.pendingBatch = batch;
	}

	flush(): void {
		this.flushPending();
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.flushPending();
	}

	waitForIdle(): Promise<void> {
		this.flushPending();
		return this.queueChain;
	}

	private enqueueNow(operation: () => Promise<void>, errorContext: string): void {
		const result = this.queueChain.then(async () => {
			try {
				await operation();
			} catch (error) {
				await this.handleError(error, errorContext);
			}
		});
		this.queueChain = result.then(() => undefined, () => undefined);
	}

	private flushPending(): void {
		const batch = this.pendingBatch;
		if (!batch) return;
		this.pendingBatch = undefined;
		if (batch.timer) clearTimeout(batch.timer);
		this.enqueueNow(() => batch.post(batch.items), batch.errorContext);
	}
}
