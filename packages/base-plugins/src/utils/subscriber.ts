/* eslint-disable @typescript-eslint/no-non-null-assertion */
/* eslint-disable @typescript-eslint/no-explicit-any */
import EventEmitter from 'events';
import WS from 'ws';
import type { ethers } from 'ethers';
import { error, warn, debug } from '@synfutures/logger';
import { formatNumber } from './utils';
import type { Subscription } from '../types';

export interface WebSocketConfig {
    // remote server URL
    url: string;

    // reconnection will happen after the reconnection delay
    reconnectDelay: number;

    // period for sending ping packets
    keepAliveInterval: number;

    // timeout for accepting pong packets
    keepAliveTimeout: number;
}

const defaultConfig: Partial<WebSocketConfig> = {
    reconnectDelay: 1000,
    keepAliveInterval: 3000,
    keepAliveTimeout: 1000,
};

/**
 * Simple encapsulation of `ws`, implement keep alive and reconnection
 */
export class WebSocket extends EventEmitter {
    private config: WebSocketConfig;

    private ws?: WS;
    private connected = false;
    private closing = false;
    private queue: string[] = [];
    private reconnecting?: NodeJS.Timeout;

    constructor(config: Partial<WebSocketConfig>) {
        super();
        this.config = {
            ...defaultConfig,
            ...config,
        } as WebSocketConfig;
    }

    private _reconnect() {
        if (!this.closing && !this.reconnecting) {
            debug('WebSocket', 'reconnecting...');

            this.reconnecting = setTimeout(() => {
                this.reconnecting = undefined;
                if (!this.closing) {
                    this.connect();
                }
            }, this.config.reconnectDelay);
        }
    }

    /**
     * whether it is connected
     */
    get isConnected() {
        return this.ws && this.connected;
    }

    /**
     * Send data to remote
     * @param data Data
     */
    send(data: string) {
        if (this.ws && this.connected) {
            this.ws.send(data);
        } else {
            this.queue.push(data);
        }
    }

    /**
     * Connect with remote server
     */
    connect() {
        if (this.ws) {
            throw new Error('already connected');
        }

        const ws = new WS(this.config.url);

        let interval: NodeJS.Timeout | undefined;
        let timeOut: NodeJS.Timeout | undefined;
        let onClose: () => void;
        let onError: (err: any) => void;
        let onOpen: () => void;
        let onPong: (() => void) | undefined;
        let onMessage: ((data: WS.RawData) => void) | undefined;

        const off = () => {
            ws.off('close', onClose);
            ws.off('error', onError);
            ws.off('open', onOpen);
            if (onPong) {
                ws.off('pong', onPong);
            }
            if (onMessage) {
                ws.off('message', onMessage);
            }
            if (interval) {
                clearInterval(interval);
                interval = undefined;
            }
            if (timeOut) {
                clearTimeout(timeOut);
                timeOut = undefined;
            }
        };

        const reconnect = () => {
            // remove all listeners and timers
            off();

            // terminate
            ws.terminate();

            if (this.ws === ws) {
                // clearup and reconnect
                this.ws = undefined;
                this.connected = false;

                this._reconnect();

                this.emit('closed');
            }
        };

        ws.on(
            'close',
            (onClose = () => {
                reconnect();
            }),
        );
        ws.on(
            'error',
            (onError = (err) => {
                error('WebSocket', 'error:', err);

                reconnect();
            }),
        );
        ws.on(
            'open',
            (onOpen = () => {
                debug('WebSocket', 'connected');

                ws.on(
                    'pong',
                    (onPong = () => {
                        if (timeOut) {
                            clearTimeout(timeOut);
                            timeOut = undefined;
                        }
                    }),
                );
                ws.on(
                    'message',
                    (onMessage = (data) => {
                        this.emit('message', data);
                    }),
                );

                // start a interval to keep alive
                interval = setInterval(() => {
                    if (!timeOut) {
                        ws.ping();
                        timeOut = setTimeout(() => {
                            debug('WebSocket', 'loss connection...');

                            // send loss event
                            this.emit('loss');

                            // start reconnecting
                            reconnect();
                        }, this.config.keepAliveTimeout);
                    }
                }, this.config.keepAliveInterval);

                // mark self as connected,
                // prepare to write data
                this.connected = true;

                // send cached messages
                this.queue.forEach((data) => ws.send(data));
                this.queue = [];

                this.emit('connected');
            }),
        );

        this.ws = ws;
    }

