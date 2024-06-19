import { ethers } from 'ethers';
import { CHAIN_ID } from '@derivation-tech/web3-core';
import { Plugin, Core } from '@synfutures/fx-core';
import { Instrument } from '@synfutures/db';
import { error, info, debug, warn } from '@synfutures/logger';
import { Channel, limitedMap, Tracker, WebSocket, JSONRPCWebSocket } from '@synfutures/utils';
import { LogSubscriber, BlockNumberSubscriber, LogFetcher, compareLog, formatHexString, fetch } from '../utils';
import { gateInterface } from '../consts';

type Log = ethers.providers.Log;

type MixedLog =
    | Log
    | {
          blockNumber: number;
          transactionHash: string;
          transactionIndex: number;
          logIndex: number;
          promise: Promise<Log[]>;
      };

type SourceConfig = {
    batchSize: number;
    mode: 'fetch' | 'subscribe';
    parallel: number;
    threshold: number;
    fetchInterval: number;
    confirmation: number;
};

const defaultConfig: Partial<SourceConfig> = {
    mode: 'subscribe',
    batchSize: 1000,
    parallel: 10,
    threshold: 10000,
    fetchInterval: 3,
};

function isLog(log: MixedLog): log is Log {
    return !('promise' in log);
}

function compareMixedLog(a: MixedLog, b: MixedLog) {
    if (isLog(a)) {
        if (isLog(b)) {
            return compareLog(a, b);
        } else {
            const res = compareLog(a, b);
            return res === 0 ? 1 : res;
        }
    } else {
        if (isLog(b)) {
            const res = compareLog(a, b);
            return res === 0 ? -1 : res;
        } else {
            return compareLog(a, b);
        }
    }
}

/**
 * Data source
 */
export class Source extends Plugin {
    logFetcher: LogFetcher;

    private config: SourceConfig;

    private jsonrpc?: JSONRPCWebSocket;
    private logSubscriber?: LogSubscriber;
    private blockNumberSubscriber?: BlockNumberSubscriber;

    private instruments = new Set<string>();

    private pendingLogs: MixedLog[] = [];
    private confirmingLogs: MixedLog[] = [];
    private logs = new Channel<MixedLog[]>();

    private latestBlockNumber?: number;
    private blockNumbers = new Channel<number>();

    private fetchingLogs?: NodeJS.Timeout;
    private fetchingBlockNumbers?: NodeJS.Timeout;

    private syncTarget?: number;
    private syncing?: Promise<void>;
    private synced = false;

    private processingLogs: Promise<void>;
    private processingBlockNumbers: Promise<void>;

    private initializing?: Promise<void>;

    private awake?: () => void;

    constructor(core: Core, config: Partial<SourceConfig>) {
        super(core);

        this.config = {
            ...defaultConfig,
            ...config,
        } as SourceConfig;
    }

    private get common() {
        const common = this.core.getPlugin('Common');
        if (!common) {
            throw new Error('missing Common plugin');
        }
        return common;
    }

    private get blocks() {
        const blocks = this.core.getPlugin('Blocks');
        if (!blocks) {
            throw new Error('missing Blocks plugin');
        }
        return blocks;
    }

    private get storage() {
        const storage = this.core.getPlugin('Storage');
        if (!storage) {
            throw new Error('missing Storage plugin');
        }
        return storage;
    }

    private get sdk() {
        return this.common.sdk;
    }

    private get ctx() {
        return this.sdk.ctx;
    }

    private get provider() {
        return this.ctx.provider;
    }

    // load instruments from database
    private async loadInstruments() {
        const instruments = await Instrument.findAll({
            where: {
                chainId: this.ctx.chainId,
            },
            order: ['id'],
        });

        // save the instrument address
        for (const { address } of instruments) {
            this.instruments.add(address);
        }
    }

    private pendingSize() {
        let size = 0;

        for (const logs of this.logs.pending) {
            if (logs !== null) {
                size += Array.isArray(logs) ? logs.length : 1;
            }
        }

        return size;
    }

    private addConfirmingLogs(from: 'fetch' | 'subscribe', ...logs: MixedLog[]) {
        if (from === 'fetch') {
            this.confirmingLogs.push(...logs);
        } else {
            for (const log of logs) {
                if (isLog(log) && log.removed) {
                    const index = this.confirmingLogs.findIndex(
                        (_log) =>
                            _log.blockNumber === log.blockNumber &&
                            _log.transactionHash === log.transactionHash &&
                            _log.transactionIndex === log.transactionIndex &&
                            _log.logIndex === log.logIndex,
                    );

                    if (index !== -1) {
                        this.confirmingLogs.splice(index, 1);

                        info(
                            'Source',
                            'removed log:',
                            log.blockNumber,
                            log.transactionHash,
                            log.transactionIndex,
                            log.logIndex,
                        );
                    } else {
                        warn(
                            'Source',
                            'unknown removed log:',
                            log.blockNumber,
                            log.transactionHash,
                            log.transactionIndex,
                            log.logIndex,
                        );
                    }
                } else {
                    this.confirmingLogs.push(log);
                }
            }
        }
    }

