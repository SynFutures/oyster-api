import { Model, DataTypes, Sequelize } from 'sequelize';
import type { ModelCtor } from './types';

export declare class Event extends Model {
    id: string;
    chainId: number;
    name: string;
    blockNumber: number;
    timestamp: number | null;
    blockHash: string;
    txHash: string;
    transactionIndex: number;
    logIndex: number;
    address: string;
    data: object;
}

export function defineEvent(sequelize: Sequelize, name: string) {
    return sequelize.define<Event>(
        name,
        {
            id: {
                type: DataTypes.TEXT,
                allowNull: false,
                primaryKey: true,
            },
            chainId: {
                type: DataTypes.INTEGER,
                allowNull: false,
            },
            name: {
                type: DataTypes.TEXT,
                allowNull: false,
            },
            blockNumber: {
                type: DataTypes.INTEGER,
                allowNull: false,
            },
            timestamp: {
                type: DataTypes.INTEGER,
                allowNull: true,
                defaultValue: null,
            },
            blockHash: {
                type: DataTypes.TEXT,
                allowNull: false,
            },
            txHash: {
                type: DataTypes.TEXT,
                allowNull: false,
            },
            transactionIndex: {
                type: DataTypes.INTEGER,
                allowNull: false,
            },
            logIndex: {
                type: DataTypes.INTEGER,
                allowNull: false,
            },
            address: {
                type: DataTypes.TEXT,
                allowNull: false,
            },
            data: {
                type: DataTypes.JSONB,
                allowNull: false,
            },
        },
        {
            tableName: name,
            indexes: [
                {
                    unique: true,
                    fields: ['chainId', 'blockNumber', 'transactionIndex', 'logIndex'],
                    name: `${name}_index`,
                },
            ],
        },
    );
}

export class EventIndex extends Model {
    static initialize(sequelize: Sequelize) {
        EventIndex.init(
            {
                id: {
                    type: DataTypes.INTEGER,
                    primaryKey: true,
                    autoIncrement: true,
                },
                chainId: {
                    type: DataTypes.INTEGER,
                    allowNull: false,
                },
                blockNumber: {
                    type: DataTypes.INTEGER,
                    allowNull: false,
                },
                index: {
                    type: DataTypes.INTEGER,
                    allowNull: false,
                },
                size: {
                    type: DataTypes.INTEGER,
                    allowNull: false,
                },
            },
            { sequelize },
        );
    }

    id: number;
    chainId: number;
    blockNumber: number;
    index: number;
    size: number;
}

export class Instrument extends Model {
    static initialize(sequelize: Sequelize) {
        Instrument.init(
            {
                id: {
                    type: DataTypes.TEXT,
                    allowNull: false,
                    primaryKey: true,
                },
                chainId: {
                    type: DataTypes.INTEGER,
                    allowNull: false,
                },
                address: {
                    type: DataTypes.TEXT,
                    allowNull: false,
                },
                index: {
                    type: DataTypes.TEXT,
                    allowNull: false,
                },
                base: {
                    type: DataTypes.TEXT,
                    allowNull: false,
                },
                quote: {
                    type: DataTypes.TEXT,
                    allowNull: false,
                },
                symbol: {
                    type: DataTypes.TEXT,
                    allowNull: false,
                },
                createBy: {
                    type: DataTypes.TEXT,
                    allowNull: false,
                },
            },
            { sequelize },
        );
    }

    id: string;
    address: string;
    chainId: number;
    index: string;
    base: string;
    quote: string;
    symbol: string;

    // new instrument event id
    createBy: string;
}

export class Snapshot extends Model {
    static initialize(sequelize: Sequelize) {
        Snapshot.init(
            {
                id: {
                    type: DataTypes.INTEGER,
                    primaryKey: true,
                    autoIncrement: true,
                },
                chainId: {
                    type: DataTypes.INTEGER,
                    allowNull: false,
                },
                blockNumber: {
                    type: DataTypes.INTEGER,
                    allowNull: false,
                },
                transactionIndex: {
                    type: DataTypes.INTEGER,
                    allowNull: false,
                },
                logIndex: {
                    type: DataTypes.INTEGER,
                    allowNull: false,
                },
                snapshot: {
                    type: DataTypes.JSON,
                    allowNull: false,
                },
            },
            {
                indexes: [
                    {
                        unique: true,
                        fields: ['chainId', 'blockNumber', 'transactionIndex', 'logIndex'],
                    },
                ],
                sequelize,
            },
        );
    }

    id: number;
    chainId: number;
    blockNumber: number;
    transactionIndex: number;
    logIndex: number;
    snapshot: object;
}

export const models: ModelCtor[] = [EventIndex, Instrument, Snapshot];
