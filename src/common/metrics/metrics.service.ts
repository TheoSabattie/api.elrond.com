import { forwardRef, Inject, Injectable } from "@nestjs/common";
import { register, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';
import { ApiConfigService } from "src/common/api-config/api.config.service";
import { GatewayComponentRequest } from "../gateway/entities/gateway.component.request";
import { GatewayService } from "../gateway/gateway.service";
import { ProtocolService } from "../protocol/protocol.service";

@Injectable()
export class MetricsService {
  private static apiCallsHistogram: Histogram<string>;
  private static vmQueriesHistogram: Histogram<string>;
  private static pendingRequestsHistogram: Gauge<string>;
  private static externalCallsHistogram: Histogram<string>;
  private static elasticDurationHistogram: Histogram<string>;
  private static gatewayDurationHistogram: Histogram<string>;
  private static elasticTookHistogram: Histogram<string>;
  private static apiResponseSizeHistogram: Histogram<string>;
  private static currentNonceGauge: Gauge<string>;
  private static lastProcessedNonceGauge: Gauge<string>;
  private static pendingApiHitGauge: Gauge<string>;
  private static cachedApiHitGauge: Gauge<string>;
  private static isDefaultMetricsRegistered: boolean = false;

  constructor(
    private readonly apiConfigService: ApiConfigService,
    @Inject(forwardRef(() => GatewayService))
    private readonly gatewayService: GatewayService,
    private readonly protocolService: ProtocolService,
  ) {
    if (!MetricsService.apiCallsHistogram) {
      MetricsService.apiCallsHistogram = new Histogram({
        name: 'api',
        help: 'API Calls',
        labelNames: [ 'endpoint', 'code' ],
        buckets: [ ]
      });
    }

    if (!MetricsService.vmQueriesHistogram) {
      MetricsService.vmQueriesHistogram = new Histogram({
        name: 'vm_query',
        help: 'VM Queries',
        labelNames: [ 'address', 'function' ],
        buckets: [ ]
      });
    }

    if (!MetricsService.pendingRequestsHistogram) {
      MetricsService.pendingRequestsHistogram = new Gauge({
        name: 'pending_requests',
        help: 'Pending requests',
        labelNames: [ 'endpoint' ],
      });
    }

    if (!MetricsService.externalCallsHistogram) {
      MetricsService.externalCallsHistogram = new Histogram({
        name: 'external_apis',
        help: 'External Calls',
        labelNames: [ 'system' ],
        buckets: [ ]
      });
    }

    if (!MetricsService.elasticDurationHistogram) {
      MetricsService.elasticDurationHistogram = new Histogram({
        name: 'elastic_duration',
        help: 'Elastic Duration',
        labelNames: [ 'index' ],
        buckets: [ ]
      });
    }

    if (!MetricsService.gatewayDurationHistogram) {
      MetricsService.gatewayDurationHistogram = new Histogram({
        name: 'gateway_duration',
        help: 'Gateway Duration',
        labelNames: [ 'endpoint' ],
        buckets: [ ]
      });
    }

    if (!MetricsService.elasticTookHistogram) {
      MetricsService.elasticTookHistogram = new Histogram({
        name: 'elastic_took',
        help: 'Elastic Took',
        labelNames: [ 'index' ],
        buckets: [ ]
      });
    }

    if (!MetricsService.apiResponseSizeHistogram) {
      MetricsService.apiResponseSizeHistogram = new Histogram({
        name: 'api_response_size',
        help: 'API Response size',
        labelNames: [ 'endpoint' ],
        buckets: [ ]
      });
    }

    if (!MetricsService.currentNonceGauge) {
      MetricsService.currentNonceGauge = new Gauge({
        name: 'current_nonce',
        help: 'Current nonce of the given shard',
        labelNames: [ 'shardId' ]
      });
    }

    if (!MetricsService.lastProcessedNonceGauge) {
      MetricsService.lastProcessedNonceGauge = new Gauge({
        name: 'last_processed_nonce',
        help: 'Last processed nonce of the given shard',
        labelNames: [ 'shardId' ]
      });
    }

    if (!MetricsService.pendingApiHitGauge) {
      MetricsService.pendingApiHitGauge = new Gauge({
        name: 'pending_api_hits',
        help: 'Number of hits for pending API calls',
        labelNames: [ 'endpoint' ]
      });
    }

    if (!MetricsService.cachedApiHitGauge) {
      MetricsService.cachedApiHitGauge = new Gauge({
        name: 'cached_api_hits',
        help: 'Number of hits for cached API calls',
        labelNames: [ 'endpoint' ]
      });
    }

    if (!MetricsService.isDefaultMetricsRegistered) {
      MetricsService.isDefaultMetricsRegistered = true;
      collectDefaultMetrics();
    }
  }

  setApiCall(endpoint: string, status: number, duration: number, responseSize: number) {
    MetricsService.apiCallsHistogram.labels(endpoint, status.toString()).observe(duration);
    MetricsService.apiResponseSizeHistogram.labels(endpoint).observe(responseSize);
  }

  setVmQuery(address: string, func: string, duration: number) {
    MetricsService.vmQueriesHistogram.labels(address, func).observe(duration);
  }

  setPendingRequestsCount(count: number) {
    MetricsService.pendingRequestsHistogram.set(count);
  }

  setExternalCall(system: string, duration: number) {
    MetricsService.externalCallsHistogram.labels(system).observe(duration);
  }

  setElasticDuration(index: string, duration: number) {
    MetricsService.elasticDurationHistogram.labels(index).observe(duration);
  }

  setGatewayDuration(name: string, duration: number) {
    MetricsService.gatewayDurationHistogram.labels(name).observe(duration);
  }

  setElasticTook(index: string, took: number) {
    MetricsService.elasticTookHistogram.labels(index).observe(took);
  }

  setLastProcessedNonce(shardId: number, nonce: number) {
    MetricsService.lastProcessedNonceGauge.set({ shardId }, nonce);
  }

  incrementPendingApiHit(endpoint: string) {
    MetricsService.pendingApiHitGauge.inc({ endpoint });
  }

  incrementCachedApiHit(endpoint: string) {
    MetricsService.cachedApiHitGauge.inc({ endpoint });
  }

  async getMetrics(): Promise<string> {
    let shardIds = await this.protocolService.getShardIds();
    if (this.apiConfigService.getIsTransactionProcessorCronActive()) {
      let currentNonces = await this.getCurrentNonces();
      for (let [index, shardId] of shardIds.entries()) {
        MetricsService.currentNonceGauge.set({ shardId }, currentNonces[index]);
      }
    }

    return register.metrics();
  }

  private async getCurrentNonces(): Promise<number[]> {
    let shardIds = await this.protocolService.getShardIds();
    return await Promise.all(
      shardIds.map(shardId => this.getCurrentNonce(shardId))
    );
  }

  async getCurrentNonce(shardId: number): Promise<number> {
    let shardInfo = await this.gatewayService.get(`network/status/${shardId}`, GatewayComponentRequest.networkStatus);
    return shardInfo.status.erd_nonce;
  }
}