import { ethers } from 'ethers';
import { Op, QueryTypes } from 'sequelize';
import { Snapshot } from '@synfutures/oyster-sdk';
import { Core, Plugin } from '@synfutures/fx-core';
import { error, info } from '@synfutures/logger';
import { Channel, Tracker } from '@synfutures/utils';
import { Cache, EventPosition, createCache, Snapshot as SnapshotTable } from '@synfutures/db';
import { getSnapshot, saveSnapshot } from '../libs/snapshots';

type SnapshotConfig = {
    // the interval block number between two snapshots
    interval: number;
    // snapshot outdated duration
    outdated: number;
};

type SnapshotCache = {
    blockNumber: number;
};

const defaultCache: SnapshotCache = {
    blockNumber: 0,
};

/**
 * Maintain the latest snapshot and manage snapshots in the database
 */
export class Snapshots extends Plugin {
    private cache: Cache<SnapshotCache>;

    private reorging?: Promise<void>;
    private working: Promise<void>;

    private channel = new Channel<
        | { type: 'reorged'; reorgBlockNumber: number; resolve: () => void }
        | { type: 'newParsedEvent'; log: ethers.providers.Log; parsedLog: ethers.utils.LogDescription }
    >();

    private latestSnapshot?: Snapshot;
    private latestPosition?: EventPosition;

    constructor(core: Core, private config: SnapshotConfig) {
        super(core);
    }

    private get db() {
        const db = this.core.getPlugin('DB');
        if (!db) {
            throw new Error('missing DB plugin');
        }
        return db;
    }

    private get common() {
        const common = this.core.getPlugin('Common');
        if (!common) {
            throw new Error('missing Common plugin');
        }
        return common;
    }

    private get sdk() {
        return this.common.sdk;
    }

    private get events() {
        return this.common.events;
    }

    /**
     * Get whether reorg is in progress
     */
    get isReorging() {
        return !!this.reorging;
    }

    /**
     * Get current state
     */
    get state() {
        if (this.isReorging) {
            return {
                reorging: true,
            };
        } else {
            return {
                reorging: false,
                position: {
                    ...this.latestPosition,
                },
            };
        }
    }

    /**
     * Get latest snapshot
     * @returns Available snapshot instance
     */
    getLatestSnapshot() {
        if (this.isReorging) {
            return false;
        }

        return this.latestSnapshot;
    }

