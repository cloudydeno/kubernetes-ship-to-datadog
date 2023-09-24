import {
  KubernetesClient,
  Reflector,
  CoreV1,
  AppsV1,
} from '../deps.ts';

export class KubeWatcher {
  constructor(
    private kubeClient: KubernetesClient,
  ) {
    this.coreApi = new CoreV1.CoreV1Api(this.kubeClient);
    this.appsApi = new AppsV1.AppsV1Api(this.kubeClient);
  }
  coreApi: CoreV1.CoreV1Api;
  appsApi: AppsV1.AppsV1Api;

  nodeReflector = new Reflector(
    opts => this.coreApi.getNodeList(opts),
    opts => this.coreApi.watchNodeList(opts));

  daemonsetReflector = new Reflector(
    opts => this.appsApi.getDaemonSetListForAllNamespaces(opts),
    opts => this.appsApi.watchDaemonSetListForAllNamespaces(opts));

  deploymentReflector = new Reflector(
    opts => this.appsApi.getDeploymentListForAllNamespaces(opts),
    opts => this.appsApi.watchDeploymentListForAllNamespaces(opts));

  statefulsetReflector = new Reflector(
    opts => this.appsApi.getStatefulSetListForAllNamespaces(opts),
    opts => this.appsApi.watchStatefulSetListForAllNamespaces(opts));

  podReflector = new Reflector(
    opts => this.coreApi.getPodListForAllNamespaces(opts),
    opts => this.coreApi.watchPodListForAllNamespaces(opts));

  startAll() {
    this.nodeReflector.run();
    this.daemonsetReflector.run();
    this.deploymentReflector.run();
    this.statefulsetReflector.run();
    this.podReflector.run();
    return () => {
      if (!this.nodeReflector.isSynced()) return false;
      if (!this.daemonsetReflector.isSynced()) return false;
      if (!this.deploymentReflector.isSynced()) return false;
      if (!this.statefulsetReflector.isSynced()) return false;
      if (!this.podReflector.isSynced()) return false;
      return true;
    };
  }
}
