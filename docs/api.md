# Snapshot API

All interfaces use [json rpc](https://www.jsonrpc.org/) transmission and websocket

# Error Code

| code   | description                                                                                    |
| :----- | :--------------------------------------------------------------------------------------------- |
| -32600 | JSONRPC default error code,</br>invalid request                                                |
| -32601 | JSONRPC default error code,</br>not found                                                      |
| 100    | Snapshot is reorging, please wait                                                              |
| 101    | Snapshot is not available</br>Usually it's because there was an error when processing the logs |
| 102    | Snapshot is generating                                                                         |

# Enum

## AMM Status

|     | description |
| :-- | :---------- |
| 0   | Dormant     |
| 1   | Trading     |
| 2   | Settling    |
| 3   | Settled     |

# API

-   [Generate snapshot](./api.md#gernerate-snapshot)
-   [Clear snapshot](./api.md#clear-snapshot)
-   [List snapshots](./api.md#list-snapshots)
-   [Query account](./api.md#query-account)
-   [Query AMM](./api.md#query-amm)

## Gernerate Snapshot

Generate a snapshot at a specified block number

### Request

method: `generateSnapshot`

params:

| name                    | required | description                                                                   |
| :---------------------- | :------- | :---------------------------------------------------------------------------- |
| params.blockNumber      | ✅       | Block number                                                                  |
| params.transactionIndex | ⭕       | Transaction index</br>default: The last transaction index of the target block |
| params.logIndex         | ⭕       | Log index</br>default: The last log index of the target block                 |

example:

```jsonc
{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "generateSnapshot",
    "params": {
        "blockNumber": 2737538,
        "transactionIndex": 10,
        "logIndex": 23
    }
}
```

### Response

params:

| name   | description |
| :----- | :---------- |
| result | Snapshot ID |

example:

```jsonc
{
    "id": 1,
    "result": "81457-2737538-10-23"
}
```

## Clear Snapshot

Clear snapshot by id and release memory

### Request

method: `clearSnapshot`

params:

| name   | required | description |
| :----- | :------- | :---------- |
| params | ✅       | Snapshot ID |

example:

```jsonc
{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "clearSnapshot",
    "params": "81457-2737538-10-23"
}
```

### Response

example:

```jsonc
{
    "id": 1,
    "result": true
}
```

## List Snapshots

List all snapshots in memory and the block number corresponding to the snapshot

### Request

method: `listSnapshots`

example:

```jsonc
{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "listSnapshots",
    "params": {}
}
```

### Response

params:

| name   | description                                                               |
| :----- | :------------------------------------------------------------------------ |
| result | The key is the snapshot ID</br>and the value is the poisition information |

example:

```jsonc
{
    "id": 1,
    "result": {
        "81457-2737538-10-23": {
            "chainId": 81457,
            "blockNumber": 2737538,
            "transactionIndex": 10,
            "logIndex": 23
        },
        "81457-2637538-10-11": {
            "chainId": 81457,
            "blockNumber": 2637538,
            "transactionIndex": 10,
            "logIndex": 11
        }
    }
}
```

## Query Account

Query the account status in the snapshot

### Request

method: `queryAccount`

params:

| name              | required | description                              |
| :---------------- | :------- | :--------------------------------------- |
| params.id         | ⭕       | Snapshot ID</br>default: Latest snapshot |
| params.address    | ✅       | Account address                          |
| params.instrument | ✅       | Instrument address                       |
| params.expiry     | ✅       | Expiry                                   |

example:

```jsonc
{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "queryAccount",
    "params": {
        "address": "0xe4ac554ecc217745de278ac3fe0f633b2674a368",
        "instrument": "0x145d52ad11afb3c2201dca5d34977f1f9ee26644",
        "expiry": 4294967295
    }
}
```

### Response

param:

| name                                 | description                                                                                              |
| :----------------------------------- | :------------------------------------------------------------------------------------------------------- |
| result.oids                          | Order id list                                                                                            |
| result.rids                          | Range id list                                                                                            |
| result.onumber                       | Length of order id list                                                                                  |
| result.rnumber                       | Length of range id list                                                                                  |
| result.position                      | User position information                                                                                |
| result.position.balance              | User position margin(in quote)                                                                           |
| result.position.size                 | User position size(in base)</br>Positive numbers represent long,</br>negative numbers represent short    |
| result.position.entrySocialLossIndex | Index number used to calculate social loss                                                               |
| result.position.entryFundingIndex    | Index number used to calculate funding fee                                                               |
| result.orders                        | User orders information</br>The key is order id</br>and the value is the order information               |
| result.orders.`xxx`.balance          | User limit order margin(in quote)                                                                        |
| result.orders.`xxx`.size             | User limit order size(in base)</br>Positive numbers represent long,</br>negative numbers represent short |
| result.ranges                        | User ranges information</br>The key is range id</br>and the value is the range information               |
| result.ranges.`xxx`.liquidity        | Liquidity, `sqrt(x * y)`                                                                                 |
| result.ranges.`xxx`.balance          | Balance(in quote)                                                                                        |
| result.ranges.`xxx`.sqrtEntryPX96    | Entry price                                                                                              |
| result.ranges.`xxx`.entryFeeIndex    | Index number used to calculate fee                                                                       |

example:

```jsonc
{
    "id": 1,
    "result": {
        "onumber": 2,
        "rnumber": 1,
        "oids": [1, 2],
        "rids": [3, 4],
        "position": {
            "balance": "3945720347",
            "size": "6093475092",
            "entryNotional": "68943853",
            "entrySocialLossIndex": "49549564624163",
            "entryFundingIndex": "7082374827"
        },
        "orders": {
            "1": {
                "balance": "97845763763",
                "size": "5463780703492"
            },
            "2": {
                "balance": "97845763763",
                "size": "5463780703492"
            }
        },
        "ranges": {
            "3": {
                "liquidity": "4827385723857",
                "entryFeeIndex": "6394756094375",
                "balance": "7958490680",
                "sqrtEntryPX96": "5683094586039"
            },
            "4": {
                "liquidity": "4827385723857",
                "entryFeeIndex": "6394756094375",
                "balance": "7958490680",
                "sqrtEntryPX96": "5683094586039"
            }
        }
    }
}
```

## Query AMM

Query the AMM status in the snapshot

### Request

method: `queryAMM`

params:

| name              | required | description                              |
| :---------------- | :------- | :--------------------------------------- |
| params.id         | ⭕       | Snapshot ID</br>default: Latest snapshot |
| params.instrument | ✅       | Instrument address                       |
| params.expiry     | ✅       | Expiry                                   |

example:

```jsonc
{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "queryAMM",
    "params": {
        "instrument": "0x145d52ad11afb3c2201dca5d34977f1f9ee26644",
        "expiry": 4294967295
    }
}
```

### Response

params:

| name                        | description                                                                                       |
| :-------------------------- | :------------------------------------------------------------------------------------------------ |
| result.timestamp            | AMM last updated timestamp                                                                        |
| result.status               | [AMM Status](./api.md#amm-status)                                                                 |
| result.tick                 | AMM current tick                                                                                  |
| result.sqrtPX96             | AMM current price                                                                                 |
| result.liquidity            | AMM current liquidity                                                                             |
| result.totalLiquidity       | AMM total liquidity                                                                               |
| result.involvedFund         | AMM involved fund                                                                                 |
| result.openInterests        | AMM OI(in base)                                                                                   |
| result.feeIndex             | Index number of fee                                                                               |
| result.protocolFee          | AMM protocl fee(in quote)                                                                         |
| result.totalLong            | Total long position(in base)                                                                      |
| result.totalShort           | Total short position(in base)                                                                     |
| result.longSocialLossIndex  | Index number of long social loss                                                                  |
| result.shortSocialLossIndex | Index number of short social loss                                                                 |
| result.longFundingIndex     | Index number of long funding fee                                                                  |
| result.shortFundingIndex    | Index number of short funding fee                                                                 |
| result.insuranceFund        | AMM insurance fund(in quote)                                                                      |
| result.settlementPrice      | Settlement price for dated pair,</br>for perpetual trading pairs, settlement price is always zero |

example:

```jsonc
{
    "id": 1,
    "result": {
        "timestamp": 1713426448,
        "status": 1,
        "tick": 15777,
        "sqrtPX96": "45646456",
        "liquidity": "5465465465",
        "totalLiquidity": "85623746518",
        "involvedFund": "894231321",
        "openInterests": "5741231321",
        "feeIndex": "57654634123",
        "protocolFee": "48412616216",
        "totalLong": "48412616216",
        "totalShort": "48412616216",
        "longSocialLossIndex": "48412616216",
        "shortSocialLossIndex": "48412616216",
        "longFundingIndex": "48412616216",
        "shortFundingIndex": "48412616216",
        "insuranceFund": "48412616216",
        "settlementPrice": "48412616216"
    }
}
```
