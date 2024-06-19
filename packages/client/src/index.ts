import EventEmitter from 'events';
import { ethers } from 'ethers';
import { parseOrderTickNonce } from '@synfutures/oyster-sdk';
import { WebSocket, WebSocketConfig, JSONRPCWebSocket } from '@synfutures/utils';
import {
    QueryAccountRequest,
    QueryAccountResponse,
    SubscribeOrderFilledRequest,
    UnsubscribeOrderFilledRequest,
} from './types';

export class OysterClient extends EventEmitter {
    private ws: WebSocket;
    private jsonrpc: JSONRPCWebSocket;

    constructor(public url: string, config?: Partial<Exclude<WebSocketConfig, 'url'>>) {
        super();
        this.ws = new WebSocket({ ...config, url });
        this.jsonrpc = new JSONRPCWebSocket(this.ws);
    }

    /**
     * Start running
     */
    start() {
        this.jsonrpc.start();
    }

    /**
     * Stop running
     * All in-progress requests will throw an error
     */
    stop() {
        this.jsonrpc.stop();
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
    }

    /**
     * Unsubscribe order filled event
     * @param address User address
     * @param timeout Request timeout, default: 3s
     */
    async unsubscribeOrderFilled(address: string, timeout: number = 3000) {
        const request: UnsubscribeOrderFilledRequest = { address };

        await this.jsonrpc.request('unsubscribeOrderFilled', request, timeout);
    }
}
