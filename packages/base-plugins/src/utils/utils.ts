/* eslint-disable @typescript-eslint/no-explicit-any */
import crypto from 'crypto';
import { ethers, BigNumber } from 'ethers';
import { Event } from '@synfutures/db';

// used to sort logs
export function compareLog(
    a: { blockNumber: number; transactionIndex: number; logIndex: number },
    b: { blockNumber: number; transactionIndex: number; logIndex: number },
) {
    let res = a.blockNumber - b.blockNumber;
    if (res !== 0) {
        return res;
    }

    res = a.transactionIndex - b.transactionIndex;
    if (res !== 0) {
        return res;
    }

    return (res = a.logIndex - b.logIndex);
}

export function formatNumber(num: number | string) {
    if (typeof num === 'number') {
        return num;
    }
    if (num.startsWith('0x')) {
        return parseInt(num, 16);
    }
    return Number(num);
}

export function formatHexString(str: string) {
    return str.startsWith('0x') ? str.slice(2).toLowerCase() : str.toLowerCase();
}

export function serializeEventArgs(obj: any) {
    const result: any = {};
    for (const [k, v] of Object.entries(obj)) {
        if (v instanceof ethers.BigNumber) {
            result[k] = {
                bn: true,
                value: v.toString(),
            };
        } else if (typeof v === 'object') {
            result[k] = serializeEventArgs(v);
        } else {
            result[k] = v;
        }
    }

    // additional length for args
    if (obj.length > 0) {
        result['length'] = obj.length;
    }

    return result;
}

export function deserializeEventArgs(obj: any) {
    const result: any = {};
    for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'object' && v !== null) {
            const _v: any = v;
            if (_v.bn && _v.value) {
                result[k] = BigNumber.from(_v.value);
            } else {
                result[k] = deserializeEventArgs(v);
            }
        } else {
            result[k] = v;
        }
    }
    return result;
}

export function fromDBEvent(event: Event) {
    const log = {
        blockNumber: event.blockNumber,
        blockHash: '0x' + event.blockHash,
        transactionIndex: event.transactionIndex,
        address: '0x' + event.address,
        logIndex: event.logIndex,
    } as ethers.providers.Log;

    const parsedLog = {
        name: event.name,
        args: deserializeEventArgs(event.data),
    } as unknown as ethers.utils.LogDescription;

    return { log, parsedLog };
}

function calcId(...args: (string | number)[]) {
    return crypto
        .createHash('sha256')
        .update(args.map((ele) => (typeof ele === 'number' ? ele.toString() : formatHexString(ele))).join(','))
        .digest('hex');
}

export function calcInstrumentId(chainId: number, address: string) {
    return calcId(chainId, address);
}

export function calcEventId(chainId: number, address: string, blockHash: string, txHash: string, logIndex: number) {
    return calcId(chainId, address, blockHash, txHash, logIndex);
}
