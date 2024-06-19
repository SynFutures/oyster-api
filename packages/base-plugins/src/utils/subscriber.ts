/* eslint-disable @typescript-eslint/no-non-null-assertion */
/* eslint-disable @typescript-eslint/no-explicit-any */
import EventEmitter from 'events';
import type { ethers } from 'ethers';
import { JSONRPCWebSocket } from '@synfutures/utils';
import { error, warn } from '@synfutures/logger';
import type { Subscription } from '../types';
import { formatNumber } from './utils';

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
