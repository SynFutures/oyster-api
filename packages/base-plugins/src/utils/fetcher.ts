import type { ethers } from 'ethers';
import type { ChainContext } from '@derivation-tech/web3-core';
import { limitedMap } from '@synfutures/utils';
import type { Subscription } from '../types';

/**
 * Fetch logs for single contract
 * @param ctx ChainContext instance
 * @param provider Provider instance
 * @param from From block number
 * @param to To block number
 * @param address Contract address
 * @param topics Contract Topics
 * @returns Logs
 */
export function fetch(
    ctx: ChainContext,
    provider: ethers.providers.Provider,
    from: number,
    to: number,
    address: string,
    topics: (null | string | string[])[],
) {
    return ctx.retry(() =>
        provider.getLogs({
            address: address,
            topics,
            fromBlock: from,
            toBlock: to,
        }),
    );
}

export class LogFetcher {
    constructor(private ctx: ChainContext, private provider: ethers.providers.Provider, private parallel: number) {}

    private subscriptions: Subscription[] = [];

    /**
     * Add a new subscription
     * @param address Contract address
     * @param topics Contract event topics
     */
    add(address: string, topics: (null | string | string[])[]) {
        // record the request in memory
        this.subscriptions.push({ address, topics });
    }

    // TODO: remove

    /**
     * Fetch logs for all subscribed content
     * NOTE: results are not sorted!
     * @param from From block number
     * @param to To block number
     * @returns Logs
     */
    async fetch(from: number, to: number) {
        return (
            await limitedMap(
                this.subscriptions,
                ({ address, topics }) => fetch(this.ctx, this.provider, from, to, address, topics),
                this.parallel,
            )
        ).flat();
    }
}
