import { Snapshot } from '@synfutures/oyster-sdk';
import { JSONRPC, JSONRPCError, JSONRPCErrorCode, Tracker } from '@synfutures/utils';
import { Plugin, combineSignals } from '@synfutures/fx-core';
import { info, warn } from '@synfutures/logger';
import { getSnapshot } from '@synfutures/base-plugins';
import { EventPosition } from '@synfutures/db';

enum SnapshotErrorCode {
    Reorging = 100,
    Unavailable,
    Generating,
}

function snapshotId(chainId: number, position: number | EventPosition) {
    return typeof position === 'number'
        ? `${chainId}-${position}`
        : `${chainId}-${position.blockNumber}-${position.transactionIndex}-${position.logIndex}`;
}

function parseSnapshotId(id: string): {
    chainId: number;
    blockNumber: number;
    transactionIndex?: number;
    logIndex?: number;
} {
    const elements = id.split('-');

    return elements.length === 2
        ? {
              chainId: parseInt(elements[0]),
              blockNumber: parseInt(elements[1]),
          }
        : {
              chainId: parseInt(elements[0]),
              blockNumber: parseInt(elements[1]),
              transactionIndex: parseInt(elements[2]),
              logIndex: parseInt(elements[3]),
          };
}

/**
 * Snapshot API handler
 */
export class Handler extends Plugin {
    private generating = new Map<string, AbortController>();
    private generated = new Map<string, Snapshot>();

    private get sdk() {
        const common = this.core.getPlugin('Common');
        if (!common) {
            throw new Error('missing Common plugin');
        }
        return common.sdk;
    }

    private get events() {
        const common = this.core.getPlugin('Common');
        if (!common) {
            throw new Error('missing Common plugin');
        }
        return common.events;
    }

    private get subscriber() {
        const subscriber = this.core.getPlugin('Subscriber');
        if (!subscriber) {
            throw new Error('missing Subscriber plugin');
        }
        return subscriber;
    }

    private get snapshots() {
        const snapshots = this.core.getPlugin('Snapshots');
        if (!snapshots) {
            throw new Error('missing Snapshots plugin');
        }
        return snapshots;
    }

    /**
     * Handle websocket message
     * @param msg Raw message
     * @param signal Abort signal
     * @returns Response
     */
    async handle(msg: string, signal: AbortSignal): Promise<string> {
        let _id: string | undefined = undefined;

        let _method: string | undefined = undefined;

        let tracker: Tracker | undefined = undefined;

        try {
            const [type, data] = JSONRPC.parse(msg);

            if (type !== 'request') {
                _id = data.id;

                // we are the server, ignoring all other types
                throw new JSONRPCError(JSONRPCErrorCode.InvalidRequest, 'invalid request');
            }

            const { id, method, params } = data;

            _id = id;

            _method = method;

            // security check to prevent re-entry into the handle function
            if (method === '') {
                throw new JSONRPCError(JSONRPCErrorCode.NotFound, `unknown method: ${method}`);
            }

            const handler = (this as any)[`handle${method[0].toUpperCase() + method.substring(1)}`];

            if (!handler) {
                throw new JSONRPCError(JSONRPCErrorCode.NotFound, `unknown method: ${method}`);
            }

            tracker = new Tracker();

            return JSON.stringify(JSONRPC.formatJSONRPCResult(id, await handler.call(this, params, signal)));
        } catch (err) {
            warn('Handler', 'handle request error:', err.message);

            return JSON.stringify(JSONRPC.formatJSONRPCError(err, _id));
        } finally {
            if (tracker) {
                info('Handler', 'handle request:', _method, 'usage:', tracker.usage());
            }
        }
    }

    private getSnapshotById(id?: string) {
        if (id === undefined) {
            const snapshot = this.snapshots.getLatestSnapshot();

            if (snapshot === false) {
                throw new JSONRPCError(SnapshotErrorCode.Reorging, 'reorging');
            } else if (!snapshot) {
                throw new JSONRPCError(SnapshotErrorCode.Unavailable, 'unavailable');
            } else {
                return snapshot;
            }
        } else if (this.generating.has(id)) {
            throw new JSONRPCError(SnapshotErrorCode.Generating, 'still generating');
        } else {
            const snapshot = this.generated.get(id);

            if (!snapshot) {
                throw new JSONRPCError(JSONRPCErrorCode.NotFound, 'not found');
            }

            return snapshot;
        }
    }

