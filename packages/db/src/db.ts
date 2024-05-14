import { Sequelize } from 'sequelize';
import type { ModelCtor } from './types';

export class DB {
    sequelize: Sequelize;

    private initializing?: Promise<void>;

    constructor(url: string, logging = false) {
        this.sequelize = new Sequelize(url, { logging });
    }

    /**
     * Initialize
     */
    async init(models: ModelCtor[]) {
        if (this.initializing) {
            return this.initializing;
        }

        return (this.initializing = (async () => {
            for (const model of models) {
                model.initialize(this.sequelize);
            }

            await this.sequelize.authenticate();

            for (const model of models) {
                await model.sync();
            }
        })());
    }

    /**
     * Close database connection
     */
    async close() {
        await this.sequelize.close();
    }
}
