import { MetricSubmission, ReadLineTransformer } from "../deps.ts";

interface RawMetric {
  name: string;
  help?: string;
  unit?: string;
  type?: string;
  datas: Array<MetricPoint>;
}
interface MetricPoint {
  submetric: string;
  labelset: string;
  /** @deprecated use facets */
  tags: [string, string][];
  facets: Record<string,string>;
  value: number;
  rawValue: string;
}

export async function* parseMetrics(stream: ReadableStream<Uint8Array>): AsyncGenerator<RawMetric> {
  const lines = stream.pipeThrough(new ReadLineTransformer());
  let currObject: RawMetric | undefined;
  for await (const line of lines) {
    if (!line.startsWith('#')) {
      const match = line.match(/^([^ {]+)(?:{([^}]+)}|) ([^ ]+)$/);
      if (!match) throw new Error(`TODO: ${line}`);
      const tags: Record<string,string> = Object.create(null);
      for (const kv of match[2]?.split(',') ?? []) {
        const [k,v] = kv.split('=');
        tags[k] = JSON.parse(v);
      }
      currObject!.datas.push({
        submetric: match[1].slice(currObject!.name.length + 1),
        labelset: match[2],
        tags: match[2]?.split(',').map(str => {
          const [k, v] = str.split('=');
          return [k, JSON.parse(v)];
        }) ?? [],
        facets: tags,
        value: parseFloat(match[3]),
        rawValue: match[3],
      });
    } else if (line.startsWith('# TYPE ')) {
      const currName = line.split(' ')[2];
      if (currObject && currObject.name !== currName) yield currObject;
      currObject = {name: currName!, datas: []};
      currObject.type = line.slice(8+currName.length);
    } else if (line.startsWith('# HELP ')) {
      const currName = line.split(' ')[2];
      if (currObject && currObject.name !== currName) yield currObject;
      currObject = {name: currName!, datas: []};
      currObject.help = line.slice(8+currName.length);
    } else if (line.startsWith('# UNIT ')) {
      const currName = line.split(' ')[2];
      if (currObject && currObject.name !== currName) yield currObject;
      currObject = {name: currName!, datas: []};
      currObject.unit = line.slice(8+currName.length);
    } else if (line === '# EOF') {
      // break;
    } else throw new Error("TODO: "+line);
  }
  if (currObject) yield currObject;
}

// TODO: how does this differ from MonotonicMemory?
export class OpenmetricsMemory {
  private readonly memory = new Map<string,number>();
  constructor(
    public readonly tagPrefix = 'om',
  ) {}

  reportPointAs(
    point: MetricPoint,
    metric_name: string,
    metric_type: 'gauge' | 'rate' | 'count',
    extraTags: string[],
    tagKeyMap: Record<string,string>,
    monotonicKey: string | false,
  ): MetricSubmission[] {

    let value = point.value;
    if (monotonicKey) {
      const lastSeen = this.memory.get(monotonicKey);
      this.memory.set(monotonicKey, value);
      // console.log(monotonicKey, value, lastSeen);
      if (typeof lastSeen === 'number') {
        value -= lastSeen;
        if (value < 0) return [];
      } else {
        return [];
      }
    }

    return [{
      metric_name,
      points: [{value: value}],
      interval: 30,
      metric_type,
      tags: [
        ...extraTags,
        ...Object.entries(point.facets).map(([k,v]) => (tagKeyMap[k]||`${this.tagPrefix}_${k}`)+`:${v}`),
      ]}];
  }
}
