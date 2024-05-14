/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { expect } from 'chai';
import { Sequelize, Op } from 'sequelize';
import { Events, Event, EventIndex } from '../src';

describe('Events', function () {
    const db = process.env['TEST_DB'];

    if (db !== undefined) {
        const chainId = 100;
        const maxSizeForSingleTable = 10;

        let sequelize!: Sequelize;
        let events!: Events;

        let index = 0;

        const createMockEvent = () => {
            const _index = index++;
            return {
                id: _index.toString(),
                chainId,
                name: 'name',
                blockNumber: _index,
                blockHash: 'blockHash',
                txHash: 'txHash',
                transactionIndex: _index,
                logIndex: _index,
                address: 'address',
                data: {},
            };
        };

        before(async function () {
            sequelize = new Sequelize(db, { logging: false });

            await sequelize.authenticate();

            await EventIndex.initialize(sequelize);

            await EventIndex.sync();

            events = new Events(sequelize, chainId, maxSizeForSingleTable);
        });

        after(async function () {
            await events.dropAllSubtables();

            await EventIndex.drop();

            await sequelize.close();
        });

        it('should init succeed', async function () {
            await events.init();

            expect(events.indexSize).be.eq(0);
            expect(events.instanceSize).be.eq(0);
        });

        it('should create succeed', async function () {
            await events.create(createMockEvent());

            expect(events.indexSize).be.eq(1);
            expect(events.instanceSize).be.eq(1);
        });

        it('should create multi instance succeed', async function () {
            const transaction = await sequelize.transaction();

            for (let i = 0; i < 33; i++) {
                await events.create(createMockEvent(), { transaction });
            }

            await transaction.commit();

            expect(events.indexSize).be.eq(4);
            expect(events.instanceSize).be.eq(34);
        });

        it('should find one succeed', async function () {
            const event = await events.findOne({ where: { blockNumber: 11 } });

            expect(event).not.eq(null);
            expect(event!.blockNumber).be.eq(11);
        });

        it('should find all succeed', async function () {
            const from = 14;
            const to = 33;
            const limit = 3;

            const results: Event[] = [];

            for await (const _results of events.findAll(
                {
                    where: {
                        blockNumber: {
                            [Op.and]: [
                                {
                                    [Op.gte]: from,
                                },
                                {
                                    [Op.lte]: to,
                                },
                            ],
                        },
                    },
                    order: [['blockNumber', 'ASC']],
                    limit,
                },
                from,
                to,
            )) {
                expect(_results.length).be.lte(limit);

                results.push(..._results);
            }

            expect(results.length).be.eq(to - from + 1);
        });

        it('should find all with specified condition succeed', async function () {
            const from = 14;
            const to = 33;
            const limit = 3;

            const results: Event[] = [];

            const generator = events.findAll(
                {
                    where: {
                        blockNumber: {
                            [Op.and]: [
                                {
                                    [Op.gte]: from,
                                },
                                {
                                    [Op.lte]: to,
                                },
                            ],
                        },
                    },
                    order: [['blockNumber', 'ASC']],
                    limit,
                },
                from,
                to,
            );

            let result = await generator.next();

            while (!result.done) {
                expect(result.value.length).be.lte(limit);

                results.push(...result.value);

                const latest = result.value[result.value.length - 1];

                result = await generator.next({
                    where: {
                        blockNumber: {
                            [Op.and]: [
                                {
                                    [Op.gt]: latest.blockNumber,
                                },
                                {
                                    [Op.lte]: to,
                                },
                            ],
                        },
                    },
                    order: [['blockNumber', 'ASC']],
                    offset: 0,
                });
            }

            expect(results.length).be.eq(to - from + 1);
        });

        it('should destroy one succeed', async function () {
            expect(await events.destroyOne({ where: { blockNumber: 17 } }));
            expect(events.indexSize).be.eq(4);
            expect(events.instanceSize).be.eq(33);
        });
    }
});
