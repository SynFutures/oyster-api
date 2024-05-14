/* eslint-disable @typescript-eslint/no-explicit-any */
import { FindOptions, CreateOptions, WhereOptions, Attributes, Sequelize, Op } from 'sequelize';
import { EventIndex, Event, defineEvent } from './model';

export type EventStructure = Readonly<{
    id: string;
    chainId: number;
    name: string;
    blockNumber: number;
    blockHash: string;
    txHash: string;
    transactionIndex: number;
    logIndex: number;
    address: string;
    data: object;
}>;

export type EventPosition = {
    blockNumber: number;
    transactionIndex: number;
    logIndex: number;
};

function concatModelName(chainId: number, index: number) {
    return `events_${chainId}_${index}`;
}

/**
 * Manage Event sub-table
 */
export class Events {
    private initializing?: Promise<void>;

    private models = new Map<string, typeof Event>();
    private indexes: EventIndex[] = [];

    /**
     * Get index size
     */
    get indexSize() {
        return this.indexes.length;
    }

    /**
     * Get instance size
     */
    get instanceSize() {
        return this.indexes.reduce((p, c) => p + c.size, 0);
    }

    /**
     * Get latest block number
     */
    get latestBlockNumber() {
        return this.indexes.length > 0 ? this.indexes[this.indexes.length - 1].blockNumber : 0;
    }

    constructor(private sequelize: Sequelize, private chainId: number, private maxSizeForSingleTable = 1000000) {}

    // sync model by index
    private async syncModel(indexOfEventIndex: number) {
        const name = concatModelName(this.chainId, indexOfEventIndex);

        let model = this.models.get(name);

        if (!model) {
            model = defineEvent(this.sequelize, name);

            // create table if not exists
            await model.sync();

            this.models.set(name, model);
        }
    }

    // get model instance by event index
    private getModel(index: EventIndex) {
        const name = concatModelName(this.chainId, index.index);

        const model = this.models.get(name);

        if (!model) {
            throw new Error('unknown model');
        }

        return model;
    }

    /**
     * Get all table names
     */
    get tables() {
        return Array.from(this.models.keys());
    }

    /**
     * Initialize.
     */
    init() {
        if (this.initializing) {
            return this.initializing;
        }

        return (this.initializing = (async () => {
            // load indexes to memory
            this.indexes = await EventIndex.findAll({ where: { chainId: this.chainId }, order: [['id', 'ASC']] });

            // sync existed event table
            for (const index of this.indexes) {
                await this.syncModel(index.index);
            }

            // sync up to 30 sub tables
            for (
                let index = this.indexes.length > 0 ? this.indexes[this.indexes.length - 1].index : 0;
                index <= 29;
                index++
            ) {
                await this.syncModel(index);
            }
        })());
    }

    /**
     * Search for multiple instances from multiple sub-tables.
     * @param condition {@link FindAllOptions}
     * @param explicitFrom Explicitly specified from block number
     * @param explicitTo Explicitly specified to block number
     */
    async *findAll(
        condition: Omit<FindOptions<Attributes<Event>>, 'offset'>,
        explicitFrom?: number,
        explicitTo?: number,
    ): AsyncGenerator<Event[], void, Omit<FindOptions<Attributes<Event>>, 'limit'> | undefined> {
        const blockNumber = (condition as any)?.where?.blockNumber;

        const from = blockNumber?.[Op.gt] ?? blockNumber?.[Op.gte] ?? explicitFrom ?? 0;
        const to = blockNumber?.[Op.lt] ?? blockNumber?.[Op.lte] ?? explicitTo ?? Infinity;
        const limit = condition.limit;

        let previous = -1;

        for (const index of this.indexes) {
            if ((from <= index.blockNumber && index.blockNumber <= to) || (previous < to && to <= index.blockNumber)) {
                const model = this.getModel(index);

                let offset = limit ? 0 : undefined;

                let events = await model.findAll({
                    ...condition,
                    offset,
                    limit,
                });

                while (limit && limit > 0 && events.length === limit) {
                    const _condition = yield events;

                    (offset as number) += limit;

                    events = await model.findAll({
                        offset,
                        limit,
                        ...(_condition ?? condition),
                    });
                }

                if (events.length > 0) {
                    yield events;
                }
            }

            previous = index.blockNumber;
        }
    }