    private async work() {
        for await (const event of this.channel) {
            try {
                if (event.type === 'reorged') {
                    try {
                        // clear pending logs
                        this.channel.clear();

                        // clear latest snapshot
                        this.latestSnapshot = undefined;
                        this.latestPosition = undefined;

                        const tracker = new Tracker();

                        info('Snapshots', 'reorging at:', event.reorgBlockNumber);

                        // destroy all error snapshots
                        await SnapshotTable.destroy({
                            where: {
                                blockNumber: {
                                    [Op.gte]: event.reorgBlockNumber,
                                },
                            },
                        });

                        // generate a snapshot before the reorg occurs
                        const { snapshot, position } = await getSnapshot(
                            this.sdk,
                            this.events,
                            event.reorgBlockNumber - 1,
                            undefined,
                            undefined,
                            this.core.signal,
                        );

                        this.latestSnapshot = snapshot;
                        this.latestPosition = position;

                        info('Snapshots', 'reorg usage:', tracker.usage());
                    } finally {
                        // resolve reorg promise
                        event.resolve();
                    }
                } else if (event.type === 'newParsedEvent') {
                    if (this.latestPosition && this.latestSnapshot) {
                        // NOTE: we monitor multiple instrument events at the same time,
                        // so the order of execution may be mixed up.
                        const messed =
                            event.log.blockNumber < this.latestPosition.blockNumber ||
                            (event.log.blockNumber === this.latestPosition.blockNumber &&
                                event.log.transactionIndex < this.latestPosition.transactionIndex) ||
                            (event.log.blockNumber === this.latestPosition.blockNumber &&
                                event.log.transactionIndex === this.latestPosition.transactionIndex &&
                                event.log.logIndex < this.latestPosition.logIndex);

                        // process new log
                        await this.latestSnapshot.processParsedLog(event.log, event.parsedLog);

                        if (!messed) {
                            // update latest position if not messed
                            this.latestPosition = {
                                blockNumber: event.log.blockNumber,
                                transactionIndex: event.log.transactionIndex,
                                logIndex: event.log.logIndex,
                            };
                        } else {
                            // destroy messed snapshots
                            await SnapshotTable.destroy({
                                where: {
                                    blockNumber: {
                                        [Op.gte]: event.log.blockNumber,
                                    },
                                },
                            });
                        }

                        // save snapshot if threshold reached
                        if (event.log.blockNumber - this.cache.blockNumber >= this.config.interval) {
                            const transaction = await this.db.sequelize.transaction();

                            let destroyed = 0;

                            try {
                                const snapshots = await this.db.sequelize.query<{ id: number; blockNumber: number }>(
                                    'select id, "blockNumber" from "Snapshots" order by "blockNumber" asc',
                                    {
                                        type: QueryTypes.SELECT,
                                        transaction,
                                    },
                                );

                                const outdatedThreshold = event.log.blockNumber - this.config.outdated;

                                const outdatedSnapshots = snapshots
                                    .filter(({ blockNumber }) => blockNumber <= outdatedThreshold)
                                    .map(({ id }) => id);

                                if (outdatedSnapshots.length > 0 && outdatedSnapshots.length === snapshots.length) {
                                    // keep at least one copy
                                    outdatedSnapshots.pop();
                                }

                                if (outdatedSnapshots.length > 0) {
                                    // destroy outdated snapshots
                                    destroyed = await SnapshotTable.destroy({
                                        where: {
                                            id: {
                                                [Op.in]: outdatedSnapshots,
                                            },
                                        },
                                        transaction,
                                    });
                                }

                                // save new snapshot
                                await saveSnapshot(
                                    this.sdk.ctx.chainId,
                                    this.latestSnapshot,
                                    this.latestPosition,
                                    transaction,
                                );

                                // update cache
                                this.cache.blockNumber = event.log.blockNumber;
                                await this.cache.save(transaction);

                                await transaction.commit();
                            } catch (err) {
                                await transaction
                                    .rollback()
                                    .catch((err) => error('Snapshots', 'transaction rollback error:', err));

                                throw err;
                            }

                            info(
                                'Snapshots',
                                'snapshot saved at:',
                                event.log.blockNumber,
                                'destroyed outdated:',
                                destroyed,
                            );
                        }
                    }
                }
            } catch (err) {
                error('Snapshots', 'catch error:', err);
            }
        }
    }

    private onNewParsedEvent = (log: ethers.providers.Log, parsedLog: ethers.utils.LogDescription) => {
        this.channel.push({
            type: 'newParsedEvent',
            log,
            parsedLog,
        });
    };

    /**
     * Reorg
     * Delete the wrong snapshot and regenerate the correct snapshot
     * @param reorgBlockNumber Reorged block number
     */
    reorg(reorgBlockNumber: number) {
        return (this.reorging = new Promise<void>((resolve) =>
            this.channel.push({
                type: 'reorged',
                reorgBlockNumber,
                resolve,
            }),
        ).finally(() => {
            // clear promise
            this.reorging = undefined;
        }));
    }

    /**
     * Lifecycle function
     */
    async onInit() {
        await this.common.init();

        this.cache = await createCache<SnapshotCache>(
            this.db.sequelize,
            this.sdk.ctx.chainId,
            Snapshots.name,
            defaultCache,
        );

        info('Snapshot', 'initializing...');

        const { snapshot, position } = await getSnapshot(
            this.sdk,
            this.events,
            this.events.latestBlockNumber,
            undefined,
            true,
            this.core.signal,
        );

        if (position.blockNumber - this.cache.blockNumber >= this.config.interval) {
            await saveSnapshot(this.sdk.ctx.chainId, snapshot, position);

            this.cache.blockNumber = position.blockNumber;

            await this.cache.save();
        }

        info('Snapshot', 'initialized');

        this.latestSnapshot = snapshot;
        this.latestPosition = position;
    }

    /**
     * Lifecycle function
     */
    async onStart() {
        this.core.nonBlocking.on('newParsedEvent', this.onNewParsedEvent);

        this.working = this.work();
    }

    /**
     * Lifecycle function
     */
    async onStop() {
        // remove event listeners
        this.core.nonBlocking.off('newParsedEvent', this.onNewParsedEvent);

        this.channel.abort();

        // wait for all work to be completed
        await this.working;
    }
}
