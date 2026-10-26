/*
 * Outbound delivery registry. The integrations module registers channel kinds
 * (slack, webhook, email, ...); scheduled jobs and alerts call deliver().
 * Messages carry ids, counts and summaries — never row values unless a job
 * explicitly exports a result, and then only to a destination an Admin configured.
 */

export interface DeliveryTarget {
  /** Integration id configured in the Integrations screen. */
  integrationId: string;
}

export interface DeliveryMessage {
  title: string;
  text: string;
  /** Optional attachment, e.g. a CSV export from a scheduled job. */
  attachment?: { filename: string; contentType: string; body: string };
  fields?: Record<string, string | number | boolean | null>;
}

type Sender = (integrationId: string, msg: DeliveryMessage) => Promise<void>;

let sender: Sender | null = null;

export function registerSender(fn: Sender): void {
  sender = fn;
}

export async function deliver(target: DeliveryTarget, msg: DeliveryMessage): Promise<void> {
  if (!sender) throw new Error('No delivery integration is configured');
  await sender(target.integrationId, msg);
}