    async handleState() {
        return {
            storage: {
                blockNumber: this.events.latestBlockNumber,
            },
            snapshots: this.snapshots.state,
        };
    }

    async handleGenerateSnapshot(
        params: {
            blockNumber: number;
            transactionIndex?: number;
            logIndex?: number;
        },
        signal: AbortSignal,
    ) {
        if (
            typeof params !== 'object' ||
            typeof params.blockNumber !== 'number' ||
            (params.transactionIndex !== undefined && typeof params.transactionIndex !== 'number') ||
            (params.logIndex !== undefined && typeof params.logIndex !== 'number')
        ) {
            throw new JSONRPCError(JSONRPCErrorCode.InvalidRequest, 'invalid params');
        }

        const { blockNumber, transactionIndex, logIndex } = params;

        let to: number | EventPosition;

        if (transactionIndex !== undefined && logIndex !== undefined) {
            to = { blockNumber, transactionIndex, logIndex };
        } else if (transactionIndex === undefined && logIndex === undefined) {
            to = blockNumber;
        } else {
            throw new JSONRPCError(JSONRPCErrorCode.InvalidRequest, 'invalid params');
        }

        const snapId = snapshotId(this.sdk.ctx.chainId, to);

        if (this.generating.has(snapId)) {
            throw new JSONRPCError(SnapshotErrorCode.Generating, 'still generating');
        } else if (this.generated.has(snapId)) {
            // already exists
            return snapId;
        }

        // independent aborter for each generating,
        // may be triggered when reorg
        const aborter = new AbortController();

        this.generating.set(snapId, aborter);

        try {
            const { snapshot, position } = await getSnapshot(
                this.sdk,
                this.events,
                to,
                undefined,
                false,
                combineSignals([aborter.signal, signal]),
            );

            // save to memory
            this.generated.set(snapId, snapshot);

            const underlyingSnapId = snapshotId(this.sdk.ctx.chainId, position);

            if (underlyingSnapId !== snapId) {
                // the actual location of the snapshot may be different from the specified one,
                // and another copy needs to be saved.
                this.generated.set(underlyingSnapId, snapshot);
            }

            return snapId;
        } finally {
            this.generating.delete(snapId);
        }
    }

    async handleClearSnapshot(params: string) {
        if (typeof params !== 'string') {
            throw new JSONRPCError(JSONRPCErrorCode.InvalidRequest, 'invalid params');
        }

        const snapshot = this.generated.get(params);

        if (!snapshot) {
            return false;
        }

        // delete all identical snapshots
        for (const [id, snap] of this.generated) {
            if (snapshot === snap) {
                this.generated.delete(id);
            }
        }

        return true;
    }

    async handleListSnapshots() {
        const response: {
            [id: string]: { chainId: number; blockNumber: number; transactionIndex?: number; logIndex?: number };
        } = {};

        for (const id of this.generated.keys()) {
            response[id] = parseSnapshotId(id);
        }

        return response;
    }

    async handleQueryAccount(params: { id?: string; address: string; instrument: string; expiry: number }) {
        if (
            typeof params !== 'object' ||
            (params.id !== undefined && typeof params.id !== 'string') ||
            typeof params.address !== 'string' ||
            typeof params.instrument !== 'string' ||
            typeof params.expiry !== 'number'
        ) {
            throw new JSONRPCError(JSONRPCErrorCode.InvalidRequest, 'invalid params');
        }

        const snapshot = this.getSnapshotById(params.id);

        const account = snapshot.instruments
            .get(params.instrument.toLowerCase())
            ?.accounts.get(params.expiry)
            ?.get(params.address.toLowerCase());

        if (!account) {
            throw new JSONRPCError(JSONRPCErrorCode.NotFound, 'account not found');
        }

        const orders: any = {};

        for (const oid of account.oids) {
            const order = account.orders.get(oid);

            orders[oid.toString()] = {
                balance: order?.balance.toString(),
                size: order?.size.toString(),
            };
        }

        const ranges: any = {};

        for (const rid of account.rids) {
            const range = account.ranges.get(rid);

            ranges[rid.toString()] = {
                liquidity: range?.liquidity.toString(),
                entryFeeIndex: range?.entryFeeIndex.toString(),
                balance: range?.balance.toString(),
                sqrtEntryPX96: range?.sqrtEntryPX96.toString(),
            };
        }

        return {
            onumber: account.onumber,
            rnumber: account.rnumber,
            oids: account.oids,
            rids: account.rids,
            position: {
                balance: account.position.balance.toString(),
                size: account.position.size.toString(),
                entryNotional: account.position.entryNotional.toString(),
                entrySocialLossIndex: account.position.entrySocialLossIndex.toString(),
                entryFundingIndex: account.position.entryFundingIndex.toString(),
            },
            orders,
            ranges,
        };
    }

