import type { FastifyInstance } from 'fastify';
import type { RealtimeMessage, SyncEvent, SyncResponse } from '@tel-messenger/media-contract';
import { db, type DbClient } from './db.js';

const MAX_EVENTS = 500;
const RETENTION_DAYS = 7;
const CLEANUP_MS = 3_600_000;

type Queryable = Pick<DbClient, 'query'>;
export type SyncDeps = {
  messageColumns: string;
  serializeMessage: (row: never) => RealtimeMessage;
};

/** Appends a message.* event to the log and returns its seq. Call inside the same transaction as the change. */
export const recordEvent = async (
  q: Queryable, chatId: string, type: SyncEvent['type'], messageId: string
): Promise<number> => {
  const result = await q.query<{ seq: number }>(
    'INSERT INTO events (chat_id, type, message_id) VALUES ($1, $2, $3) RETURNING seq',
    [chatId, type, messageId]
  );
  return Number(result.rows[0].seq);
};

const latestSeq = async (): Promise<number> => {
  const row = (await db.query<{ seq: number }>("SELECT seq FROM sqlite_sequence WHERE name = 'events'")).rows[0];
  return row ? Number(row.seq) : 0;
};

export const cleanupEvents = async (): Promise<number> =>
  (await db.query(
    "DELETE FROM events WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', $1)",
    [`-${RETENTION_DAYS} days`]
  )).rowCount;

export const registerSync = async (app: FastifyInstance, deps: SyncDeps): Promise<void> => {
  app.get<{ Querystring: { since?: string } }>(
    '/api/sync',
    { preHandler: app.requireUser, config: { rateLimit: { max: 240, timeWindow: '1 minute' } } },
    async (request, reply): Promise<SyncResponse | void> => {
      const raw = request.query.since;
      if (raw !== undefined && !/^\d{1,15}$/.test(raw)) return reply.code(400).send({ error: 'since must be a non-negative integer' });
      const latest = await latestSeq();
      if (raw === undefined) return { events: [], latest, reset: false };
      const since = Number(raw);
      const oldest = (await db.query<{ seq: number | null }>('SELECT MIN(seq) AS seq FROM events')).rows[0]?.seq;
      // Gap = events between `since` and the oldest retained one were cleaned up (seq is global, so this is conservative).
      const floor = oldest === null || oldest === undefined ? latest + 1 : Number(oldest);
      if (since > latest || since + 1 < floor) return { events: [], latest, reset: true };

      const rows = await db.query<{ event_seq: number; event_type: SyncEvent['type'] } & Record<string, unknown>>(
        `SELECT e.seq AS event_seq, e.type AS event_type, ${deps.messageColumns}
         FROM events e
         JOIN messages m ON m.id = e.message_id
         JOIN users u ON u.id = m.sender_id
         WHERE e.seq > $1
           AND e.chat_id IN (SELECT chat_id FROM chat_members WHERE user_id = $2)
         ORDER BY e.seq ASC
         LIMIT ${MAX_EVENTS + 1}`,
        [since, request.user!.id]
      );
      if (rows.rows.length > MAX_EVENTS) return { events: [], latest, reset: true };
      const events: SyncEvent[] = rows.rows.map((row) => {
        const message = deps.serializeMessage(row as never);
        return { seq: Number(row.event_seq), type: row.event_type, chatId: message.chatId, message };
      });
      return { events, latest, reset: false };
    }
  );

  const timer = setInterval(() => {
    cleanupEvents().catch((error: unknown) => app.log.warn({ err: error }, 'event log cleanup failed'));
  }, CLEANUP_MS);
  timer.unref();
  app.addHook('onClose', async () => { clearInterval(timer); });
  cleanupEvents().catch((error: unknown) => app.log.warn({ err: error }, 'event log cleanup failed'));
};
