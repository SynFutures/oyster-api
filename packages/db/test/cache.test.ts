/* eslint-disable @typescript-eslint/no-explicit-any */
import { Sequelize } from 'sequelize';
import { createCache, destroyCache, Cache } from '../src';
import { expect } from 'chai';

describe('Cache', function () {
    const db = process.env['TEST_DB'];

    if (db !== undefined) {
        const chainId = 100;

        let sequelize!: Sequelize;
        let cache!: Cache<any>;

        before(async function () {
            sequelize = new Sequelize(db, { logging: false });

            await sequelize.authenticate();

            cache = await createCache(sequelize, chainId, 'Test');
        });

        after(async function () {
            await destroyCache(sequelize, chainId);

            await sequelize.close();
        });

        it('should get keys succeed', async function () {
            cache['wuhu'] = 'wuhu';

            await cache.save();

            expect(Array.from(Object.keys(cache)).includes('wuhu')).be.true;
        });
    }
});
