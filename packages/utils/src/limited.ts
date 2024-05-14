/* eslint-disable @typescript-eslint/no-non-null-assertion */
/* eslint-disable @typescript-eslint/no-explicit-any */
import LinkedList, { Node } from 'yallist';
import { Counter } from './counter';

export enum TokenStatus {
    Idle,
    Using,
}

// A Token represents a concurrent
export class Token {
    readonly limited: Limited;

    status: TokenStatus = TokenStatus.Idle;

    constructor(limited: Limited) {
        this.limited = limited;
    }
}

export enum RequestStatus {
    Queued,
    Finished,
    Canceled,
}

type RequestValue = {
    status: RequestStatus;
    resolve: (token: Token) => void;
    reject: (reason?: any) => void;
};

export type Request = Node<RequestValue>;

function toNode<T>(value: T) {
    return {
        prev: null,
        next: null,
        value,
    };
}

/**
 * Simple concurrency controller
 */
export class Limited {
    private readonly idle = LinkedList.create<Token>();
    private readonly queue = LinkedList.create<RequestValue>();
    private readonly maxTokens: number;
    private readonly maxQueued: number;
    private readonly counter = new Counter();

    /**
     * @param maxTokens Max number of tokens
     * @param maxQueued Max size of queue
     */
    constructor(maxTokens: number, maxQueued = Infinity) {
        for (let i = 0; i < maxTokens; i++) {
            this.idle.push(new Token(this));
        }
        this.maxTokens = maxTokens;
        this.maxQueued = maxQueued;
    }

    /**
     * Get the current number of concurrency
     */
    get parallels() {
        return this.counter.count;
    }

    /**
     * Get the currently available concurrency
     */
    get tokens() {
        return this.maxTokens - this.parallels;
    }

    /**
     * Get the currently queue size
     */
    get queued() {
        return this.queue.length;
    }

    /**
     * Get the currently available queue size
     */
    get available() {
        return this.maxQueued - this.queued;
    }

    /**
     * Get idle token
     * @returns A token promise and a request object
     */
    get(): { getToken: Promise<Token>; request?: Request } {
        if (this.idle.length > 0) {
            const token = this.idle.shift()!;
            token.status = TokenStatus.Using;
            this.counter.increase();
            return { getToken: Promise.resolve(token) };
        } else if (this.queue.length + 1 <= this.maxQueued) {
            let resolve!: (token: Token) => void;
            let reject!: (reason?: any) => void;
            const getToken = new Promise<Token>((_resolve, _reject) => {
                resolve = _resolve;
                reject = _reject;
            });
            const requestValue: RequestValue = {
                status: RequestStatus.Queued,
                resolve,
                reject,
            };
            const request = toNode(requestValue);
            this.queue.pushNode(request);
            return { getToken, request };
        } else {
            throw new Error('too many queued');
        }
    }

    /**
     * Get idle Token
     * @returns A token promise
     */
    getToken() {
        return this.get().getToken;
    }

    /**
     * Put back token
     * @param token Token object
     */
    put(token: Token) {
        if (token.limited !== this || token.status !== TokenStatus.Using) {
            throw new Error('invalid token');
        }
        if (this.queue.length > 0) {
            const request = this.queue.shift()!;
            request.status = RequestStatus.Finished;
            request.resolve(token);
        } else {
            token.status = TokenStatus.Idle;
            this.idle.push(token);
            this.counter.decrease();
        }
    }

    /**
     * Cancel request
     * @param request Request object
     * @param reason Cancel reason
     */
    cancel(request: Request, reason?: any) {
        if (request.list !== this.queue) {
            throw new Error('invalid request');
        }
        if (request.value.status !== RequestStatus.Queued) {
            return;
        }
        this.queue.removeNode(request);
        request.value.status = RequestStatus.Canceled;
        request.value.reject(reason);
    }

    /**
     * Wait until all tokens are put back
     */
    wait() {
        return this.counter.wait();
    }
}
