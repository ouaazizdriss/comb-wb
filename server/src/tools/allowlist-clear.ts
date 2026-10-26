// Break-glass: empties the IP allowlist when a bad entry locks everyone out.
// Runs on the server host with the metadata DB credentials, so it is only available to operators.
import { setSetting } from '../core/settings.ts';
import { audit } from '../security/audit.ts';
import { meta } from '../db/meta.ts';

await setSetting('security.ip_allowlist', []);
await audit({ actorLabel: 'operator (cli)', kind: 'SECURITY', target: 'ip_allowlist', status: 'ok', detail: { action: 'clear', via: 'allowlist:clear' } });
console.log('IP allowlist cleared. The change is recorded in the audit trail.');
await meta.end();
