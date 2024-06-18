/* eslint-disable @typescript-eslint/no-non-null-assertion */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { ethers } from 'ethers';
import { Transaction, Op } from 'sequelize';
import { Core, Plugin } from '@synfutures/fx-core';
import { error, warn, info } from '@synfutures/logger';
import { Event } from '@synfutures/db';
import { calcEventId, compareLog, formatHexString, formatNumber, serializeEventArgs } from '../utils';
import { gateInterface, instrumentInterface, configInterface } from '../consts';

type ReorgConfig = {
    span: number;
    delay: number;
    interval: number;
};

const defaultConfig: ReorgConfig = {
    // the distance between from and to checked each time
    span: 100,
    // delay to newest block
    delay: 10,
    // the interval block number between two checks
    interval: 10,
};

/**
 * Destroy reorged events and supplement missed events
 */
export class Reorg extends Plugin {
    private config: ReorgConfig;

    private latestBlockNumber: number;
    private synced = false;
    private working: Promise<void> | undefined;

    constructor(core: Core, config?: Partial<ReorgConfig>) {
        super(core);

        this.config = {
            ...defaultConfig,
            ...config,
        };
    }

    private get db() {
        const db = this.core.getPlugin('DB');
        if (!db) {
            throw new Error('missing DB plugin');
        }
        return db;
    }

    private get blocks() {
        const blocks = this.core.getPlugin('Blocks');
        if (!blocks) {
            throw new Error('missing Blocks plugin');
        }
        return blocks;
    }

    private get common() {
        const common = this.core.getPlugin('Common');
        if (!common) {
            throw new Error('missing Common plugin');
        }
        return common;
    }

    private get storage() {
        const storage = this.core.getPlugin('Storage');
        if (!storage) {
            throw new Error('missing Storage plugin');
        }
        return storage;
    }

    private get source() {
        const source = this.core.getPlugin('Source');
        if (!source) {
            throw new Error('missing Source plugin');
        }
        return source;
    }

    private get snapshots() {
        return this.core.getPlugin('Snapshots');
    }

    private get sdk() {
        return this.common.sdk;
    }

    private get events() {
        return this.common.events;
    }

    private async commit(needSave: any[], needDestroy: Event[]) {
        let transaction: Transaction;

        try {
            transaction = await this.db.sequelize.transaction();
        } catch (err) {
            error('Reorg', 'create transaction error:', err);

            return false;
        }

        try {
            for (const event of needDestroy) {
                await event.destroy({ transaction });
            }

            for (const event of needSave) {
                await this.events.create(event, { transaction });
            }

            await transaction.commit();

            return true;
        } catch (err) {
            error('Reorg', 'catch error:', err);

            await transaction.rollback().catch((err) => error('Reorg', 'transaction rollback error:', err));

            return false;
        }
    }

    private async checkEvents(from: number, to: number) {
        const existed = new Map<string, Event>();

        // TODO: types
        const needSave: any[] = [];

        let reorgedBlockNumber: number | undefined = undefined;

        while (from <= to) {
            const _to = Math.min(from + 1000, to); // TODO: config batch size?

            // query existed id from database
            for await (const events of this.events.findAll({
                where: {
                    chainId: this.sdk.ctx.chainId,
                    blockNumber: {
                        [Op.gte]: from,
                        [Op.lte]: _to,
                    },
                },
            })) {
                for (const event of events) {
                    existed.set(event.id, event);
                }
            }

            const logs = (await this.source.logFetcher.fetch(from, _to)).sort(compareLog);

            for (const log of logs) {
                const id = calcEventId(
                    this.sdk.ctx.chainId,
                    log.address,
                    log.blockHash,
                    log.transactionHash,
                    log.logIndex,
                );

                if (!existed.delete(id)) {
                    // parse log
                    let parsed: ethers.utils.LogDescription;

                    try {
                        if (log.address.toLowerCase() === this.sdk.contracts.gate.address.toLowerCase()) {
                            parsed = gateInterface.parseLog(log);
                        } else if (log.address.toLowerCase() === this.sdk.contracts.config.address.toLowerCase()) {
                            parsed = configInterface.parseLog(log);
                        } else {
                            parsed = instrumentInterface.parseLog(log);
                        }
                    } catch (err) {
                        warn('Reorg', 'unknown event, ignore');
                        continue;
                    }

                    // get timestamps directly from the blockchain can be slow,
                    // but this situation occurs relatively rarely, so it's ok
                    let timestamp: number;

                    try {
                        const block = await this.blocks.getBlock(log.blockNumber);

                        timestamp = block.timestamp;
                    } catch (err) {
                        warn('Reorg', 'get block failed:', err);
                        continue;
                    }

                    needSave.push({
                        id,
                        chainId: this.sdk.ctx.chainId,
                        name: parsed.name,
                        blockNumber: formatNumber(log.blockNumber),
                        blockHash: formatHexString(log.blockHash),
                        txHash: formatHexString(log.transactionHash),
                        transactionIndex: formatNumber(log.transactionIndex),
                        logIndex: formatNumber(log.logIndex),
                        address: formatHexString(log.address),
                        data: serializeEventArgs(parsed.args),
                        timestamp,
                    });

                    info('Reorg', 'supplement missed event:', log.blockNumber, log.transactionIndex, log.logIndex);

                    reorgedBlockNumber =
                        reorgedBlockNumber === undefined
                            ? log.blockNumber
                            : Math.min(reorgedBlockNumber, log.blockNumber);
                }
            }

            from = _to;

            if (from === to) {
                break;
            }
        }

        // NOTE: never destroy events
        // const needDestroy = Array.from(existed.values());

        // for (const event of needDestroy) {
        //     info('Reorg', 'destroy reorged event:', event.blockNumber, event.transactionIndex, event.logIndex);

        //     reorgedBlockNumber =
        //         reorgedBlockNumber === undefined ? event.blockNumber : Math.min(reorgedBlockNumber, event.blockNumber);
        // }

        return { needSave, needDestroy: [], reorgedBlockNumber };
    }

