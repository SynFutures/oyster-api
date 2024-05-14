/* eslint-disable @typescript-eslint/no-explicit-any */
import { Op, Transaction } from 'sequelize';
import ProgressBar from 'progress';
import { Snapshot, SynFuturesV3 } from '@synfutures/oyster-sdk';
import { Snapshot as SnapshotTable, EventPosition, Events } from '@synfutures/db';
import { _info } from '@synfutures/logger';
import { fromDBEvent } from '../utils';

async function replay(
    events: Events,
    snapshot: Snapshot,
    from: EventPosition,
    to?: number | EventPosition,
    progress = false,
    signal?: AbortSignal,
) {
    let flag = false;

    const onAbort = () => (flag = true);

    signal?.addEventListener('abort', onAbort);

    try {
        // latest snapshot position
        let latest = { ...from };

        // create progress if needed
        let bar: ProgressBar | undefined = undefined;
        if (progress) {
            const toBlockNumber = to ? (typeof to === 'number' ? to : to.blockNumber) : events.latestBlockNumber;

            bar = new ProgressBar(
                _info('Snapshots', 'replaying...').join(' ') + ' [:bar] :rate/bps :percent :etas',
                toBlockNumber - from.blockNumber,
            );
        }

        for await (const _events of events.findAllOrderByBTLASC(from, to)) {
            if (flag) {
                throw signal?.reason;
            }

            for (const event of _events) {
                const { log, parsedLog } = fromDBEvent(event);
                await snapshot.processParsedLog(log, parsedLog);

                if (flag) {
                    throw signal?.reason;
                }
            }

            const latestEvent = _events[_events.length - 1];

            // increase progress
            bar?.tick(latestEvent.blockNumber - latest.blockNumber);

            // update latest snapshot position
            latest = {
                blockNumber: latestEvent.blockNumber,
                transactionIndex: latestEvent.transactionIndex,
                logIndex: latestEvent.logIndex,
            };
        }

        return latest;
    } finally {
        signal?.removeEventListener('abort', onAbort);
    }
}

/**
 * Get snapshot at position
 * NOTE: If a snapshot is passed in, the snapshot will be changed
 * @param sdk SDK instance
 * @param events Events manager instance
 * @param to Event position
 * @param from From snapshot and position
 * @param progress Display replay progress
 * @param signal Abort signal
 * @returns Snapshot and latest position
 */
export async function getSnapshot(
    sdk: SynFuturesV3,
    events: Events,
    to: number | EventPosition,
    from?: {
        snapshot: Snapshot;
        position: EventPosition;
    },
    progress = false,
    signal?: AbortSignal,
) {
    let _from: EventPosition;
    let snapshot: Snapshot;

    if (from) {
        _from = from.position;
        snapshot = from.snapshot;
    } else {
        _from = {
            blockNumber: 0,
            transactionIndex: 0,
            logIndex: 0,
        };
        snapshot = new Snapshot(sdk);

        const conditions: any[] = [];
        if (typeof to === 'number') {
            conditions.push({
                blockNumber: {
                    [Op.lte]: to,
                },
            });
        } else {
            conditions.push({
                [Op.or]: [
                    {
                        blockNumber: {
                            [Op.lt]: to.blockNumber,
                        },
                    },
                    {
                        blockNumber: to.blockNumber,
                        transactionIndex: {
                            [Op.lt]: to.transactionIndex,
                        },
                    },
                    {
                        blockNumber: to.blockNumber,
                        transactionIndex: to.transactionIndex,
                        logIndex: {
                            [Op.lte]: to.logIndex,
                        },
                    },
                ],
            });
        }

        const _snapshot = await SnapshotTable.findOne({
            where: {
                chainId: sdk.ctx.chainId,
                [Op.and]: conditions,
            },
            order: [
                ['blockNumber', 'DESC'],
                ['transactionIndex', 'DESC'],
                ['logIndex', 'DESC'],
            ],
        });

        // deserialize snapshot if it exists
        if (_snapshot) {
            _from = {
                blockNumber: _snapshot.blockNumber,
                transactionIndex: _snapshot.transactionIndex,
                logIndex: _snapshot.logIndex,
            };
            snapshot.deserialize(_snapshot.snapshot);
        }
    }

    // replay events
    const position = await replay(events, snapshot, _from, to, progress, signal);

    return { snapshot, position };
}

/**
 * Save snapshot to database
 * @param chainId Chain ID
 * @param snapshot Snapshot
 * @param position Event position
 * @param transaction Tranasction instance
 */
export async function saveSnapshot(
    chainId: number,
    snapshot: Snapshot,
    position: EventPosition,
    transaction?: Transaction,
) {
    const _snapshot = await SnapshotTable.findOne({
        where: {
            chainId,
            blockNumber: position.blockNumber,
            transactionIndex: position.transactionIndex,
            logIndex: position.logIndex,
        },
        transaction,
    });

    // create if not exists
    if (_snapshot === null) {
        await SnapshotTable.create(
            {
                chainId,
                blockNumber: position.blockNumber,
                transactionIndex: position.transactionIndex,
                logIndex: position.logIndex,
                snapshot: snapshot.serialize(),
            },
            { transaction },
        );
    }
}
