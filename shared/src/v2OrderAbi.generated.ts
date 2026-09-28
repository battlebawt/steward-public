// Generated from reviewed Foundry artifact. Do not hand-edit.
export const V2_COW_ORDER_ABI = [
  {
    "type": "function",
    "name": "budgetStatus",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "period",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "reservedToken",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "reservedPeriod",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "spentPeriod",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "cancelOrder",
    "inputs": [
      {
        "name": "digest",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "openOrder",
    "inputs": [
      {
        "name": "o",
        "type": "tuple",
        "internalType": "struct StewardCowV2Module.CowOrder",
        "components": [
          {
            "name": "sellToken",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "buyToken",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "receiver",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "sellAmount",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "buyAmount",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "validTo",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "appData",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "feeAmount",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "kind",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "partiallyFillable",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "sellTokenBalance",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "buyTokenBalance",
            "type": "bytes32",
            "internalType": "bytes32"
          }
        ]
      },
      {
        "name": "a",
        "type": "tuple",
        "internalType": "struct StewardAccountV1.Action",
        "components": [
          {
            "name": "actionId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "kind",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "account",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "actor",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "chainId",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "securityEpoch",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "policyVersion",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "nonce",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "tokenIn",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "tokenOut",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "recipient",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "amountInRaw",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "minAmountOutRaw",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "adapter",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "routeHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "validAfter",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "deadline",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "exceptionMask",
            "type": "uint256",
            "internalType": "uint256"
          }
        ]
      },
      {
        "name": "approvals",
        "type": "bytes[]",
        "internalType": "bytes[]"
      }
    ],
    "outputs": [
      {
        "name": "digest",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "orderDigest",
    "inputs": [
      {
        "name": "o",
        "type": "tuple",
        "internalType": "struct StewardCowV2Module.CowOrder",
        "components": [
          {
            "name": "sellToken",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "buyToken",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "receiver",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "sellAmount",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "buyAmount",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "validTo",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "appData",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "feeAmount",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "kind",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "partiallyFillable",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "sellTokenBalance",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "buyTokenBalance",
            "type": "bytes32",
            "internalType": "bytes32"
          }
        ]
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "orderUid",
    "inputs": [
      {
        "name": "digest",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "validTo",
        "type": "uint32",
        "internalType": "uint32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "pendingOrder",
    "inputs": [
      {
        "name": "digest",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct StewardCowV2Storage.Pending",
        "components": [
          {
            "name": "actor",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "sellToken",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "buyToken",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "sellAmount",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "buyAmount",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "grossSell",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "periodStart",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "policyVersion",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "securityEpoch",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "validTo",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "isBuy",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "exception",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "state",
            "type": "uint8",
            "internalType": "uint8"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "reconcile",
    "inputs": [
      {
        "name": "digest",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "event",
    "name": "OrderClosed",
    "inputs": [
      {
        "name": "digest",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "state",
        "type": "uint8",
        "indexed": false,
        "internalType": "uint8"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "OrderOpened",
    "inputs": [
      {
        "name": "digest",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "actor",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "grossSell",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "validTo",
        "type": "uint32",
        "indexed": false,
        "internalType": "uint32"
      }
    ],
    "anonymous": false
  }
] as const;
