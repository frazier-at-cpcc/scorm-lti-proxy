import AdmZip from 'adm-zip';
import fs from 'fs/promises';
import path from 'path';
import { parseString } from 'xml2js';
import { promisify } from 'util';

const parseXml = promisify(parseString);

export interface ManifestData {
  title: string;
  scormVersion: '1.2' | '2004';
  launchPath: string;
  identifier: string;
  organizations: OrganizationData[];
  resources: ResourceData[];
}

interface OrganizationData {
  identifier: string;
  title: string;
  items: ItemData[];
}

interface ItemData {
  identifier: string;
  title: string;
  resourceId?: string;
}

interface ResourceData {
  identifier: string;
  type: string;
  href?: string;
  scormType?: string;
}

/**
 * Extracts a SCORM package (zip) to the target directory
 */
export async function extractScormPackage(
  zipPath: string,
  targetDir: string
): Promise<void> {
  // Ensure target directory exists
  await fs.mkdir(targetDir, { recursive: true });

  // Extract zip
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(targetDir, true);

  // Verify manifest exists
  const manifestPath = path.join(targetDir, 'imsmanifest.xml');
  try {
    await fs.access(manifestPath);
  } catch {
    throw new Error('Invalid SCORM package: imsmanifest.xml not found');
  }
}

/**
 * Parses the imsmanifest.xml file to extract course metadata
 */
export async function parseManifest(manifestPath: string): Promise<ManifestData> {
  const xmlContent = await fs.readFile(manifestPath, 'utf-8');
  const result = await parseXml(xmlContent);

  const manifest = result.manifest;
  if (!manifest) {
    throw new Error('Invalid manifest: missing manifest root element');
  }

  // Detect SCORM version
  const scormVersion = detectScormVersion(manifest);

  // Get metadata/title
  const title = extractTitle(manifest);

  // Get organizations
  const organizations = extractOrganizations(manifest);

  // Get resources
  const resources = extractResources(manifest);

  // Find launch path (first SCO resource)
  const launchPath = findLaunchPath(organizations, resources);

  return {
    title,
    scormVersion,
    launchPath,
    identifier: manifest.$?.identifier || 'unknown',
    organizations,
    resources,
  };
}

/**
 * Detects SCORM version from manifest namespaces
 */
function detectScormVersion(manifest: Record<string, unknown>): '1.2' | '2004' {
  const attrs = manifest.$ as Record<string, string> | undefined;
  if (!attrs) return '1.2';

  // Check for SCORM 2004 namespace
  const namespaces = Object.values(attrs).join(' ');
  if (namespaces.includes('adlcp_v1p3') || namespaces.includes('2004')) {
    return '2004';
  }

  return '1.2';
}

/**
 * Extracts course title from manifest
 */
function extractTitle(manifest: Record<string, unknown>): string {
  // Try metadata/lom/general/title
  const metadata = (manifest.metadata as unknown[])?.[0] as Record<string, unknown> | undefined;
  if (metadata) {
    const lom = (metadata.lom as unknown[])?.[0] as Record<string, unknown> | undefined;
    if (lom) {
      const general = (lom.general as unknown[])?.[0] as Record<string, unknown> | undefined;
      if (general) {
        const titleObj = (general.title as unknown[])?.[0] as Record<string, unknown> | undefined;
        if (titleObj) {
          const langstring = (titleObj.langstring as unknown[])?.[0];
          if (typeof langstring === 'string') return langstring;
          if (langstring && typeof langstring === 'object') {
            const ls = langstring as { _?: string };
            if (ls._) return ls._;
          }
        }
      }
    }
  }

  // Try organizations/organization/title
  const orgs = manifest.organizations as unknown[];
  if (orgs?.[0]) {
    const orgsObj = orgs[0] as Record<string, unknown>;
    const org = (orgsObj.organization as unknown[])?.[0] as Record<string, unknown> | undefined;
    if (org) {
      const title = (org.title as unknown[])?.[0];
      if (typeof title === 'string') return title;
    }
  }

  return 'Untitled Course';
}

/**
 * Extracts organization structure from manifest
 */
function extractOrganizations(manifest: Record<string, unknown>): OrganizationData[] {
  const orgsWrapper = (manifest.organizations as unknown[])?.[0] as Record<string, unknown> | undefined;
  if (!orgsWrapper) return [];

  const orgs = orgsWrapper.organization as unknown[];
  if (!orgs) return [];

  return orgs.map((org) => {
    const o = org as Record<string, unknown>;
    const attrs = o.$ as Record<string, string> | undefined;

    return {
      identifier: attrs?.identifier || 'unknown',
      title: extractStringValue(o.title),
      items: extractItems(o.item as unknown[]),
    };
  });
}

/**
 * Extracts items from organization
 */
function extractItems(items: unknown[] | undefined): ItemData[] {
  if (!items) return [];

  return items.map((item) => {
    const i = item as Record<string, unknown>;
    const attrs = i.$ as Record<string, string> | undefined;

    return {
      identifier: attrs?.identifier || 'unknown',
      title: extractStringValue(i.title),
      resourceId: attrs?.identifierref,
    };
  });
}

/**
 * Extracts resources from manifest
 */
function extractResources(manifest: Record<string, unknown>): ResourceData[] {
  const resourcesWrapper = (manifest.resources as unknown[])?.[0] as Record<string, unknown> | undefined;
  if (!resourcesWrapper) return [];

  const resources = resourcesWrapper.resource as unknown[];
  if (!resources) return [];

  return resources.map((res) => {
    const r = res as Record<string, unknown>;
    const attrs = r.$ as Record<string, string> | undefined;

    return {
      identifier: attrs?.identifier || 'unknown',
      type: attrs?.type || 'webcontent',
      href: attrs?.href,
      scormType: attrs?.['adlcp:scormtype'] || attrs?.['adlcp:scormType'],
    };
  });
}

/**
 * Finds the launch path for the first SCO
 */
function findLaunchPath(
  organizations: OrganizationData[],
  resources: ResourceData[]
): string {
  // Find first item with a resource reference
  for (const org of organizations) {
    for (const item of org.items) {
      if (item.resourceId) {
        const resource = resources.find((r) => r.identifier === item.resourceId);
        if (resource?.href) {
          return resource.href;
        }
      }
    }
  }

  // Fallback: find first resource with href that looks like a launch file
  for (const resource of resources) {
    if (resource.href && resource.scormType?.toLowerCase() === 'sco') {
      return resource.href;
    }
  }

  // Last resort: first resource with href
  const firstWithHref = resources.find((r) => r.href);
  return firstWithHref?.href || 'index.html';
}

/**
 * Extracts string value from XML element
 */
function extractStringValue(element: unknown): string {
  if (!element) return '';
  const arr = element as unknown[];
  if (!arr[0]) return '';

  const val = arr[0];
  if (typeof val === 'string') return val;
  if (typeof val === 'object' && val !== null) {
    const obj = val as { _?: string };
    return obj._ || '';
  }
  return '';
}
