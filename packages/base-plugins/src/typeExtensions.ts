import '@synfutures/fx-core';
import type { ethers } from 'ethers';
import type { Common, Blocks, DB, Source, Storage, Snapshots } from './plugins';

declare module '@synfutures/fx-core' {
    interface Events {
        synced: () => void;

        reorged: (blockNumber: number) => void;

        newBlock: (block: ethers.providers.Block) => void;

        newEvent: (logs: ethers.providers.Log[]) => void;

        newParsedEvent: (log: ethers.providers.Log, parsed: ethers.utils.LogDescription, processed: boolean) => void;

        newStoredBlockNumber: (blockNumber: number) => void;
    }

    interface Plugins {
        DB: DB;

        Blocks: Blocks;

        Common: Common;

        Source: Source;

        Storage: Storage;

        Snapshots: Snapshots;
    }
}
