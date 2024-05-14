import { Plugin, Core } from '@synfutures/fx-core';
import { DB as RawDB, models } from '@synfutures/db';

type DBConfig = {
    url: string;
    logging?: boolean;
};

const defaultDBConfig: Partial<DBConfig> = {
    logging: false,
};

export class DB extends Plugin {
    private config: DBConfig;

    private initializing?: Promise<void>;

    rawDB: RawDB;

    constructor(core: Core, config: DBConfig) {
        super(core);

        this.config = {
            ...defaultDBConfig,
            ...config,
        };

        this.rawDB = new RawDB(this.config.url, this.config.logging);
    }

    /**
     * Get sequelize instance
     */
    get sequelize() {
        return this.rawDB.sequelize;
    }

    /**
     * Initialize database,
     * create tables if not exists.
     */
    init() {
        if (this.initializing) {
            return this.initializing;
        }

        return (this.initializing = (async () => {
            await this.rawDB.init(models);
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
        await this.rawDB.close();
    }
}
