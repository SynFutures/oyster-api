/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { ethers } from 'ethers';
import { Transaction } from 'sequelize';
import type { NewInstrumentEventObject } from '@synfutures/oyster-sdk/build/types/typechain/Gate';
import { Tracker } from '@synfutures/utils';
import { Core, Plugin } from '@synfutures/fx-core';
import { Instrument as InstrumentTable, Cache, createCache, EventStatus } from '@synfutures/db';
import { warn, info, debug, error } from '@synfutures/logger';
import type { ParsedLog } from '../types';
import { gateInterface, instrumentInterface, configInterface, initialBlockNumbers } from '../consts';
import {
    calcEventId,
    calcInstrumentId,
    formatNumber,
    formatHexString,
    serializeEventArgs,
    fromDBEvent,
} from '../utils';

type StorageConfig = {
    explicitlyFromBlockNumber?: number;
};

type StorageCache = {
    blockNumber: number;
};

const defaultCache: StorageCache = {
    blockNumber: 0,
};

/**
 * Modify the database according to the events
 */
export class Storage extends Plugin {
    private initializing?: Promise<void>;

    private cache: Cache<StorageCache>;

    private synced = false;

    private processing = false;
    private blocked?: () => void;
    private blocking?: Promise<void>;

    constructor(core: Core, private config: StorageConfig) {
        super(core);
    }

    private get common() {
        const common = this.core.getPlugin('Common');
        if (!common) {
            throw new Error('missing Common plugin');
        }
        return common;
    }

    private get db() {
        const db = this.core.getPlugin('DB');
        if (!db) {
            throw new Error('missing DB plugin');
        }
        return db;
    }

    private get sdk() {
        return this.common.sdk;
    }

    private get events() {
        return this.common.events;
    }

    /**
     * Get latest persistence block number
     * @returns Block number
     */
    getLatestStorageBlockNumber() {
        return this.cache.blockNumber;
    }

    /**
     * Block storage coroutine
     */
    block() {
        if (this.stopped) {
            return Promise.resolve(() => undefined);
        }

        if (this.blocked || this.blocking) {
            throw new Error('invalid block');
        }

        let resolve!: () => void;

        this.blocking = new Promise<void>((r) => (resolve = r)).finally(() => {
            // clear
            this.blocked = undefined;
            this.blocking = undefined;
        });

        return this.processing
            ? new Promise<void>((r) => (this.blocked = r)).then(() => resolve)
            : Promise.resolve(resolve);
    }

    async handleNewInstrumentEvent(
        id: string,
        log: ethers.providers.Log,
        parsed: ParsedLog<NewInstrumentEventObject>,
        transaction: Transaction,
        processed: boolean,
    ) {
        if (processed) {
            // ignore processed log
            return;
        }

        // add new instrument to database
        await InstrumentTable.create(
            {
                id: calcInstrumentId(this.sdk.ctx.chainId, parsed.args.instrument),
                address: formatHexString(parsed.args.instrument),
                chainId: this.sdk.ctx.chainId,
                index: formatHexString(parsed.args.index),
                base: formatHexString(parsed.args.base),
                quote: formatHexString(parsed.args.quote),
                symbol: parsed.args.symbol,
                createBy: id,
            },
            { transaction },
        );
    }

