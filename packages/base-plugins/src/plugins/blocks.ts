import { ethers } from 'ethers';
import { LRUCache } from 'lru-cache';
import Semaphore from 'semaphore-async-await';
import { Plugin } from '@synfutures/fx-core';
import { debug } from '@synfutures/logger';

/**
 * A cache that holds blocks
 *
 * TODO: support AbortController
 */
export class Blocks extends Plugin {
    private locks = new Map<number, { sempaphore: Semaphore; ref: number }>();
    private cache = new LRUCache<number, ethers.providers.Block>({
        max: 100,
    });

    private get sdk() {
        const common = this.core.getPlugin('Common');
        if (!common) {
            throw new Error('missing Common plugin');
        }
        return common.sdk;
    }

    /**
     * Get block by number
     * @param blockNumber Block number
     * @returns Block
     */
    async getBlock(blockNumber: number) {
        let block = this.cache.get(blockNumber);
        if (block) {
            return block;
        }

        // wait for lock
        let lock = this.locks.get(blockNumber);
        if (!lock) {
            this.locks.set(
                blockNumber,
                (lock = {
                    sempaphore: new Semaphore(1),
                    ref: 0,
                }),
            );
        }
        lock.ref++;
        await lock.sempaphore.acquire();

        try {
            // query block
            block = this.cache.get(blockNumber);
            if (block === undefined) {
                debug('Blocks', 'query from blockchain for', blockNumber);
                this.cache.set(
                    blockNumber,
                    (block = await this.sdk.ctx.retry(
                        (): Promise<ethers.providers.Block> =>
                            this.sdk.ctx.provider.getBlock(blockNumber).then((block) => {
                                if (block === null) {
                                    throw new Error('block is null');
                                }
                                return block;
                            }),
                    )),
                );
            }
            return block;
        } finally {
            // release lock
            lock.sempaphore.release();
            if (--lock.ref === 0) {
                this.locks.delete(blockNumber);
            }
        }
    }
}
