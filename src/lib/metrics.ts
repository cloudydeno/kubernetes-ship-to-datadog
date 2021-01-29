import {
  MetricSubmission,
  CheckStatus,
} from '../deps.ts';

// Much like 'CheckRun' but blends in with MetricSubmissions better
export interface CheckSubmission {
  metric_name: string; // actually check_name
  metric_type: 'check';
  host_name: string;
  tags?: Array<string>;
  // fields that are only on checks:
  message?: string;
  status: CheckStatus;
  timestamp?: Date;
}

export type DataSubmission = MetricSubmission | CheckSubmission;
export type AsyncMetricGen = AsyncGenerator<DataSubmission,any,undefined>;
export type SyncMetricGen = Generator<DataSubmission,any,undefined>;

export function makeLoopErrorPoint(err: unknown, tags: string[]): MetricSubmission {
  const type = (err instanceof Error) ? err.name : typeof err;
  return {
    metric_name: `app.loop.error`,
    points: [{value: 1}],
    interval: 60,
    metric_type: 'count',
    tags: [ ...tags, `error:${type}` ],
  };
}

export class MonotonicMemory {
  #memory = new Map<string,number>();

  reportCount(
    raw_value: number,
    monotonicKey: string,
    baseMetric: Omit<MetricSubmission, 'metric_type' | 'points'>,
  ): MetricSubmission[] {

    // TODO: if we've done a first loop & the metric hasn't been seen in that,
    // report the first value

    const lastSeen = this.#memory.get(monotonicKey);
    this.#memory.set(monotonicKey, raw_value);
    // console.log(monotonicKey, raw_value, lastSeen);
    if (typeof lastSeen === 'number') {
      // if a container restarts, report the new value as whole
      // (because we don't want to drop the NEW data)
      if (raw_value >= lastSeen) {
        raw_value -= lastSeen;
      }
    } else {
      return [];
    }

    return [{
      interval: 30,
      ...baseMetric,
      points: [{value: raw_value}],
      metric_type: 'count',
    }];
  }
}
