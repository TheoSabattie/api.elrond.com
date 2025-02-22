import { Injectable, Logger } from "@nestjs/common";
import { ApiConfigService } from "../api-config/api.config.service";
const { promisify } = require('util');
import { createClient } from 'redis';
import asyncPool from 'tiny-async-pool';
import { PerformanceProfiler } from "../../utils/performance.profiler";
import { BinaryUtils } from "src/utils/binary.utils";
import { ShardTransaction } from "@elrondnetwork/transaction-processor";
import { LocalCacheService } from "./local.cache.service";

@Injectable()
export class CachingService {
  private client = createClient(6379, this.configService.getRedisUrl());
  private asyncSet = promisify(this.client.set).bind(this.client);
  private asyncGet = promisify(this.client.get).bind(this.client);
  private asyncFlushDb = promisify(this.client.flushdb).bind(this.client);
  private asyncMGet = promisify(this.client.mget).bind(this.client);
  private asyncMulti = (commands: any[]) => {
    const multi = this.client.multi(commands);
    return promisify(multi.exec).call(multi);
  };

  private asyncDel = promisify(this.client.del).bind(this.client);
  private asyncKeys = promisify(this.client.keys).bind(this.client);

  private readonly logger: Logger

  constructor(
    private readonly configService: ApiConfigService,
    private readonly localCacheService: LocalCacheService,
  ) {
    this.logger = new Logger(CachingService.name);
  }

  public async getKeys(key: string | undefined) {
    if (key) {
      return await this.asyncKeys(key);
    }
  }

  public async setCacheRemote<T>(key: string, value: T, ttl: number = this.configService.getCacheTtl()): Promise<T> {
    await this.asyncSet(key, JSON.stringify(value), 'EX', ttl ?? this.configService.getCacheTtl());
    return value;
  };

  pendingPromises: { [key: string]: Promise<any> } = {};

  private async executeWithPendingPromise<T>(key: string, promise: () => Promise<T>): Promise<T> {
    let pendingGetRemote = this.pendingPromises[key];
    if (pendingGetRemote) {
      return await pendingGetRemote;
    } else {
      try {
        pendingGetRemote = promise();
  
        this.pendingPromises[key] = pendingGetRemote;

        return await pendingGetRemote;
      } finally {
        delete this.pendingPromises[key];
      }
    }
  }

  public async getCacheRemote<T>(key: string): Promise<T | undefined> {
    let response = await this.executeWithPendingPromise<string | undefined>(`caching:get:${key}`, async () => await this.asyncGet(key));
    if (response === undefined) {
      return undefined;
    }

    return JSON.parse(response);
  };

  async setCacheLocal<T>(key: string, value: T, ttl: number = this.configService.getCacheTtl()): Promise<T> {
    return await this.localCacheService.setCacheValue<T>(key, value, ttl);
  }

  async getCacheLocal<T>(key: string): Promise<T | undefined> {
    return await this.localCacheService.getCacheValue<T>(key);
  }

  async refreshCacheLocal<T>(key: string, ttl: number = this.configService.getCacheTtl()): Promise<T | undefined> {
    let value = await this.getCacheRemote<T>(key);
    if (value) {
      await this.setCacheLocal<T>(key, value, ttl);
    } else {
      this.logger.log(`Deleting local cache key '${key}'`);
      await this.deleteInCacheLocal(key);
    }

    return value;
  }

  public async getCache<T>(key: string): Promise<T | undefined> {
    let value = await this.getCacheLocal<T>(key);
    if (value) {
      return value;
    }

    return await this.getCacheRemote<T>(key);
  }

  public async setCache<T>(key: string, value: T, ttl: number = this.configService.getCacheTtl()): Promise<T> {
    await this.setCacheLocal<T>(key, value, ttl);
    await this.setCacheRemote<T>(key, value, ttl);
    return value;
  }