    private addLogs(from: 'subscribe' | 'fetch', ...logs: MixedLog[]) {
        if (this.latestBlockNumber === undefined) {
            this.addConfirmingLogs(from, ...logs);
            return;
        }

        const confirmingLogs: MixedLog[] = [];

        const confirmedLogs: MixedLog[] = [];

        for (const log of logs) {
            if (log.blockNumber > this.latestBlockNumber - this.config.confirmation) {
                confirmingLogs.push(log);
            } else {
                confirmedLogs.push(log);
            }
        }

        if (confirmingLogs.length > 0) {
            this.addConfirmingLogs(from, ...confirmingLogs);
        }

        if (confirmedLogs.length > 0) {
            this.logs.push(confirmedLogs);
        }
    }

    private async resetFetchTarget() {
        this.syncTarget = await this.ctx.retry(() => this.provider.getBlockNumber());

        this.pendingLogs = this.pendingLogs.filter((l) => l.blockNumber >= this.syncTarget!);
    }

    private async _sync() {
        try {
            await this.resetFetchTarget();

            let current = this.storage.getLatestStorageBlockNumber();
            let times = 0;

            const tracker = new Tracker();

            info('Source', 'start syncing, from:', current, 'to:', this.syncTarget!);

            while (current <= this.syncTarget!) {
                if (this.stopped) {
                    return;
                }

                // calcuate from and to block number
                const from = current;
                let to = from + this.config.batchSize;
                if (to > this.syncTarget!) {
                    to = this.syncTarget!;
                }

                let logs = await this.logFetcher.fetch(from, to);

                const newInstruments = new Set<string>();

                // track new instrument
                for (const log of logs) {
                    if (log.address.toLowerCase() === this.sdk.contracts.gate.address.toLowerCase()) {
                        try {
                            const parsed = gateInterface.parseLog(log);

                            if (parsed.name === 'NewInstrument') {
                                const instrument = formatHexString(parsed.args.instrument);

                                if (!this.instruments.has(instrument) && !newInstruments.has(instrument)) {
                                    info('Source', 'new instrument:', '0x' + instrument);

                                    // add new instrument address to memory cache
                                    this.instruments.add(instrument);

                                    newInstruments.add(instrument);

                                    this.logFetcher.add('0x' + instrument, []);

                                    this.logSubscriber?.add('0x' + instrument, []);
                                }
                            }
                        } catch (err) {
                            // ignore parse log error
                        }
                    }
                }

                if (newInstruments.size > 0) {
                    // reset target to newest block number
                    await this.resetFetchTarget();
                }

                // manually fetch the logs of new instrument and sort
                logs = logs
                    .concat(
                        (
                            await limitedMap(
                                Array.from(newInstruments),
                                (instrument) => fetch(this.ctx, this.provider, from, to, '0x' + instrument, []),
                                this.config.parallel,
                            )
                        ).flat(),
                    )
                    .sort(compareLog);

                // push to channel
                if (logs.length > 0) {
                    this.addLogs('fetch', ...logs);
                }

                info('Source', 'syncing, from:', from, 'to:', to, 'usage:', tracker.usage());

                const size = this.pendingSize();

                // make sure the queue doesn't grow too large
                if (size >= this.config.threshold) {
                    debug('Source', 'queue too large, size:', size, 'sleep a while...');

                    tracker.pause();

                    // sleep a while...
                    await new Promise<void>((r) => (this.awake = r)).finally(() => (this.awake = undefined));

                    tracker.resume();
                }

                current = to;

                if (to === this.syncTarget!) {
                    if (this.pendingLogs.length > 0) {
                        const first = this.pendingLogs[0].blockNumber;

                        if (first <= this.syncTarget!) {
                            // we have moved beyond the first known block, break the loop
                            break;
                        }

                        // set the sync target to the first known block
                        this.syncTarget = first;
                    } else {
                        // NOTE: to prevent eth_getLogs requests from being too slow
                        if (++times >= 10) {
                            debug('Source', 'reach replay times limit, break');
                            break;
                        }

                        // query and compare new latest block number
                        const latest = await this.ctx.retry(() => this.provider.getBlockNumber());

                        if (this.syncTarget! === latest) {
                            // no change, break the loop
                            break;
                        }

                        // set the sync target to the new latest block number
                        this.syncTarget = latest;
                    }
                }
            }

            info('Source', 'sync finished, total usage:', tracker.totalUsage());

            // pick the pending log and put it in the channel
            this.addLogs('subscribe', ...this.pendingLogs.sort(compareMixedLog));

            // clear pending logs
            this.pendingLogs = [];
        } catch (err) {
            error('Source', 'sync error:', err);
        } finally {
            this.syncTarget = undefined;
        }
    }