    /**
     * Search for multiple instances from multiple sub-tables.
     * Order by blockNumber, transactionIndex, logIndex ASC.
     * Left open and right closed.
     * @param from From position
     * @param to To position
     * @param limit Limit size
     */
    async *findAllOrderByBTLASC(
        from: number | EventPosition,
        to?: number | EventPosition,
        additional?: WhereOptions<Attributes<Event>>,
        limit = 1000,
    ): AsyncGenerator<Event[], void, void> {
        let fromBlockNumber: number;
        let fromCondition: any;
        if (typeof from === 'number') {
            fromBlockNumber = from;
            fromCondition = {
                blockNumber: {
                    [Op.gt]: from,
                },
            };
        } else {
            fromBlockNumber = from.blockNumber;
            fromCondition = {
                [Op.or]: [
                    {
                        blockNumber: {
                            [Op.gt]: from.blockNumber,
                        },
                    },
                    {
                        blockNumber: from.blockNumber,
                        transactionIndex: {
                            [Op.gt]: from.transactionIndex,
                        },
                    },
                    {
                        blockNumber: from.blockNumber,
                        transactionIndex: from.transactionIndex,
                        logIndex: {
                            [Op.gt]: from.logIndex,
                        },
                    },
                ],
            };
        }

        // to condition
        let toBlockNumber: number = this.latestBlockNumber;
        let toCondition: any = undefined;
        if (to !== undefined) {
            if (typeof to === 'number') {
                toBlockNumber = to;
                toCondition = {
                    blockNumber: {
                        [Op.lte]: to,
                    },
                };
            } else {
                toBlockNumber = to.blockNumber;
                toCondition = {
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
                };
            }
        }

        if (fromBlockNumber > toBlockNumber) {
            throw new Error('invalid block number');
        }

        const generator = this.findAll(
            {
                where: {
                    chainId: this.chainId,
                    [Op.and]: [fromCondition, toCondition],
                    ...additional,
                },
                order: [
                    ['blockNumber', 'ASC'],
                    ['transactionIndex', 'ASC'],
                    ['logIndex', 'ASC'],
                ],
                limit,
            },
            fromBlockNumber,
            toBlockNumber,
        );

        let result = await generator.next();

        while (!result.done) {
            const latestEvent = result.value[result.value.length - 1];

            yield result.value;

            result = await generator.next({
                where: {
                    chainId: this.chainId,
                    [Op.and]: [
                        {
                            [Op.or]: [
                                {
                                    blockNumber: {
                                        [Op.gt]: latestEvent.blockNumber,
                                    },
                                },
                                {
                                    blockNumber: latestEvent.blockNumber,
                                    transactionIndex: {
                                        [Op.gt]: latestEvent.transactionIndex,
                                    },
                                },
                                {
                                    blockNumber: latestEvent.blockNumber,
                                    transactionIndex: latestEvent.transactionIndex,
                                    logIndex: {
                                        [Op.gt]: latestEvent.logIndex,
                                    },
                                },
                            ],
                        },
                        toCondition,
                    ],
                    ...additional,
                },
                order: [
                    ['blockNumber', 'ASC'],
                    ['transactionIndex', 'ASC'],
                    ['logIndex', 'ASC'],
                ],
                offset: 0,
            });
        }
    }

    /**
     * Search for a single instance.
     * @param condition {@link FindOptions}
     * @param explicitBlockNumber Explicitly specified block number
     * @returns Instance or null
     */
    async findOne(condition: FindOptions<Attributes<Event>>, explicitBlockNumber?: number): Promise<Event | null> {
        const blockNumber: number | undefined = (condition as any)?.where?.blockNumber ?? explicitBlockNumber;

        let previous = -1;

        for (const index of this.indexes) {
            if (blockNumber === undefined || (previous < blockNumber && blockNumber <= index.blockNumber)) {
                const model = this.getModel(index);

                const result = await model.findOne(condition);

                if (result) {
                    return result;
                }
            }

            previous = index.blockNumber;
        }

        return null;
    }

    private async insert(event: EventStructure, index: EventIndex, options?: CreateOptions<Attributes<Event>>) {
        const model = this.getModel(index);

        // update max block number
        index.blockNumber = Math.max(index.blockNumber, event.blockNumber);
        // increase size
        index.size++;
        // save index
        await index.save(options);

        return await model.create(event, options);
    }

    /**
     * Builds a new model instance.
     * NOTE: This function must be called serially.
     * @param event {@link EventStructure}
     * @param options {@link CreateOptions}
     * @returns New model instance
     */
    async create(event: EventStructure, options?: CreateOptions<Attributes<Event>>) {
        if (this.indexes.length > 0) {
            let previous = -1;

            for (const index of this.indexes) {
                if (previous < event.blockNumber && event.blockNumber <= index.blockNumber) {
                    // create instance in existed table and return
                    return await this.insert(event, index, options);
                }

                previous = index.blockNumber;
            }

            const latestIndex = this.indexes[this.indexes.length - 1];
            if (latestIndex.size < this.maxSizeForSingleTable) {
                // create instance in latest table and return
                return await this.insert(event, latestIndex, options);
            }
        }

        const newIndex = await EventIndex.create(
            {
                chainId: event.chainId,
                blockNumber: event.blockNumber,
                index: this.indexes.length,
                size: 1,
            },
            options,
        );

        // push to memory
        this.indexes.push(newIndex);

        const model = this.getModel(newIndex);

        // create instance in new table and return
        return await model.create(event, options);
    }

    /**
     * Destroy one instance
     * NOTE: This function must be called serially.
     * @param condition {@link FindOptions}
     * @param explicitBlockNumber Explicitly specified block height
     * @returns Destroyed instance count
     */
    async destroyOne(condition: FindOptions<Attributes<Event>> & { where: { blockNumber: number } }): Promise<number>;
    async destroyOne(condition: FindOptions<Attributes<Event>>, explicitBlockNumber: number): Promise<number>;
    async destroyOne(condition: FindOptions<Attributes<Event>>, explicitBlockNumber?: number): Promise<number> {
        const blockNumber = (condition as any)?.where?.blockNumber ?? explicitBlockNumber;

        if (typeof blockNumber !== 'number') {
            throw new Error('missing block number');
        }

        let previous = -1;

        for (const index of this.indexes) {
            if (previous < blockNumber && blockNumber <= index.blockNumber) {
                const model = this.getModel(index);

                const destroyed = await model.destroy(condition);

                if (destroyed > 0) {
                    index.size -= destroyed;

                    await index.save({ transaction: condition.transaction });
                }

                return destroyed;
            }

            previous = index.blockNumber;
        }

        return 0;
    }

    /**
     * Drop all sub-tables
     */
    async dropAllSubtables() {
        for (const model of this.models.values()) {
            await model.drop();
        }
    }

    // TODO: bulk create and bulk destroy
}
