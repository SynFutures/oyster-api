/* eslint-disable @typescript-eslint/no-explicit-any */
import Semaphore from 'semaphore-async-await';
import { Transaction, Sequelize, Model, DataTypes } from 'sequelize';

export type Cache<T extends object> = CacheObject<T> & T;

/**
 * Create a new cache instance
 * @param sequelize Sequelize instance
 * @param chainId Chain id
 * @param name Cache object name
 * @param defaultCache Default cache object
 * @returns Cache object
 */
export async function createCache<T extends object>(
    sequelize: Sequelize,
    chainId: number,
    name: string,
    defaultCache?: T,
): Promise<Cache<T>> {
    const model = await CacheObject.getModel(sequelize);

    const cache = new CacheObject<T>(model, chainId, name);

    await cache.init(defaultCache);

    const proxy = new Proxy(cache, {
        has: (target: any, p) => {
            if (p in target) {
                return true;
            }
            return p in target.object;
        },
        get: (target: any, p) => {
            if (p in target) {
                return target[p];
            }
            return target.object[p];
        },
        set: (target: any, p, newValue) => {
            if (p in target) {
                target[p] = newValue;
            }
            target.object[p] = newValue;
            return true;
        },
        deleteProperty: (target, p) => {
            if (p in target) {
                throw new Error('invalid delete property:' + p.toString());
            }
            return delete target.object[p];
        },
        ownKeys: (target: any) => {
            return [...Reflect.ownKeys(target), ...Reflect.ownKeys(target.object)];
        },
        getOwnPropertyDescriptor() {
            return {
                enumerable: true,
                configurable: true,
            };
        },
    });

    return proxy;
}

/**
 * Destroy cahce for specified chain
 * @param sequelize Sequelize instance
 * @param chainId Chain id
 */
export async function destroyCache(sequelize: Sequelize, chainId: number) {
    const model = await CacheObject.getModel(sequelize);

    await model.destroy({ where: { chainId } });
}

declare class CacheM extends Model {
    name: string;
    chainId: number;
    data: object;
}

/**
 * Simple management cache class
 */
class CacheObject<T extends object> {
    private static models = new Map<Sequelize, typeof CacheM>();
    private static lock = new Semaphore(1);

    // define cache model
    static defineCache(sequelize: Sequelize) {
        return sequelize.define<CacheM>(
            'Caches',
            {
                name: {
                    type: DataTypes.TEXT,
                    allowNull: false,
                },
                chainId: {
                    type: DataTypes.INTEGER,
                    allowNull: false,
                },
                data: {
                    type: DataTypes.JSON,
                    allowNull: false,
                },
            },
            {
                tableName: 'Caches',
                indexes: [{ unique: true, fields: ['chainId', 'name'] }],
            },
        );
    }

    // get model by sequelize instance
    static async getModel(sequelize: Sequelize) {
        let model = CacheObject.models.get(sequelize);

        if (!model) {
            await CacheObject.lock.acquire();

            try {
                model = CacheObject.models.get(sequelize);

                if (!model) {
                    model = CacheObject.defineCache(sequelize);

                    // create table if not exists
                    await model.sync();

                    CacheObject.models.set(sequelize, model);
                }
            } finally {
                CacheObject.lock.release();
            }
        }

        return model;
    }

    private object: T = {} as T;
    private initializing?: Promise<void>;

    constructor(private model: typeof CacheM, private chainId: number, private name: string) {}

    /**
     * Initialize cache
     */
    async init(defaultCache?: T) {
        if (this.initializing) {
            return this.initializing;
        }

        return (this.initializing = (async () => {
            let cache = await this.model.findOne({
                where: {
                    name: this.name,
                    chainId: this.chainId,
                },
            });
            if (cache === null) {
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                cache = await this.model.create({
                    name: this.name,
                    chainId: this.chainId,
                    data: defaultCache ?? {},
                })!;
            }
            this.object = { ...defaultCache, ...cache.data } as T;
        })());
    }

    /**
     * Save cache to database
     */
    async save(transaction?: Transaction) {
        await this.model.update(
            { data: this.object },
            {
                where: {
                    name: this.name,
                    chainId: this.chainId,
                },
                transaction,
            },
        );
    }
}
