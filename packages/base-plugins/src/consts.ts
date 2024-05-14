import { CHAIN_ID } from '@derivation-tech/web3-core';
import { Config__factory, Gate__factory, Instrument__factory } from '@synfutures/oyster-sdk/build/types';

export const gateInterface = Gate__factory.createInterface();

export const instrumentInterface = Instrument__factory.createInterface();

export const configInterface = Config__factory.createInterface();

export const initialBlockNumbers = new Map<CHAIN_ID, number>([[CHAIN_ID.BLAST, 193838]]);
