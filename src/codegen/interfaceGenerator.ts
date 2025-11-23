/**
 * Generate inline TypeScript interfaces from Kubernetes types
 */

import { InterfaceInfo, extractInterfaceFromFile, findKubernetesTypeFile } from './typeExtractor.js';

/**
 * Types that should NOT be expanded (too complex or rarely used)
 */
const DONT_EXPAND_TYPES = new Set([
  // Complex scheduling/affinity rules
  'V1Affinity', 'V1NodeAffinity', 'V1PodAffinity', 'V1PodAntiAffinity',
  'V1NodeSelector', 'V1NodeSelectorRequirement',
  'V1LabelSelectorRequirement',
  
  // Complex security contexts
  'V1SecurityContext', 'V1PodSecurityContext', 'V1SELinuxOptions',
  'V1SeccompProfile', 'V1WindowsSecurityContextOptions', 'V1Capabilities',
  'V1AppArmorProfile',
  
  // Probes (detailed structure not commonly needed)
  'V1Probe', 'V1HTTPGetAction', 'V1TCPSocketAction', 'V1ExecAction',
  'V1GRPCAction', 'V1SleepAction', 'V1HTTPHeader',
  
  // Lifecycle hooks
  'V1Lifecycle', 'V1LifecycleHandler',
  
  // Volume types (too many variants)
  'V1VolumeMount', 'V1PersistentVolumeClaimVolumeSource',
  'V1ConfigMapVolumeSource', 'V1SecretVolumeSource', 'V1EmptyDirVolumeSource',
  'V1HostPathVolumeSource', 'V1ProjectedVolumeSource', 'V1CSIVolumeSource',
  
  // Resource references
  'V1ResourceClaim', 'V1TypedLocalObjectReference',
  'V1LocalObjectReference', 'V1ObjectReference',
  
  // Field selectors
  'V1EnvVarSource', 'V1ConfigMapKeySelector', 'V1SecretKeySelector',
  'V1ObjectFieldSelector', 'V1ResourceFieldSelector',
  'V1ConfigMapEnvSource', 'V1SecretEnvSource',
  
  // Tolerations and taints
  'V1Taint',
  
  // Topology
  'V1TopologySpreadConstraint', 'V1PodAffinityTerm', 'V1WeightedPodAffinityTerm',
  
  // Other complex types
  'V1PodReadinessGate', 'V1PodResourceClaim', 'V1ContainerResizePolicy',
  'V1EphemeralContainer', 'V1HostAlias', 'V1PodOS',
]);

/**
 * Check if a type should not be expanded (return generic object instead)
 */
function shouldNotExpand(typeName: string): boolean {
  return DONT_EXPAND_TYPES.has(typeName);
}

/**
 * Check if a type is a primitive or should not be expanded
 */
function isPrimitiveType(typeName: string): boolean {
  const primitives = [
    'string', 'number', 'boolean', 'unknown', 'any', 'void', 'null', 'undefined',
    'Date', 'object', 'never'
  ];
  
  // Check if it's a primitive
  if (primitives.includes(typeName)) {
    return true;
  }
  
  // Check if it's a Record type
  if (typeName.startsWith('Record<') || typeName.startsWith('{')) {
    return true;
  }
  
  // Check if it's a union with primitives
  if (typeName.includes('|')) {
    return true;
  }
  
  return false;
}

/**
 * Extract the inner type from Array<T>
 */
function extractArrayType(typeName: string): string | null {
  const match = typeName.match(/^Array<(.+)>$/);
  return match && match[1] ? match[1] : null;
}


/**
 * Recursively expand a type into an inline interface definition
 */
function expandType(typeName: string, indent: string = '  ', depth: number = 0, visited: Set<string> = new Set()): string {
  // Prevent infinite recursion - limit to 3 levels for reasonable file sizes
  if (depth > 3) {
    return '{ [key: string]: unknown }';
  }
  
  // Convert Date to string
  if (typeName === 'Date') {
    return 'string';
  }
  
  // Check if this type should not be expanded (too complex)
  if (shouldNotExpand(typeName)) {
    return '{ [key: string]: unknown }';
  }
  
  // Check if it's a primitive
  if (isPrimitiveType(typeName)) {
    return typeName === 'object' ? '{ [key: string]: unknown }' : typeName;
  }
  
  // Handle Array types
  const arrayInnerType = extractArrayType(typeName);
  if (arrayInnerType) {
    const expandedInner = expandType(arrayInnerType, indent, depth + 1, visited);
    // If the inner type is complex (multiline), format it properly
    if (expandedInner.includes('\n')) {
      return `Array<${expandedInner}>`;
    }
    return `Array<${expandedInner}>`;
  }
  
  // Check for circular reference
  if (visited.has(typeName)) {
    return '{ [key: string]: unknown }';
  }
  
  // Try to find and expand Kubernetes types
  if (typeName.startsWith('V1') || typeName.startsWith('V2')) {
    const typeFile = findKubernetesTypeFile(typeName);
    if (typeFile) {
      const typeInfo = extractInterfaceFromFile(typeFile, typeName);
      if (typeInfo) {
        visited.add(typeName);
        const expanded = expandTypeInfo(typeInfo, indent + '  ', depth + 1, visited);
        visited.delete(typeName);
        return expanded;
      }
    }
  }
  
  // Fallback
  return '{ [key: string]: unknown }';
}

/**
 * Expand a complete InterfaceInfo into inline type definition
 */
function expandTypeInfo(typeInfo: InterfaceInfo, indent: string, depth: number, visited: Set<string>): string {
  const lines: string[] = [];
  lines.push('{');
  
  for (const field of typeInfo.fields) {
    // Skip static/internal fields
    if (['discriminator', 'mapping', 'attributeTypeMap'].includes(field.name)) {
      continue;
    }
    
    // Add field JSDoc if present
    if (field.jsDoc) {
      lines.push(`${indent}/** ${field.jsDoc} */`);
    }
    
    const optional = field.optional ? '?' : '';
    const expandedType = expandType(field.type, indent, depth, visited);
    
    // Handle multiline expanded types
    if (expandedType.includes('\n')) {
      lines.push(`${indent}${field.name}${optional}: ${expandedType};`);
    } else {
      lines.push(`${indent}${field.name}${optional}: ${expandedType};`);
    }
  }
  
  lines.push(indent.slice(0, -2) + '}');
  return lines.join('\n');
}

/**
 * Generate expanded inline interface with detailed nested types
 */
export function generateExpandedInterface(
  resultTypeName: string,
  kubernetesType: string,
  interfaceInfo: InterfaceInfo
): string {
  const lines: string[] = [];

  // Add interface JSDoc
  if (interfaceInfo.jsDoc) {
    lines.push('/**');
    lines.push(` * ${interfaceInfo.jsDoc}`);
    lines.push(' */');
  }

  lines.push(`export interface ${resultTypeName} {`);

  const visited = new Set<string>();
  visited.add(kubernetesType);

  // Generate fields with recursive expansion
  for (const field of interfaceInfo.fields) {
    // Skip static fields
    if (['discriminator', 'mapping', 'attributeTypeMap'].includes(field.name)) {
      continue;
    }

    // Add field JSDoc
    if (field.jsDoc) {
      lines.push(`  /** ${field.jsDoc} */`);
    }

    const optional = field.optional ? '?' : '';
    const expandedType = expandType(field.type, '  ', 0, visited);
    
    lines.push(`  ${field.name}${optional}: ${expandedType};`);
  }

  lines.push('}');

  return lines.join('\n');
}