  async batchProcess<IN, OUT>(payload: IN[], cacheKeyFunction: (element: IN) => string, handler: (generator: IN) => Promise<OUT>, ttl: number = this.configService.getCacheTtl(), skipCache: boolean = false): Promise<OUT[]> {
    let result: OUT[] = [];

    let chunks = this.getChunks(payload, 100);

    for (let [_, chunk] of chunks.entries()) {
      // this.logger.log(`Loading ${index + 1} / ${chunks.length} chunks`);

      let retries = 0;
      while (true) {
        try {
          let processedChunk = await this.batchProcessChunk(chunk, cacheKeyFunction, handler, ttl, skipCache);
          result.push(...processedChunk);
          break;
        } catch (error) {
          this.logger.error(error);
          this.logger.log(`Retries: ${retries}`);
          retries++;
          if (retries >= 3) {
            throw error;
          }
        }
      }
    }

    return result;
  }

  async batchProcessChunk<IN, OUT>(payload: IN[], cacheKeyFunction: (element: IN) => string, handler: (generator: IN) => Promise<OUT>, ttl: number = this.configService.getCacheTtl(), skipCache: boolean = false): Promise<OUT[]> {
    const keys = payload.map(element => cacheKeyFunction(element));

    let cached: OUT[] = [];
    if (skipCache) {
      cached = new Array(keys.length).fill(null);
    } else {
      cached = await this.batchGetCache(keys);
    }
  
    const missing = cached
      .map((element, index) => (element === null ? index : false))
      .filter((element) => element !== false)
      .map(element => element as number);

    let values: OUT[] = [];
  
    if (missing.length) {
      values = await asyncPool(
        this.configService.getPoolLimit(),
        missing.map((index) => payload[index]),
        handler
      );

      const params = {
        keys: keys.filter((_, index) => missing.includes(index)),
        values,
        ttls: values.map((value) => (value ? ttl : Math.min(ttl, this.configService.getProcessTtl()))),
      };
  
      await this.batchSetCache(params.keys, params.values, params.ttls);
    }

    return keys.map((_, index) =>
      missing.includes(index) ? values[missing.indexOf(index)] : cached[index]
    );
  }

  private spreadTtl(ttl: number): number {
    const threshold = 300; // seconds after which to start spreading ttls
    const spread = 10; // percent ttls spread
  
    if (ttl >= threshold) {
      const sign = Math.round(Math.random()) * 2 - 1;
      const amount = Math.floor(Math.random() * ((ttl * spread) / 100));
  
      ttl = ttl + sign * amount;
    }
  
    return ttl;
  };

  async batchSetCache(keys: string[], values: any[], ttls: number[]) {
    if (!ttls) {
      ttls = new Array(keys.length).fill(this.configService.getCacheTtl());
    }

    ttls = ttls.map(ttl => this.spreadTtl(ttl));

    for (let [index, key] of keys.entries()) {
      let value = values[index];
      let ttl = ttls[index];

      this.setCacheLocal(key, value, ttl);
    }

  
    const chunks = this.getChunks(
      keys.map((key, index) => {
        const element: any = {};
        element[key] = index;
        return element;
      }, 25)
    );
  
    const sets = [];
  
    for (const chunk of chunks) {
      const chunkKeys = chunk.map((element: any) => Object.keys(element)[0]);
      const chunkValues = chunk.map((element: any) => values[Object.values(element)[0] as number]);
  
      sets.push(
        ...chunkKeys.map((key: string, index: number) => {
          return ['set', key, JSON.stringify(chunkValues[index]), 'ex', ttls[index]];
        })
      );
    }
  
    await this.asyncMulti(sets);
  };

  async batchDelCache(keys: string[]) {
    for (let key of keys) {
      this.deleteInCacheLocal(key);
    }

    const dels = keys.map(key => ['del', key]);

    await this.asyncMulti(dels);
  }

  private getChunks<T>(array: T[], size = 25): T[][] {
    return array.reduce((result: T[][], item, current) => {
      const index = Math.floor(current / size);
  
      if (!result[index]) {
        result[index] = [];
      }
  
      result[index].push(item);
  
      return result;
    }, []);
  };
  
