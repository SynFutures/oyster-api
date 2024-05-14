/* eslint-disable @typescript-eslint/no-explicit-any */
export type AsyncEventListener = (...args: any[]) => void | Promise<void>;

/**
 * AsyncEventEmitter can block and emit events, making event processing synchronous
 */
export class AsyncEventEmitter {
    private readonly listeners = new Map<string, AsyncEventListener[]>();

    /**
     * Listen on event
     * @param event Event name
     * @param listener Listener function
     */
    on(event: string, listener: AsyncEventListener) {
        let listeners = this.listeners.get(event);
        if (!listeners) {
            listeners = [];
            this.listeners.set(event, listeners);
        }
        listeners.push(listener);
    }

    /**
     * Remove listener
     * @param event Event name
     * @param listener Listener function
     */
    off(event: string, listener: AsyncEventListener) {
        const listeners = this.listeners.get(event);
        if (listeners) {
            const index = listeners.indexOf(listener);
            if (index !== -1) {
                listeners.splice(index, 1);
                if (listeners.length === 0) {
                    this.listeners.delete(event);
                }
            }
        }
    }

    /**
     * Emit event
     * TODO: catch error
     * @param event Event name
     * @param args Event arguments
     */
    async emit(event: string, ...args: any[]) {
        await Promise.all((this.listeners.get(event) ?? []).map((listener) => listener(...args)));
    }
}