    /**
     * Disconnect with remote server
     */
    disconnect() {
        if (!this.closing) {
            this.closing = true;
            if (this.ws) {
                this.ws.close();
            }
            if (this.reconnecting) {
                clearTimeout(this.reconnecting);
                this.reconnecting = undefined;
            }
        }
    }

    /**
     * Immediately disconnect and reconnect
     */
    reconnect() {
        if (!this.closing) {
            this.disconnect();
            this.once('closed', () => {
                this.closing = false;
                this._reconnect();
            });
        }
    }
}

type Request = {
    timeOut: NodeJS.Timeout;
    resolve: (response: any) => void;
    reject: (reason?: any) => void;
};

/**
 * Support JSON RPC protocol, base on `WebSocket`
 */
export class JSONRPCWebSocket extends EventEmitter {
    private id = Number.MIN_SAFE_INTEGER;
    private requests = new Map<string, Request>();

    constructor(public ws: WebSocket) {
        super();
    }

    // Generate unique JSON RPC id
    private genId() {
        return (this.id++).toString();
    }

    private onLoss = () => {
        for (const { timeOut, reject } of this.requests.values()) {
            reject(new Error('loss connection'));
            clearTimeout(timeOut);
        }
        this.requests.clear();
    };

    // handle underlying messages
    private onMessage = (data: WS.RawData) => {
        try {
            const json = JSON.parse(data.toString());
            const { jsonrpc, id, result, error, method, params } = json;

            // check format
            if (jsonrpc !== '2.0') {
                warn('JSONRPCWebSocket', 'invalid JSON RPC version:', jsonrpc);
                return;
            }

            if (id !== undefined) {
                // it is a response
                const request = this.requests.get(id);
                if (request) {
                    clearTimeout(request.timeOut);
                    if (error !== undefined) {
                        request.reject(error);
                    } else {
                        request.resolve(result);
                    }
                    this.requests.delete(id);
                } else {
                    warn('JSONRPCWebSocket', 'unknown response');
                }
                return;
            }

            if (method && params) {
                // it is a notify
                this.emit('notify', method, params);
                return;
            }

            warn('JSONRPCWebSocket', 'unknown data');
        } catch (err) {
            error('JSONRPCWebSocket', 'error:', err);
        }
    };

    /**
     * Send a request to remote and wait for response
     * @param method Method name
     * @param params Method params
     * @param timeOut Time out, default: 3s
     * @returns Response
     */
    request(method: string, params: any[], timeOut = 3000) {
        const id = this.genId();
        this.ws.send(
            JSON.stringify({
                id,
                jsonrpc: '2.0',
                method,
                params,
            }),
        );
        return new Promise<any>((resolve, reject) => {
            this.requests.set(id, {
                timeOut: setTimeout(() => {
                    reject(new Error('JSON RPC timeout'));
                }, timeOut),
                resolve,
                reject,
            });
        });
    }

    /**
     * Start running
     */
    start() {
        this.ws.on('loss', this.onLoss);
        this.ws.on('message', this.onMessage);
        this.ws.connect();
    }

    /**
     * Stop running
     */
    stop() {
        this.ws.off('loss', this.onLoss);
        this.ws.off('message', this.onMessage);
        this.ws.disconnect();
        for (const { timeOut, reject } of this.requests.values()) {
            reject(new Error('JSON RPC closed'));
            clearTimeout(timeOut);
        }
        this.requests.clear();
    }
}

export interface LogSubscriber {
    on(event: 'newLog', listener: (log: ethers.providers.Log) => void): this;

    off(event: 'newLog', listener: (log: ethers.providers.Log) => void): this;

    emit(event: 'newLog', log: ethers.providers.Log): boolean;
}

/**
 * Subscribe to ETH logs
 */
export class LogSubscriber extends EventEmitter {
    private subscriptions: Subscription[] = [];
    private subscriptionIds: string[] = [];

    /**
     * Constructor
     * @param jsonrpc JSON RPC Web socket instance
     */
    constructor(public jsonrpc: JSONRPCWebSocket) {
        super();
    }

