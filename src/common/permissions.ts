import { SetMetadata } from '@nestjs/common';
import type { UserRole } from '../generated/prisma/client.js';

/**
 * Per-project permissions. Stored on ProjectMember.permissions (JSON array of keys).
 * null = follow the user's role preset, so existing members keep today's behaviour.
 * ADMIN and SUPERADMIN always have every permission in every project.
 *
 * Keep in sync with fe-social-listening/src/lib/permissions.ts.
 */
export const PERMISSION_CATALOG = [
  // Menu access (read)
  { key: 'overview.view', group: 'Pages', label: 'Summary' },
  { key: 'insights.view', group: 'Pages', label: 'AI insights' },
  { key: 'channels.view', group: 'Pages', label: 'Channel analysis' },
  { key: 'topics.view', group: 'Pages', label: 'Topics & tagging' },
  { key: 'competitors.view', group: 'Pages', label: 'Competitive insights' },
  { key: 'influencers.view', group: 'Pages', label: 'Influencers & sources' },
  { key: 'demographics.view', group: 'Pages', label: 'Audience & timing' },
  { key: 'hashtags.view', group: 'Pages', label: 'Hashtags & keywords' },
  { key: 'mentions.view', group: 'Pages', label: 'Mentions' },
  { key: 'geo.view', group: 'Pages', label: 'AI visibility' },
  { key: 'assistant.use', group: 'Pages', label: 'Brand assistant' },
  {
    key: 'reports.export',
    group: 'Pages',
    label: 'Export reports (PDF/Excel)',
  },
  // Actions (write)
  { key: 'insights.generate', group: 'Actions', label: 'Generate AI insights' },
  {
    key: 'accounts.tag',
    group: 'Actions',
    label: 'Tag accounts (paid/organic, type)',
  },
  {
    key: 'geo.manage',
    group: 'Actions',
    label: 'Manage AI visibility prompts & runs',
  },
  { key: 'reports.email', group: 'Actions', label: 'Send reports by email' },
  { key: 'data.upload', group: 'Actions', label: 'Upload data' },
  {
    key: 'categories.manage',
    group: 'Actions',
    label: 'Manage topic categories',
  },
  {
    key: 'settings.manage',
    group: 'Actions',
    label: 'Project settings (NSS, reports, GEO, keywords)',
  },
] as const;

export type Permission = (typeof PERMISSION_CATALOG)[number]['key'];
export const ALL_PERMISSIONS: Permission[] = PERMISSION_CATALOG.map(
  (p) => p.key,
);

const VIEW: Permission[] = ALL_PERMISSIONS.filter(
  (p) => p.endsWith('.view') || p === 'assistant.use' || p === 'reports.export',
);

/** Defaults per role; same rights ANALYST/VIEWER had before per-project permissions. */
export const ROLE_PRESETS: Record<'ANALYST' | 'VIEWER', Permission[]> = {
  VIEWER: VIEW,
  ANALYST: [
    ...VIEW,
    'insights.generate',
    'accounts.tag',
    'geo.manage',
    'reports.email',
    'data.upload',
  ],
};

export const isPermission = (v: unknown): v is Permission =>
  typeof v === 'string' && (ALL_PERMISSIONS as string[]).includes(v);

/** What a user may do in one project. */
export function effectivePermissions(
  role: UserRole,
  stored: unknown,
): Permission[] {
  if (role === 'ADMIN' || role === 'SUPERADMIN') return ALL_PERMISSIONS;
  if (Array.isArray(stored)) return stored.filter(isPermission);
  return ROLE_PRESETS[role];
}

export const PERMISSIONS_KEY = 'requiredPermissions';
/** Route needs at least one of these permissions in the :projectId project. */
export const RequirePermission = (...anyOf: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, anyOf);