    private sync() {
        if (!this.syncing) {
            this.syncing = this._sync().finally(() => {
                this.syncing = undefined;
            });
        }
    }

    private confirm() {
        if (this.confirmingLogs.length === 0) {
            return;
        }

        const confirmingLogs: MixedLog[] = [];

        const confirmedLogs: MixedLog[] = [];

        for (const log of this.confirmingLogs.sort(compareMixedLog)) {
            if (log.blockNumber > this.latestBlockNumber! - this.config.confirmation) {
                confirmedLogs.push(log);
            } else {
                confirmedLogs.push(log);
            }
        }

        this.confirmingLogs = confirmingLogs;

        if (confirmedLogs.length > 0) {
            this.logs.push(confirmedLogs);
        }
    }

    private maybeEmitSynced() {
        // emit the synced event for other plugins when synchronizing for the first time
        if (!this.synced && !this.syncing && this.logs.pending.length === 0) {
            this.synced = true;

            info('Source', 'synced');

            this.core.emit('synced').catch((err) => error('Source', 'catch error:', err));
        }
    }

    private trackNewInstrument(log: Log): MixedLog | undefined {
        if (log.address.toLowerCase() === this.sdk.contracts.gate.address.toLowerCase()) {
            try {
                const parsed = gateInterface.parseLog(log);

                if (parsed.name === 'NewInstrument') {
                    const instrument = formatHexString(parsed.args.instrument);

                    if (!this.instruments.has(instrument)) {
                        info('Source', 'new instrument:', instrument);

                        // add new instrument address to memory cache
                        this.instruments.add(instrument);

                        this.logFetcher.add('0x' + instrument, []);

                        this.logSubscriber?.add('0x' + instrument, []);

                        // manually fetch the logs of new instrument
                        return {
                            blockNumber: log.blockNumber,
                            transactionHash: log.transactionHash,
                            transactionIndex: log.transactionIndex,
                            logIndex: log.logIndex,
                            promise: (async () => {
                                for (let i = 0; i < 30; i++) {
                                    const logs = await fetch(
                                        this.ctx,
                                        this.provider,
                                        log.blockNumber,
                                        log.blockNumber,
                                        '0x' + instrument,
                                        [],
                                    );

                                    if (logs.length > 0) {
                                        // NOTE: there is an extreme possibility that the node has not obtained
                                        //       the latest block yet, so multiple attempts are needed.
                                        return logs;
                                    }

                                    warn(
                                        'Source',
                                        'replay for single instrument:',
                                        instrument,
                                        'blockNumber:',
                                        log.blockNumber,
                                        'logs length is zero, times:',
                                        i + 1,
                                    );

                                    await new Promise<void>((r) => setTimeout(r, 333));
                                }

                                return [];
                            })(),
                        };
                    }
                }
            } catch (err) {
                // ignore parse log error
            }
        }

        return undefined;
    }

    private async processLogs() {
        for await (const next of this.logs) {
            try {
                const logs = (await Promise.all(next.map((l) => (isLog(l) ? l : l.promise.then((ls) => ls))))).flat();

                // emit event for other plugins
                await this.core.emit('newEvent', logs);

                // try to wake up the sync coroutine
                if (this.awake && this.pendingSize() < this.config.threshold) {
                    this.awake();
                }

                this.maybeEmitSynced();
            } catch (err) {
                error('Source', 'error:', err);
            }
        }
    }

    private async processBlockNumbers() {
        for await (const blockNumber of this.blockNumbers) {
            try {
                const block = await this.blocks.getBlock(blockNumber);

                // update latest block number
                this.latestBlockNumber = block.number;

                // confirm logs
                this.confirm();

                // emit event for other plugins
                await this.core.emit('newBlock', block);
            } catch (err) {
                error('Source', 'error:', err);
            }
        }
    }

    private onConnected = () => {
        // clear pending logs
        this.pendingLogs = [];

        // start syncing
        this.sync();
    };

    private onLoss = () => {
        // clear pending logs
        this.pendingLogs = [];

        // start syncing
        this.sync();
    };