    private async checkEventsAndCommit(from: number, to: number) {
        info('Reorg', 'check events from:', from, 'to:', to);

        // retry 3 times...
        for (let i = 0; i < 3; i++) {
            const { needSave, needDestroy, reorgedBlockNumber } = await this.checkEvents(from, to);

            if (await this.commit(needSave, needDestroy)) {
                if (reorgedBlockNumber) {
                    info('Reorg', 'reorged:', reorgedBlockNumber);

                    let resolve: (() => void) | undefined;

                    try {
                        // block storage coroutine, stop processing new events
                        resolve = await this.storage.block();

                        // regenerate snapshot
                        await this.snapshots?.reorg(reorgedBlockNumber);

                        // reprocess events
                        await this.storage.reorg(reorgedBlockNumber);
                    } finally {
                        // resolve storage coroutine
                        if (resolve) {
                            resolve();
                        }
                    }
                }

                return;
            }

            await new Promise<void>((r) => setTimeout(r, 333));
        }

        throw new Error('reorg failed');
    }

    private async _work(newest: number) {
        try {
            const to = Math.min(newest - this.config.delay, this.storage.getLatestStorageBlockNumber() - 1);

            const from = Math.max(to - this.config.span, 0);

            if (this.latestBlockNumber + this.config.interval <= from) {
                await this.checkEventsAndCommit(from, to);

                // update block number
                this.latestBlockNumber = from;
            }
        } catch (err) {
            error('Reorg', 'catch error:', err);
        }
    }

    private work(blockNumber: number) {
        if (this.stopped) {
            return;
        }

        this.working = this._work(blockNumber).finally(() => {
            this.working = undefined;
        });
    }

    private onSynced = () => {
        this.synced = true;
    };

    private onNewStoredBlockNumber = (latestBlockNumber: number) => {
        if (!this.synced) {
            return;
        }

        if (!this.working) {
            this.work(latestBlockNumber);
        }
    };

    /**
     * Lifecycle function
     */
    async onInit() {
        await this.common.init();

        await this.source.init();

        const newest = await this.sdk.ctx.retry(() => this.sdk.ctx.provider.getBlockNumber());

        if (this.storage.getLatestStorageBlockNumber() > 0) {
            const to = Math.min(newest - this.config.delay, this.storage.getLatestStorageBlockNumber() - 1);

            const from = Math.max(to - this.config.span, 0);

            // confirm local events
            await this.checkEventsAndCommit(from, to);
        }

        // set block number to newest block
        this.latestBlockNumber = newest - this.config.delay;
    }

    /**
     * Lifecycle function
     */
    async onStart() {
        this.core.nonBlocking.on('synced', this.onSynced);
        this.core.nonBlocking.on('newStoredBlockNumber', this.onNewStoredBlockNumber);
    }

    /**
     * Lifecycle function
     */
    async onStop() {
        this.core.nonBlocking.off('synced', this.onSynced);
        this.core.nonBlocking.off('newStoredBlockNumber', this.onNewStoredBlockNumber);

        // wait for job to complete
        await this.working;
    }
}
