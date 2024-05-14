import type { LogDescription } from '@ethersproject/abi';

export type ParsedLog<T> = Omit<LogDescription, 'args'> & { args: T };

export type Subscription = {
    address: string;
    topics: (null | string | string[])[];
};