    private onNewLog = (log: ethers.providers.Log) => {
        const mixedLog = this.trackNewInstrument(log);

        if (this.syncing && this.syncTarget) {
            if (log.blockNumber >= this.syncTarget) {
                if (mixedLog) {
                    this.pendingLogs.push(mixedLog);
                }

                this.pendingLogs.push(log);
            }
        } else {
            if (mixedLog) {
                this.addLogs('subscribe', mixedLog);
            }

            this.addLogs('subscribe', log);
        }
    };

    private onNewBlockNumber = (blockNumber: number) => {
        this.blockNumbers.push(blockNumber);
    };

    /**
     * Initialize
     */
    init() {
        if (this.initializing) {
            return this.initializing;
        }

        return (this.initializing = (async () => {
            await this.common.init();

            await this.storage.init();

            // load instrument addresses
            await this.loadInstruments();

            this.logFetcher = new LogFetcher(this.ctx, this.provider, this.config.parallel);

            // subscribe gate logs
            this.logFetcher.add(this.sdk.contracts.gate.address, []);

            // subscribe config logs
            this.logFetcher.add(this.sdk.contracts.config.address, []);

            // subscribe instruments logs
            for (const instrument of this.instruments) {
                this.logFetcher.add('0x' + instrument, []);
            }

            if (this.config.mode === 'subscribe') {
                const url = process.env[CHAIN_ID[this.sdk.ctx.chainId] + '_WSS'];
                if (!url) {
                    throw new Error('missing wss url');
                }

                this.jsonrpc = new JSONRPCWebSocket(new WebSocket({ url }));
                this.logSubscriber = new LogSubscriber(this.jsonrpc);
                this.blockNumberSubscriber = new BlockNumberSubscriber(this.jsonrpc);

                // subscribe gate logs
                this.logSubscriber.add(this.sdk.contracts.gate.address, []);

                // subscribe config logs
                this.logSubscriber.add(this.sdk.contracts.config.address, []);

                // subscribe instruments logs
                for (const instrument of this.instruments) {
                    this.logSubscriber.add('0x' + instrument, []);
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
     * Lifecycle function
     */
    async onStart() {
        this.logSubscriber?.jsonrpc.ws.on('connected', this.onConnected);
        this.logSubscriber?.jsonrpc.ws.on('loss', this.onLoss);

        this.logSubscriber?.on('newLog', this.onNewLog);
        this.blockNumberSubscriber?.on('newBlockNumber', this.onNewBlockNumber);

        this.jsonrpc?.start();
        this.logSubscriber?.start();
        this.blockNumberSubscriber?.start();

        this.processingLogs = this.processLogs();
        this.processingBlockNumbers = this.processBlockNumbers();

        // start syncing
        this.sync();

        if (this.config.mode === 'fetch') {
            // start a timer to regularly sync logs
            this.fetchingLogs = setInterval(() => this.sync(), this.config.fetchInterval * 1000);

            // start a timer to regularly obtain the latest blocks
            let previos: number | undefined = undefined;
            let fetching: Promise<void> | undefined;
            this.fetchingBlockNumbers = setInterval(() => {
                if (!fetching) {
                    fetching = (async () => {
                        // get latest block number
                        const latest = await this.ctx.retry(() => this.provider.getBlockNumber());

                        // compare with previous block number
                        if (previos === undefined) {
                            this.onNewBlockNumber(latest);
                        } else {
                            for (let i = previos + 1; i <= latest; i++) {
                                this.onNewBlockNumber(i);
                            }
                        }

                        // udpate previous
                        previos = latest;
                    })().finally(() => (fetching = undefined));
                }
            }, this.config.fetchInterval * 1000);
        }
    }

    /**
     * Lifecycle function
     */
    async onStop() {
        if (this.fetchingLogs) {
            clearInterval(this.fetchingLogs);
            this.fetchingLogs = undefined;
        }
        if (this.fetchingBlockNumbers) {
            clearInterval(this.fetchingBlockNumbers);
            this.fetchingBlockNumbers = undefined;
        }

        this.logSubscriber?.jsonrpc.ws.off('connected', this.onConnected);
        this.logSubscriber?.jsonrpc.ws.off('loss', this.onLoss);

        this.logSubscriber?.off('newLog', this.onNewLog);
        this.blockNumberSubscriber?.off('newBlockNumber', this.onNewBlockNumber);

        this.jsonrpc?.stop();
        this.logSubscriber?.stop();
        this.blockNumberSubscriber?.stop();

        // abort channel
        this.logs.abort();
        this.blockNumbers.abort();

        // wake up the sync coroutine
        if (this.awake) {
            this.awake();
        }

        // wait for job to complete
        await this.processingLogs;
        await this.processingBlockNumbers;
    }
}
