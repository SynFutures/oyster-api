import EventEmitter from 'events';
import { ethers } from 'ethers';
import amqplib from 'amqplib';
import Semaphore from 'semaphore-async-await';
import { parseOrderTickNonce } from '@synfutures/oyster-sdk';
import { WebSocket, WebSocketConfig, JSONRPCWebSocket } from '@synfutures/utils';
import {
    QueryAccountRequest,
    QueryAccountResponse,
    SubscribeOrderFilledRequest,
    UnsubscribeOrderFilledRequest,
    OrderFilledNotification,
} from './types';

export interface OysterClientConfig extends Omit<WebSocketConfig, 'url'> {
    serverUrl: string;
    amqpUrl: string;
}

const orderFilledQueue = 'order-filled';

export interface OysterClient {
    on(event: 'order-filled', listener: (msg: OrderFilledNotification, ack: () => void) => void): this;

    off(event: 'order-filled', listener: (msg: OrderFilledNotification, ack: () => void) => void): this;

    emit(event: 'order-filled', msg: OrderFilledNotification, ack: () => void): boolean;
}

export class OysterClient extends EventEmitter {
    private ws: WebSocket;
    private jsonrpc: JSONRPCWebSocket;
    private connection: amqplib.Connection;
    private channels = new Map<string, { channel: amqplib.Channel; size: number }>();

    private lock = new Semaphore(1);

    constructor(private config: OysterClientConfig) {
        super();
        this.ws = new WebSocket({ ...config, url: config.serverUrl });
        this.jsonrpc = new JSONRPCWebSocket(this.ws);
    }

    /**
     * Query account information
     * @param address User address
     * @param instrument Instrument address
     * @param expiry Pair expiry
     * @param timeout Request timeout, default: 3s
     * @returns Account information
     */
    async queryAccount(address: string, instrument: string, expiry: number, timeout: number = 3000) {
        const request: QueryAccountRequest = { address, instrument, expiry };

        const response: QueryAccountResponse = await this.jsonrpc.request('queryAccount', request, timeout);

        const orders: { tick: number; nonce: number; balance: ethers.BigNumber; size: ethers.BigNumber }[] = [];

        for (const [oid, order] of Object.entries(response.orders)) {
            const { tick, nonce } = parseOrderTickNonce(Number(oid));

            orders.push({
                tick,
                nonce,
                balance: ethers.BigNumber.from(order.balance),
                size: ethers.BigNumber.from(order.size),
            });
        }

        // TODO: ranges?
        return {
            position: {
                balance: ethers.BigNumber.from(response.position.balance),
                size: ethers.BigNumber.from(response.position.size),
                entryNotional: ethers.BigNumber.from(response.position.entryNotional),
                entrySocialLossIndex: ethers.BigNumber.from(response.position.entrySocialLossIndex),
                entryFundingIndex: ethers.BigNumber.from(response.position.entryFundingIndex),
            },
            orders,
        };
    }

    /**
     * Subscribe order filled event
     * Notifications will be delivered via MQ
     * @param address User address
     * @param timeout Request timeout, default: 3s
     */
    async subscribeOrderFilled(address: string, timeout: number = 3000) {
        const request: SubscribeOrderFilledRequest = { address };

        await this.jsonrpc.request('subscribeOrderFilled', request, timeout);

        await this.lock.acquire();

        try {
            const channelInfo = this.channels.get(orderFilledQueue);

            if (!channelInfo) {
                const channel = await this.connection.createChannel();

                await channel.assertQueue(orderFilledQueue);

                channel.consume(orderFilledQueue, (msg) => {
                    if (msg === null) {
                        // ignore canceled message
                        return;
                    }

                    try {
                        const data = JSON.parse(msg.content.toString());

                        this.emit(orderFilledQueue, data, () => channel.ack(msg));
                    } catch (err) {
                        // ignore error
                    }
                });

                this.channels.set(orderFilledQueue, { channel, size: 1 });
            } else {
                channelInfo.size += 1;
            }
        } finally {
            this.lock.release();
        }
    }

    /**
     * Unsubscribe order filled event
     * @param address User address
     * @param timeout Request timeout, default: 3s
     */
    async unsubscribeOrderFilled(address: string, timeout: number = 3000) {
        const request: UnsubscribeOrderFilledRequest = { address };

        await this.jsonrpc.request('unsubscribeOrderFilled', request, timeout);

        await this.lock.acquire();

        try {
            const channelInfo = this.channels.get(orderFilledQueue);

            if (channelInfo && --channelInfo.size === 0) {
                this.channels.delete(orderFilledQueue);

                await channelInfo.channel.close();
            }
        } finally {
            this.lock.release();
        }
    }

    /**
     * Initialize the client
     */
    async init() {
        this.connection = await amqplib.connect(this.config.amqpUrl);
    }

    /**
     * Start running
     */
    async start() {
        this.jsonrpc.start();
    }

    /**
     * Stop running
     * All in-progress requests will throw an error
     */
    async stop() {
        this.jsonrpc.stop();

        for (const { channel } of this.channels.values()) {
            await channel.close();
        }

        await this.connection.close();
    }
}