    async handleQueryAMM(params: { id?: string; instrument: string; expiry: number }) {
        if (
            typeof params !== 'object' ||
            (params.id !== undefined && typeof params.id !== 'string') ||
            typeof params.instrument !== 'string' ||
            typeof params.expiry !== 'number'
        ) {
            throw new JSONRPCError(JSONRPCErrorCode.InvalidRequest, 'invalid params');
        }

        const snapshot = this.getSnapshotById(params.id);

        const amm = snapshot.instruments.get(params.instrument.toLowerCase())?.pairStates.get(params.expiry)?.amm;

        if (!amm) {
            throw new JSONRPCError(JSONRPCErrorCode.NotFound, 'amm not found');
        }

        return {
            timestamp: amm.timestamp,
            status: amm.status,
            tick: amm.tick,
            sqrtPX96: amm.sqrtPX96.toString(),
            liquidity: amm.liquidity.toString(),
            totalLiquidity: amm.totalLiquidity.toString(),
            involvedFund: amm.involvedFund.toString(),
            openInterests: amm.openInterests.toString(),
            feeIndex: amm.feeIndex.toString(),
            protocolFee: amm.protocolFee.toString(),
            totalLong: amm.totalLong.toString(),
            totalShort: amm.totalShort.toString(),
            longSocialLossIndex: amm.longSocialLossIndex.toString(),
            shortSocialLossIndex: amm.shortSocialLossIndex.toString(),
            longFundingIndex: amm.longFundingIndex.toString(),
            shortFundingIndex: amm.shortFundingIndex.toString(),
            insuranceFund: amm.insuranceFund.toString(),
            settlementPrice: amm.settlementPrice.toString(),
        };
    }

    async handleSubscribeOrderFilled(params: { address: string }) {
        if (typeof params !== 'object' || typeof params.address !== 'string') {
            throw new JSONRPCError(JSONRPCErrorCode.InvalidRequest, 'invalid params');
        }

        await this.subscriber.subscribeOrderFilled(params.address);

        return true;
    }

    async handleUnsubscribeOrderFilled(params: { address: string }) {
        if (typeof params !== 'object' || typeof params.address !== 'string') {
            throw new JSONRPCError(JSONRPCErrorCode.InvalidRequest, 'invalid params');
        }

        await this.subscriber.unsubscribeOrderFilled(params.address);

        return true;
    }

    private onReorged = (reorgBlockNumber: number) => {
        for (const [id, aborter] of this.generating) {
            const { blockNumber } = parseSnapshotId(id);

            if (blockNumber >= reorgBlockNumber) {
                warn('Handler', 'reorged, stop generating snapshot:', id);

                aborter.abort(new Error('reorged'));
            }
        }

        for (const id of this.generated.keys()) {
            const { blockNumber } = parseSnapshotId(id);

            if (blockNumber >= reorgBlockNumber) {
                warn('Handler', 'reorged, remove snapshot:', id);

                this.generated.delete(id);

                // TODO: maybe we need to send a notification?
            }
        }
    };

    /**
     * Lifecycle function
     */
    async onStart() {
        this.core.nonBlocking.on('reorged', this.onReorged);
    }

    /**
     * Lifecycle function
     */
    async onStop() {
        this.core.nonBlocking.off('reorged', this.onReorged);
    }
}
