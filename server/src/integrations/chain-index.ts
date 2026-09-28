import type { IndexSource, Block, ChainLog } from '../operations/indexer';
import type { ReadRpcPool } from './rpc';
const number = (v: string) => { const n = BigInt(v); if (n < 0n || n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('RPC_NUMBER_OUT_OF_RANGE'); return Number(n); };
export function rpcIndexSource(rpc: ReadRpcPool): IndexSource {
  return {
    async block(tag): Promise<Block> {
      const value = await rpc.request<{ number: string; hash: string; parentHash: string; timestamp: string }>('eth_getBlockByNumber', [typeof tag === 'number' ? `0x${tag.toString(16)}` : tag, false]);
      if (!value || !/^0x[\da-f]{64}$/i.test(value.hash) || !/^0x[\da-f]{64}$/i.test(value.parentHash)) throw new Error('RPC_BLOCK_INVALID');
      return { number: number(value.number), hash: value.hash.toLowerCase(), parentHash: value.parentHash.toLowerCase(), timestamp: number(value.timestamp) };
    },
    async logs(from,to,addresses): Promise<ChainLog[]> {
      const rows = await rpc.request<{ blockNumber:string;blockHash:string;transactionHash:string;logIndex:string;address:string;topics:string[];data:string;removed:boolean }[]>('eth_getLogs', [{ fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`, address: addresses }]);
      if (!Array.isArray(rows) || rows.some(r => r.removed)) throw new Error('RPC_LOGS_INVALID');
      return rows.map(r => ({ blockNumber:number(r.blockNumber), blockHash:r.blockHash.toLowerCase(), transactionHash:r.transactionHash.toLowerCase(), logIndex:number(r.logIndex), address:r.address.toLowerCase(), topics:r.topics, data:r.data }));
    }
  };
}