    private onNotify = (method: string, params: any) => {
        if (method !== 'eth_subscription') {
            warn('LogSubscriber', 'unknown method:', method);
            return;
        }

        if (
            typeof params !== 'object' ||
            typeof params.result !== 'object' ||
            typeof params.subscription !== 'string'
        ) {
            warn('LogSubscriber', 'invalid params, ignore');
            return;
        }

        if (!this.subscriptionIds.includes(params.subscription)) {
            // ignore
            return;
        }

        const log = params.result;

        this.emit('newLog', {
            address: log.address,
            removed: log.removed,
            blockHash: log.blockHash,
            blockNumber: formatNumber(log.blockNumber),
            data: log.data,
            logIndex: formatNumber(log.logIndex),
            topics: log.topics,
            transactionHash: log.transactionHash,
            transactionIndex: formatNumber(log.transactionIndex),
        });
    };

    private onConnected = () => {
        Promise.all(
            this.subscriptions.map((s) =>
                this.jsonrpc.request('eth_subscribe', [
                    'logs',
                    {
                        address: s.address,
                        topics: s.topics,
                    },
                ]),
            ),
        )
            .then((results) => {
                if (!Array.isArray(results)) {
                    throw new Error('invalid result');
                }

                // save subscription id
                this.subscriptionIds = results;
            })
            .catch((err) => {
                error('LogSubscriber', 'subscribe all failed , error:', err);

                // try to reconnect
                this.jsonrpc.ws.reconnect();
            });
    };

    /**
     * Add a new subscription
     * @param address Contract address
     * @param topics Contract event topics
     */
    add(address: string, topics: (null | string | string[])[]) {
        // record the request in memory
        this.subscriptions.push({ address, topics });

        if (this.jsonrpc.ws.isConnected) {
            // we are connected, send request directly
            const index = this.subscriptions.length - 1;
            this.jsonrpc
                .request('eth_subscribe', ['logs', { address, topics }])
                .then((result) => {
                    if (typeof result !== 'string') {
                        throw new Error('invalid result');
                    }

                    // save subscription id
                    this.subscriptionIds[index] = result;
                })
                .catch((err) => {
                    error('LogSubscriber', 'subscribe failed for', address, 'error:', err);

                    // try to reconnect
                    this.jsonrpc.ws.reconnect();
                });
        }
    }

    // TODO: remove

    /**
     * Start running
     */
    start() {
        // add listeners
        this.jsonrpc.on('notify', this.onNotify);
        this.jsonrpc.ws.on('connected', this.onConnected);
    }

    /**
     * Stop running
     */
    stop() {
        // remove listeners
        this.jsonrpc.off('notify', this.onNotify);
        this.jsonrpc.ws.off('connected', this.onConnected);
    }
}

export interface BlockNumberSubscriber {
    on(event: 'newBlockNumber', listener: (blockNumber: number) => void): this;

    off(event: 'newBlockNumber', listener: (blockNumber: number) => void): this;

    emit(event: 'newBlockNumber', blockNumber: number): boolean;
}

/**
 * Subscribe to ETH new block number
 */
export class BlockNumberSubscriber extends EventEmitter {
    private subscriptionId?: string;

    /**
     * Constructor
     * @param jsonrpc JSON RPC Web socket instance
     */
    constructor(public jsonrpc: JSONRPCWebSocket) {
        super();
    }

    private onNotify = (method: string, params: any) => {
        if (method !== 'eth_subscription') {
            warn('BlockNumberSubscriber', 'unknown method:', method);
            return;
        }

        if (
            typeof params !== 'object' ||
            typeof params.result !== 'object' ||
            typeof params.subscription !== 'string'
        ) {
            warn('BlockNumberSubscriber', 'invalid params, ignore');
            return;
        }

        if (params.subscription !== this.subscriptionId) {
            // ignore
            return;
        }

        if (!('number' in params.result)) {
            warn('BlockNumberSubscriber', 'invalid result, ignore');
            return;
        }

        this.emit('newBlockNumber', formatNumber(params.result.number));
    };

    private onConnected = () => {
        this.jsonrpc
            .request('eth_subscribe', ['newHeads'])
            .then((result) => {
                if (typeof result !== 'string') {
                    throw new Error('invalid result');
                }

                this.subscriptionId = result;
            })
            .catch((err) => {
                error('BlockNumberSubscriber', 'subscribe error:', err);

                // try to reconnect
                this.jsonrpc.ws.reconnect();
            });
    };

    /**
     * Start running
     */
    start() {
        // add listeners
        this.jsonrpc.on('notify', this.onNotify);
        this.jsonrpc.ws.on('connected', this.onConnected);
    }

    /**
     * Stop running
     */
    stop() {
        // remove listeners
        this.jsonrpc.off('notify', this.onNotify);
        this.jsonrpc.ws.off('connected', this.onConnected);
    }
}
