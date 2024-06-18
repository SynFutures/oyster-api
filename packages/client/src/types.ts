export interface QueryAccountRequest {
    address: string;
    instrument: string;
    expiry: number;
}

export interface QueryAccountResponse {
    position: {
        balance: string;
        size: string;
        entryNotional: string;
        entrySocialLossIndex: string;
        entryFundingIndex: string;
    };
    orders: {
        [oid: string]: {
            balance: string;
            size: string;
        };
    };
    ranges: {
        [rid: string]: {
            liquidity: string;
            entryFeeIndex: string;
            balance: string;
            sqrtEntryPX96: string;
        };
    };
}

export interface SubscribeOrderFilledRequest {
    address: string;
}

export interface UnsubscribeOrderFilledRequest {
    address: string;
}
