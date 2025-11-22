import { listCustomResources } from './generated/servers/kubernetes/listCustomResources.js';
import * as k8s from '@kubernetes/client-node';

async function listAllCustomResources() {
  try {
    // First, get all CRDs using the Kubernetes client
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    const apiExtensions = kc.makeApiClient(k8s.ApiextensionsV1Api);

    console.log('Fetching Custom Resource Definitions...\n');
    const crdResponse = await apiExtensions.listCustomResourceDefinition();

    // The response structure is different - items are at the top level
    const crds = (crdResponse as any).items || crdResponse?.body?.items || [];

    console.log(`Found ${crds.length} CRD(s)\n`);

    // For each CRD, list the custom resources
    for (const crd of crds) {
      const group = crd.spec.group;
      const names = crd.spec.names;
      const scope = crd.spec.scope;

      console.log(`\n${'='.repeat(80)}`);
      console.log(`CRD: ${names.kind} (${names.plural}.${group})`);
      console.log(`Scope: ${scope}`);
      console.log(`Short Names: ${names.shortNames?.join(', ') || 'none'}`);
      console.log(`${'='.repeat(80)}`);

      // Get the storage version
      const storageVersion = crd.spec.versions.find(v => v.storage)?.name || crd.spec.versions[0].name;

      try {
        // List custom resources for this CRD
        // For namespaced resources, we need to list across all namespaces or specify one
        // For cluster-scoped, don't specify namespace
        const params: any = {
          group: group,
          version: storageVersion,
          plural: names.plural,
          includeRaw: false
        };

        const resources = await listCustomResources(params);

        const items = resources?.items || [];

        if (items.length > 0) {
          console.log(`\nFound ${items.length} ${names.kind} resource(s):\n`);

          for (const item of items) {
            console.log(`  Name: ${item.name || item.metadata?.name || 'unknown'}`);
            if (item.namespace || item.metadata?.namespace) {
              console.log(`  Namespace: ${item.namespace || item.metadata?.namespace}`);
            }
            if (item.creationTimestamp || item.metadata?.creationTimestamp) {
              console.log(`  Age: ${item.ageSeconds}s`);
            }
            if (item.spec) {
              console.log(`  Spec: ${JSON.stringify(item.spec, null, 4).split('\n').join('\n    ')}`);
            }
            console.log('');
          }
        } else {
          console.log(`\nNo ${names.kind} resources found.\n`);
        }
      } catch (error: any) {
        console.log(`\nError listing resources: ${error.message}\n`);
      }
    }

    console.log(`\n${'='.repeat(80)}`);
    console.log('Summary complete');
    console.log(`${'='.repeat(80)}\n`);

  } catch (error) {
    console.error('Error:', error);
  }
}

listAllCustomResources();