    private async processLogs(logs: ethers.providers.Log[], parsedLogs?: ethers.utils.LogDescription[]) {
        const reprocessing = !!parsedLogs;

        const tracker = new Tracker();

        let transaction: Transaction;

        try {
            // create a new transaction
            transaction = await this.db.sequelize.transaction();
        } catch (err) {
            error('Storage', 'create transaction error:', err);

            return false;
        }

        try {
            // save latest block number
            let latest = this.cache.blockNumber;

            for (let i = 0; i < logs.length; i++) {
                const log = logs[i];

                // calculate log id
                const id = calcEventId(
                    this.sdk.ctx.chainId,
                    log.address,
                    log.blockHash,
                    log.transactionHash,
                    log.logIndex,
                );

                const exists = await this.events.findOne({
                    where: { id, blockNumber: log.blockNumber },
                    transaction,
                });
                if (!reprocessing && exists) {
                    // ignore duplicate logs
                    continue;
                }

                // compare and find latest block number
                if (log.blockNumber > latest) {
                    latest = log.blockNumber;
                }

                let parsed: ethers.utils.LogDescription | undefined = parsedLogs?.[i];
                if (log.address.toLowerCase() === this.sdk.contracts.gate.address.toLowerCase()) {
                    if (!parsed) {
                        try {
                            parsed = gateInterface.parseLog(log);
                        } catch (err) {
                            warn('Storage', 'unknown gate event, ignore');
                            continue;
                        }
                    }

                    debug(
                        'Storage',
                        'new gate event, name:',
                        parsed.name,
                        'block number:',
                        log.blockNumber,
                        reprocessing ? '(reprocessing)' : '',
                    );
                } else if (log.address.toLowerCase() === this.sdk.contracts.config.address.toLowerCase()) {
                    if (!parsed) {
                        try {
                            parsed = configInterface.parseLog(log);
                        } catch (err) {
                            warn('Storage', 'unknown config event, ignore');
                            continue;
                        }
                    }

                    debug(
                        'Storage',
                        'new config event, name:',
                        parsed.name,
                        'block number:',
                        log.blockNumber,
                        reprocessing ? '(reprocessing)' : '',
                    );
                } else {
                    if (!parsed) {
                        try {
                            parsed = instrumentInterface.parseLog(log);
                        } catch (err) {
                            warn('Storage', 'unknown instrument event, ignore');
                            continue;
                        }
                    }

                    debug(
                        'Storage',
                        'new instrument event, name:',
                        parsed.name,
                        'block number:',
                        log.blockNumber,
                        reprocessing ? '(reprocessing)' : '',
                    );
                }

                const processed = !!(exists && (exists.status & EventStatus.PROCESSED) > 0);

                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const handler = (this as any)['handle' + parsed.name + 'Event'];
                if (handler) {
                    await handler.call(this, id, log, parsed, transaction, processed);
                }

                if (exists) {
                    // update log status if it has not been processed yet
                    if (!processed) {
                        exists.status += EventStatus.PROCESSED;

                        await exists.save({ transaction });
                    }
                } else {
                    // save log if not exists
                    await this.events.create(
                        {
                            id,
                            chainId: this.sdk.ctx.chainId,
                            name: parsed.name,
                            blockNumber: formatNumber(log.blockNumber),
                            blockHash: formatHexString(log.blockHash),
                            txHash: formatHexString(log.transactionHash),
                            transactionIndex: formatNumber(log.transactionIndex),
                            logIndex: formatNumber(log.logIndex),
                            status: EventStatus.PROCESSED,
                            address: formatHexString(log.address),
                            data: serializeEventArgs(parsed.args),
                        },
                        { transaction },
                    );
                }

                // send event
                await this.core.emit('newParsedEvent', log, parsed, processed);
            }

            const updated = this.cache.blockNumber !== latest;

            // update latest block number
            this.cache.blockNumber = latest;

            // save cache to database
            await this.cache.save(transaction);

            // commit transaction
            await transaction.commit();

            info(
                'Storage',
                'process logs:',
                logs.length,
                'total usage:',
                tracker.totalUsage(),
                'latest block number:',
                this.cache.blockNumber,
                reprocessing ? '(reprocessing)' : '',
            );

            if (updated) {
                // if the block number is updated, emit an event
                await this.core.emit('newStoredBlockNumber', this.cache.blockNumber);
            }

            return true;
        } catch (err) {
            error('Storage', 'catch error:', err);

            // something went wrong, rollback
            await transaction.rollback().catch((err) => {
                error('Storage', 'transaction rollback error:', err);
            });

            return false;
        }
    }

    private onNewEvent = async (logs: ethers.providers.Log | ethers.providers.Log[]) => {
        try {
            this.processing = true;

            const _logs = Array.isArray(logs) ? logs : [logs];

            for (let i = 0; i < _logs.length && !this.stopped; i += 1000) {
                if (this.blocking) {
                    // tell another coroutine that we are blocked
                    this.blocked && this.blocked();
                    // start blocking
                    await this.blocking;
                }

                const logs = _logs.slice(i, i + 1000);

                // this is quite important logic, so we need to retry until successful
                while (!(await this.processLogs(logs)) && !this.stopped) {
                    warn('Storage', 'retrying...');
                    await new Promise<void>((r) => setTimeout(r, 1000));
                }
            }
        } finally {
            this.processing = false;
        }
    };

    private onSynced = async () => {
        if (!this.synced) {
            this.synced = true;
        }
    };

    /**
     * Reorg
     * Reprocess any missing events
     * @param reorgBlockNumber Reorged block number
     */
    async reorg(reorgBlockNumber: number) {
        const tracker = new Tracker();

        info('Storage', 'reorging at:', reorgBlockNumber);

        for await (const events of this.events.findAllOrderByBTLASC(reorgBlockNumber - 1)) {
            const _events = events.map(fromDBEvent);
            await this.processLogs(
                _events.map((e) => e.log),
                _events.map((e) => e.parsedLog),
            );
        }

        info('Storage', 'reorg usage:', tracker.usage());
    }

    /**
     * Initialize
     */
    init() {
        if (this.initializing) {
            return this.initializing;
        }

        return (this.initializing = (async () => {
            this.cache = await createCache<StorageCache>(
                this.db.sequelize,
                this.sdk.ctx.chainId,
                'StorageCache',
                defaultCache,
            );

            if (this.config.explicitlyFromBlockNumber !== undefined) {
                // explicitly specify the block number
                this.cache.blockNumber = this.config.explicitlyFromBlockNumber;
                await this.cache.save();
            } else if (this.cache.blockNumber === 0) {
                // load default initial block number
                const initialBlockNumber = initialBlockNumbers.get(this.sdk.ctx.chainId);
                if (initialBlockNumber) {
                    this.cache.blockNumber = initialBlockNumber;
                    await this.cache.save();
                }
            }
        })());
    }

    /**
     * Lifecycle function
     */
    async onInit() {
        await this.init();
    }

    /**
     * Start listening events
     */
    async onStart() {
        this.core.blocking.on('newEvent', this.onNewEvent);
        this.core.blocking.on('synced', this.onSynced);
    }

    /**
     * Stop listening events
     */
    async onStop() {
        this.core.blocking.off('newEvent', this.onNewEvent);
        this.core.blocking.off('synced', this.onSynced);
    }
}