  async batchGetCache<T>(keys: string[]): Promise<T[]> {
    const chunks = this.getChunks(keys, 100);
  
    const result = [];
  
    for (const chunkKeys of chunks) {
      let chunkValues = await this.asyncMGet(chunkKeys);
  
      chunkValues = chunkValues.map((value: any) => (value ? JSON.parse(value) : null));
  
      result.push(...chunkValues);
    }
  
    return result;
  };

  async getOrSetCache<T>(key: string, promise: () => Promise<T>, remoteTtl: number = this.configService.getCacheTtl(), localTtl: number | undefined = undefined): Promise<T> {
    if (!localTtl) {
      localTtl = remoteTtl / 2;
    }

    let profiler = new PerformanceProfiler(`vmQuery:${key}`);

    let cachedValue = await this.getCacheLocal<T>(key);
    if (cachedValue !== undefined) {
      profiler.stop(`Local Cache hit for key ${key}`);
      return cachedValue;
    }

    let cached = await this.getCacheRemote<T>(key);
    if (cached !== undefined && cached !== null) {
      profiler.stop(`Remote Cache hit for key ${key}`);

      // we only set ttl to half because we don't know what the real ttl of the item is and we want it to work good in most scenarios
      await this.setCacheLocal<T>(key, cached, localTtl);
      return cached;
    }

    let value = await this.executeWithPendingPromise(`caching:set:${key}`, promise);
    profiler.stop(`Cache miss for key ${key}`);

    if (localTtl > 0) {
      await this.setCacheLocal<T>(key, value, localTtl);
    }

    if (remoteTtl > 0) {
      await this.setCacheRemote<T>(key, value, remoteTtl);
    }
    return value;
  }

  async deleteInCacheLocal(key: string) {
    this.localCacheService.deleteCacheKey(key);
  }

  async deleteInCache(key: string): Promise<string[]> {
    let invalidatedKeys = [];

    if (key.includes('*')) {
      let allKeys = await this.asyncKeys(key);
      for (let key of allKeys) {
        this.localCacheService.deleteCacheKey(key);
        await this.asyncDel(key);
        invalidatedKeys.push(key);
      }
    } else {
      this.localCacheService.deleteCacheKey(key);
      await this.asyncDel(key);
      invalidatedKeys.push(key);
    }

    return invalidatedKeys;
  }

  async tryInvalidateTokenProperties(transaction: ShardTransaction): Promise<string[]> {
    if (transaction.receiver !== this.configService.getEsdtContractAddress()) {
      return [];
    }

    let transactionFuncName = transaction.getDataFunctionName();

    if (transactionFuncName === 'controlChanges') {
      let args = transaction.getDataArgs();
      if (args && args.length > 0) {
        let tokenIdentifier = BinaryUtils.hexToString(args[0]);
        this.logger.log(`Invalidating token properties for token ${tokenIdentifier}`);
        return await this.deleteInCache(`tokenProperties:${tokenIdentifier}`);
      }
    }

    return [];
  }

  async tryInvalidateTokensOnAccount(transaction: ShardTransaction): Promise<string[]> {
    if (transaction.sender !== this.configService.getEsdtContractAddress()) {
      return [];
    }

    return await this.deleteInCache(`tokens:${transaction.receiver}`);
  }

  async tryInvalidateTokenBalance(transaction: ShardTransaction): Promise<string[]> {
    let transactionFuncName = transaction.getDataFunctionName();
    if (transactionFuncName === 'ESDTTransfer') {
      let invalidatedKeys = [];
      let invalidated = await this.deleteInCache(`tokens:${transaction.sender}`);
      invalidatedKeys.push(...invalidated);

      invalidated = await this.deleteInCache(`tokens:${transaction.receiver}`);
      invalidatedKeys.push(...invalidated);
    }

    return [];
  }

  async flushDb(): Promise<any> {
    await this.asyncFlushDb();
  }
}