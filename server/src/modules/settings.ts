import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPolicy, getSetting, setSetting, type SecurityPolicy } from '../core/settings.ts';
import { parse } from '../core/http.ts';
import { audit } from '../security/audit.ts';
import { hasRole, requireRole, userOf } from '../security/authz.ts';

/*
 * Settings → Safety. The four toggles map onto fields of the workspace security policy
 * (`security.policy`), which the executor enforces. Everyone can read them; only Admins change them.
 * Writes merge into the stored object so fields owned by the Security screen stay untouched.
 */

const SAFETY_FIELDS = ['requireTypedConfirm', 'typedConfirmProd', 'blockWhereless', 'redactLiterals'] as const;
type SafetyField = (typeof SAFETY_FIELDS)[number];

const safetyPatch = z.object({
  requireTypedConfirm: z.boolean().optional(),
  typedConfirmProd: z.boolean().optional(),
  blockWhereless: z.boolean().optional(),
  redactLiterals: z.boolean().optional(),
}).strict();

function pick(p: SecurityPolicy): Record<SafetyField, boolean> {
  return Object.fromEntries(SAFETY_FIELDS.map((f) => [f, !!p[f]])) as Record<SafetyField, boolean>;
}

export default async function settingsModule(app: FastifyInstance): Promise<void> {
  app.get('/settings/safety', async (req) => {
    const u = userOf(req);
    return { ...pick(await getPolicy()), canEdit: hasRole(u, 'Admin') };
  });

  app.put('/settings/safety', async (req) => {
    const u = requireRole(req, 'Admin');
    const patch = parse(safetyPatch, req.body);
    const before = pick(await getPolicy());
    const stored = await getSetting<Partial<SecurityPolicy>>('security.policy', {});
    const merged: Partial<SecurityPolicy> = { ...stored };
    const changes: Record<string, { from: boolean; to: boolean }> = {};
    for (const f of SAFETY_FIELDS) {
      const v = patch[f];
      if (typeof v !== 'boolean') continue;
      merged[f] = v;
      if (before[f] !== v) changes[f] = { from: before[f], to: v };
    }
    if (Object.keys(changes).length) {
      await setSetting('security.policy', merged, u.id);
      await audit({ actorId: u.id, actorLabel: u.email, kind: 'SETTINGS', target: 'security.policy', status: 'ok', ip: req.ip, detail: { area: 'safety', changes } });
    }
    return { ...pick(await getPolicy()), canEdit: true };
  });
}
