import type { ModelStatic, Sequelize } from 'sequelize';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ModelCtor = ModelStatic<any> & {
    initialize(sequelize: Sequelize): void;
};
