import { SynFuturesV3 } from '@synfutures/oyster-sdk';
import { Core, Plugin } from '@synfutures/fx-core';
import { Events } from '@synfutures/db';

type CommonConfig = {
    network: string;
};

/**
 * A simple context wrapper
 */
export class Common extends Plugin {
    readonly sdk: SynFuturesV3;
    readonly events: Events;

    private initializing?: Promise<void>;

    constructor(core: Core, config: CommonConfig) {
        super(core);

        this.sdk = SynFuturesV3.getInstance(config.network);
        this.events = new Events(this.db.sequelize, this.sdk.ctx.chainId);
    }

    private get db() {
        const db = this.core.getPlugin('DB');
        if (!db) {
            throw new Error('missing DB plugin');
        }
        return db;
    }

    /**
     * Initialize
     */
    init() {
        if (this.initializing) {
            return this.initializing;
        }

        return (this.initializing = (async () => {
            // wait for database initialization to complete
            await this.db.init();

            // init event table
            await this.events.init();
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
    async onDestroy() {
        // close websocket connection if exists
        await this.sdk.ctx.close();
    }
}
