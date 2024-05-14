/**
 * Blockable counter
 */
export class Counter {
    // TODO: maybe Number.MIN_SAFE_INTEGER?
    private _count = 0;
    private resolve?: () => void;
    private promise?: Promise<void>;

    get count() {
        return this._count;
    }

    private create() {
        this.promise = new Promise<void>((r) => (this.resolve = r));
    }

    private destroy() {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        this.resolve!();
        this.resolve = undefined;
        this.promise = undefined;
    }

    /**
     * Increase counter
     */
    increase(i = 1) {
        this._count += i;
        if (this._count - i === 0) {
            this.create();
        }
    }

    /**
     * Descrease counter
     */
    decrease(i = 1) {
        if (i > this._count) {
            i = this._count;
        }
        this._count -= i;
        if (this._count === 0) {
            this.destroy();
        }
    }

    /**
     * Wait until the counter reaches zero
     */
    wait() {
        return this.promise ?? Promise.resolve();
    }
}
