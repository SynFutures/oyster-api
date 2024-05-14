/* eslint-disable @typescript-eslint/no-non-null-assertion */
/* eslint-disable @typescript-eslint/no-explicit-any */
export class ChannelAbortError extends Error {}

export interface ChannelOption<T> {
    /**
     * Max channel size,
     * if the channel size is greater than this number,
     * it will drop the fisrt value
     */
    max?: number;
    /**
     * Drop callback,
     * it will be called when drop a value
     */
    drop?: (data: T) => void;
}

/**
 * An asynchronous queue, order by the order in which the elements are pushed
 */
export class Channel<T = any> {
    private _aborted = false;
    private _pending: T[] = [];
    private max?: number;
    private drop?: (data: T) => void;
    private resolve?: (data: T) => void;
    private reject?: (reason?: any) => void;

    /**
     * Get pending data size
     */
    get size() {
        return this._pending.length;
    }

    /**
     * Get all pending data in the channel
     */
    get pending() {
        return this._pending;
    }

    /**
     * Aborted
     */
    get aborted() {
        return this._aborted;
    }

    constructor(options?: ChannelOption<T>) {
        this.max = options?.max;
        this.drop = options?.drop;
    }

    /**
     * Push data to channel
     * If the channel is waiting, resolve the promise
     * If the channel isn't waiting, push data to `_array` and cache it
     * @param data - Data
     * @returns `true` if successfully pushed, `false` if not
     */
    push(data: T) {
        if (this._aborted) {
            this.drop && this.drop(data);
            return false;
        }
        if (this.resolve) {
            this.resolve(data);
            this.reject = undefined;
            this.resolve = undefined;
        } else {
            this._pending.push(data);
            if (this.max && this._pending.length > this.max) {
                if (this.drop) {
                    while (this._pending.length > this.max) {
                        this.drop(this._pending.shift()!);
                    }
                } else {
                    this._pending.splice(0, this._pending.length - this.max);
                }
            }
        }
        return true;
    }

    /**
     * Get next element in channel
     * If channel is empty, it will wait until new element pushed or the channel is aborted
     * @returns Next element
     */
    next() {
        return this._pending.length > 0
            ? Promise.resolve(this._pending.shift()!)
            : new Promise<T>((resolve, reject) => {
                  this.resolve = resolve;
                  this.reject = reject;
              });
    }

    /**
     * Abort channel
     */
    abort() {
        if (this.reject) {
            this.reject(new ChannelAbortError());
            this.reject = undefined;
            this.resolve = undefined;
        }
        this._aborted = true;
        this.clear();
    }

    /**
     * Reset channel
     */
    reset() {
        this._aborted = false;
    }

    /**
     * Clear channel and drop all data
     */
    clear() {
        if (this.drop) {
            for (const data of this._pending) {
                this.drop(data);
            }
        }
        this._pending = [];
    }

    /**
     * Cancel element
     * @param fn - Callback
     */
    cancel(fn: (data: T) => boolean) {
        const indexes: number[] = [];
        for (let i = 0; i < this._pending.length; i++) {
            if (fn(this._pending[i])) {
                indexes.push(i);
            }
        }
        for (let i = indexes.length - 1; i >= 0; i--) {
            this._pending.splice(indexes[i], 1);
        }
    }

    /**
     * Return an async generator to fetch the data in channel
     */
    async *[Symbol.asyncIterator]() {
        try {
            while (!this._aborted) {
                yield await this.next();
            }
        } catch (err) {
            if (!(err instanceof ChannelAbortError)) {
                throw err;
            }
        }
    }
}
