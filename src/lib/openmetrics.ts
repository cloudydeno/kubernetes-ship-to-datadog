import { MetricSubmission, ReadLineTransformer } from "../deps.ts";

interface RawMetric {
  name: string;
  help?: string;
  unit?: string;
  type: string;
  datas: Array<MetricPoint>;
}
interface MetricPoint {
  submetric: string;
  labelset: string;
  tags: [string, string][];
  facets: Record<string,string>;
  value: number;
  rawValue: string;
}

export async function* parseMetrics(stream: ReadableStream<Uint8Array>): AsyncGenerator<RawMetric> {
  const lines = stream.pipeThrough(new ReadLineTransformer());
  let currName: string | undefined;
  let currHelp: string | undefined;
  let currType: string | undefined;
  let currUnit: string | undefined;
  let datas: Array<MetricPoint> | undefined;
  for await (const line of lines) {
    if (!line.startsWith('#')) {
      // console.log(3, currName, currHelp, currType, line);
      const match = line.match(/^([^ {]+)(?:{([^}]+)}|) ([^ ]+)$/);
      if (!match) throw new Error(`TODO: ${line}`);
      const tags: Record<string,string> = Object.create(null);
      for (const kv of match[2]?.split(',') ?? []) {
        const [k,v] = kv.split('=');
        tags[k] = JSON.parse(v);
      }
      datas!.push({
        submetric: match[1].slice(currName!.length + 1),
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
      if (datas) {
        yield {name: currName!, help: currHelp, unit: currUnit, type: currType!, datas};
      }
      currName = line.split(' ')[2];
      currHelp = undefined;
      currUnit = undefined;
      currType = line.slice(8+currName.length);
      datas = [];
    } else if (line.startsWith('# HELP ')) {
      currName = line.split(' ')[2];
      currHelp = line.slice(8+currName.length);
    } else if (line.startsWith('# UNIT ')) {
      currName = line.split(' ')[2];
      currUnit = line.slice(8+currName.length);
    } else if (line === '# EOF') {
      // break;
    } else throw new Error("TODO: "+line);
  }
  if (datas) {
    yield {name: currName!, help: currHelp, unit: currUnit, type: currType!, datas};
  }
}

// TODO: how does this differ from MonotonicMemory?
export class OpenmetricsMemory {
  private readonly memory = new Map<string,number>();

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
        ...point.tags.map(([k,v]) => (tagKeyMap[k]||`om_${k}`)+`:${v}`),
      ]}];
  }
}
