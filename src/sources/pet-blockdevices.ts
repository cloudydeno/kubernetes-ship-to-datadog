import {
  autoDetectKubernetesClient,
  MetricSubmission,
} from '../deps.ts';
import {
  PetWg69NetV1Api,
  BlockDevice,
} from '../vendor-apis/pet.wg69.net@v1/mod.ts';

const petApi = new PetWg69NetV1Api(await autoDetectKubernetesClient());

type SmartReport = (BlockDevice["status"] & {})["smartReport"] & {};
const reportMemory = new Map<string, SmartReport>();

export async function* buildBlockDeviceMetrics(baseTags: string[]): AsyncGenerator<MetricSubmission,any,undefined> {
  try {

    const {items: blks} = await petApi.getBlockDeviceList();
    for (const blk of blks) {
      yield* reportBlockDev(baseTags, blk);
    }

  } catch (err: unknown) {
    console.log((err instanceof Error) ? err.stack : err);
    const type = (err instanceof Error) ? err.name : typeof err;
    yield {
      metric_name: `app.loop.error`,
      points: [{value: 1}],
      interval: 60,
      metric_type: 'count',
      tags: [...baseTags,
        `source:pet-blockdevices`,
        `error:${type}`,
      ],
    };
  }
}

async function* reportBlockDev(baseTags: string[], node: BlockDevice): AsyncGenerator<MetricSubmission,any,undefined> {
  const report = node.status?.smartReport;
  if (!node.metadata?.uid || !node.spec.serialNumber || !report) return;
  const blkType = (node.metadata.labels ?? {})['pet.wg69.net/blk-type'];

  const prevObs = reportMemory.get(node.spec.serialNumber);
  if (prevObs?.collectionTime.valueOf() === report.collectionTime.valueOf()) return;
  reportMemory.set(node.spec.serialNumber, report);

  const tags = [...baseTags,
    `serial:${node.spec.serialNumber}`,
    `drive_media:${blkType ?? 'unknown'}`,
  ];

  for (const attr of report.attributes) {
    if (attr.currentHealth == null) continue;
    // rawValue?: string | null;
    // id?: number | null;
    // currentHealth?: number | null;
    // worstHealth?: number | null;
    // name?: string | null;
    // threshold?: number | null;
    // type?: string | null;

    const attrTags = [
      ...tags,
      `smart_attr:${attr.name === 'Unknown_Attribute' ? attr.id : attr.name}`,
      `smart_type:${attr.type}`,
    ];

    yield {
      metric_name: `block_device.smart_attr_health.current`,
      points: [{value: attr.currentHealth, timestamp: report.collectionTime}],
      interval: 60,
      metric_type: 'gauge',
      tags: attrTags,
    };
    if (attr.threshold != null) yield {
      metric_name: `block_device.smart_attr_health.threshold`,
      points: [{value: attr.threshold, timestamp: report.collectionTime}],
      interval: 60,
      metric_type: 'gauge',
      tags: attrTags,
    };

    let attrName = attr.name ?? 'Unknown';
    if (attrName === 'Airflow_Temperature_Cel')
      attrName = 'Temperature_Celsius';
    if (attr.id === 231)
      attrName = 'Temperature_Celsius_Alt';

    const gauges = new Set([
      'Start_Stop_Count',
      'Reallocated_Sector_Ct',
      'Power_On_Hours',
      'Power_Cycle_Count',
      'Load_Cycle_Count',
      'Temperature_Celsius',
      'Wear_Leveling_Count',
      'Runtime_Bad_Block',
      'Unused_Rsvd_Blk_Cnt_Tot',
      'ECC_Error_Rate',
      'Media_Wearout_Indicator',
      'POR_Recovery_Count',
      'Total_LBAs_Written',
    ]);
    if (gauges.has(attrName)) {
      yield {
        metric_name: `block_device.smart_attr.${attrName}`,
        points: [{value: parseInt(attr.rawValue ?? '-1'), timestamp: report.collectionTime}],
        interval: 60,
        metric_type: 'gauge',
        tags: attrTags,
      };
    }

  }

}
