import type { FastifyInstance, FastifyReply } from 'fastify';
import { db } from './db.js';
import { parseEncryptedMessageV2, type EncryptedMessageV2 } from './encrypted-message.js';
import { recordEvent, registerSync } from './sync.js';
import { ensureCanPost, registerChannelRoutes } from './channels.js';
import { groupMessageGate, registerGroupRoutes } from './groups.js';
import { notifyChatNew } from './realtime.js';

const MESSAGE_KINDS = ['text', 'sticker', 'gif', 'photo', 'video', 'voice', 'file'] as const;
// Kinds whose bytes may live in an E2EE attachment (PUT /api/chats/:chatId/attachments/:id).
const ATTACHMENT_KINDS = new Set<string>(['photo', 'video', 'voice', 'file']);
const ATTACHMENT_ONLY_KINDS = new Set<string>(['video', 'voice', 'file']);
type MessageKind = (typeof MESSAGE_KINDS)[number];

type MessageRow = {
  id: string;
  chat_id: string;
  sender_id: string;
  kind: MessageKind;
  text: string | null;
  payload: unknown | null;
  reply_to_id: string | null;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  encryption_version: number | null;
  nonce: string | null;
  ciphertext: string | null;
  cipher_id: string | null;
  attachment_id: string | null;
  client_msg_id: string | null;
  key_version: number | null;
  sender_username: string;
  sender_display_name: string;
  sender_avatar_path: string | null;
};

type IncomingMessage = {
  kind: MessageKind;
  text: string | null;
  payload: Record<string, unknown> | null;
  replyToId: string | null;
  encrypted: EncryptedMessageV2;
  encryptedMediaId: string | null;
  attachmentId: string | null;
  clientMsgId: string | null;
};

const CHAT_READ_RATE_LIMIT = { max: 240, timeWindow: '1 minute' } as const;
const CHAT_WRITE_RATE_LIMIT = { max: 60, timeWindow: '1 minute' } as const;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseId = (value: unknown): string | null => {
  const text = typeof value === 'number' ? String(value) : value;
  return typeof text === 'string' && /^[1-9]\d*$/.test(text) ? text : null;
};

const parseLimit = (value: unknown): number | null => {
  if (value === undefined) return 50;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const limit = Number(value);
  return Number.isSafeInteger(limit) && limit >= 1 && limit <= 100 ? limit : null;
};

const parseUuid = (value: unknown): string | null => typeof value === 'string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value) ? value.toLowerCase() : null;

const parseIncomingMessage = (body: unknown): IncomingMessage | { error: string } => {
  if (!isPlainObject(body) || !MESSAGE_KINDS.includes(body.kind as MessageKind)) {
    return { error: 'kind must be text, sticker, gif, photo, video, voice, or file' };
  }

  const kind = body.kind as MessageKind;
  const clientMsgId = body.clientMsgId === undefined || body.clientMsgId === null ? null
    : typeof body.clientMsgId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(body.clientMsgId) ? body.clientMsgId : undefined;
  if (clientMsgId === undefined) return { error: 'clientMsgId must be 8-64 characters of A-Z a-z 0-9 _ -' };
  const replyToId = body.replyToId === undefined || body.replyToId === null ? null : parseId(body.replyToId);
  if (body.replyToId !== undefined && body.replyToId !== null && !replyToId) {
    return { error: 'replyToId must be a positive message id' };
  }

  const encrypted = parseEncryptedMessageV2(body.encrypted);
  if (!encrypted) return { error: 'A valid version 2 encrypted message is required' };

  const rawAttachment = body.attachmentId;
  const attachmentId = rawAttachment === undefined || rawAttachment === null ? null
    : typeof rawAttachment === 'string' && /^[0-9a-f]{32}$/.test(rawAttachment) ? rawAttachment : undefined;
  if (attachmentId === undefined) return { error: 'attachmentId must be 32 lowercase hex characters' };

  if (kind === 'text') {
    if (attachmentId) return { error: 'Text messages cannot have an attachment' };
    return { kind, text: null, payload: null, replyToId, encrypted, encryptedMediaId: null, attachmentId: null, clientMsgId };
  }
  if (attachmentId) {
    if (!ATTACHMENT_KINDS.has(kind)) return { error: `A ${kind} message cannot have an attachment` };
    return { kind, text: null, payload: null, replyToId, encrypted, encryptedMediaId: null, attachmentId, clientMsgId };
  }
  if (ATTACHMENT_ONLY_KINDS.has(kind)) return { error: `A ${kind} message requires attachmentId` };

  const encryptedMediaId = parseUuid(body.encryptedMediaId);
  if (encryptedMediaId) return { kind, text: null, payload: null, replyToId, encrypted: body.encrypted as IncomingMessage['encrypted'], encryptedMediaId, attachmentId: null, clientMsgId };
  return { error: 'Encrypted media is required for non-text messages' };
};

const canonicalPayloadSql = (alias: string): string => `CASE
  WHEN ${alias}.kind = 'sticker' THEN (
    SELECT json_object(
      'stickerId', CAST(s.id AS TEXT), 'packId', CAST(s.pack_id AS TEXT), 'fileUrl', '/media/' || s.file_path,
      'format', s.format, 'emoji', s.emoji, 'w', s.w, 'h', s.h
    )
    FROM stickers s
    WHERE CAST(s.id AS TEXT) = json_extract(${alias}.payload, '$.stickerId')
  )
  WHEN ${alias}.kind = 'gif' THEN (
    SELECT json_object(
      'gifId', CAST(g.id AS TEXT), 'mp4Url', '/media/' || g.mp4_path,
      'w', g.w, 'h', g.h, 'durationMs', g.duration_ms
    )
    FROM gifs g
    WHERE CAST(g.id AS TEXT) = json_extract(${alias}.payload, '$.gifId')
  )
  WHEN ${alias}.kind = 'photo' THEN NULL
  ELSE ${alias}.payload
END`;

const resolveMediaPayload = async (kind: MessageKind, payload: Record<string, unknown> | null, userId: string): Promise<Record<string, unknown> | null> => {
  if (kind === 'text') return null;
  if (kind === 'sticker') {
    const stickerId = parseId(payload?.stickerId);
    const result = await db.query<{
      id: string; pack_id: string; file_path: string; format: string; emoji: string; w: number; h: number;
    }>(`SELECT s.id, s.pack_id, s.file_path, s.format, s.emoji, s.w, s.h
        FROM stickers s
        JOIN user_sticker_packs up ON up.pack_id = s.pack_id
        WHERE s.id = $1 AND up.user_id = $2`, [stickerId, userId]);
    const sticker = result.rows[0];
    return sticker ? {
      stickerId: sticker.id, packId: sticker.pack_id, fileUrl: `/media/${sticker.file_path}`,
      format: sticker.format, emoji: sticker.emoji, w: sticker.w, h: sticker.h
    } : null;
  }
  if (kind === 'gif') {
    const gifId = parseId(payload?.gifId);
    const result = await db.query<{
      id: string; mp4_path: string; w: number; h: number; duration_ms: number;
    }>(`SELECT g.id, g.mp4_path, g.w, g.h, g.duration_ms
        FROM gifs g
        WHERE g.id = $1
          AND (
            g.owner_id = $2
            OR EXISTS (SELECT 1 FROM saved_gifs sg WHERE sg.gif_id = g.id AND sg.user_id = $2)
            OR EXISTS (
              SELECT 1 FROM messages m
              JOIN chat_members cm ON cm.chat_id = m.chat_id
              WHERE cm.user_id = $2 AND m.deleted_at IS NULL
                AND m.kind = 'gif' AND json_extract(m.payload, '$.gifId') = CAST(g.id AS TEXT)
            )
          )`, [gifId, userId]);
    const gif = result.rows[0];
    return gif ? { gifId: gif.id, mp4Url: `/media/${gif.mp4_path}`, w: gif.w, h: gif.h, durationMs: gif.duration_ms } : null;
  }
  return null;
};

const serializeMessage = (row: MessageRow) => ({
  id: row.id,
  chatId: row.chat_id,
  senderId: row.sender_id,
  kind: row.kind,
  text: row.deleted_at ? null : row.text,
  payload: row.deleted_at ? null : row.payload,
  replyToId: row.reply_to_id,
  createdAt: row.created_at,
  editedAt: row.edited_at,
  deletedAt: row.deleted_at,
  attachmentId: row.deleted_at ? null : row.attachment_id,
  clientMsgId: row.client_msg_id,
  encrypted: row.deleted_at || !row.encryption_version ? null : {
    version: row.encryption_version,
    ...(row.encryption_version === 2 ? { cipherId: row.cipher_id } : {}),
    ...(row.key_version != null ? { keyVersion: row.key_version } : {}),
    nonce: row.nonce,
    ciphertext: row.ciphertext
  },
  sender: {
    id: row.sender_id,
    username: row.sender_username,
    displayName: row.sender_display_name,
    avatarPath: row.sender_avatar_path
  }
});

const messageColumns = `
  m.id, m.chat_id, m.sender_id, m.kind, m.text,
  CASE WHEN m.encryption_version IS NULL THEN ${canonicalPayloadSql('m')} ELSE m.payload END AS payload, m.reply_to_id,
  m.encryption_version, m.nonce, m.ciphertext, m.cipher_id, m.attachment_id, m.client_msg_id, m.key_version,
  m.created_at, m.edited_at, m.deleted_at,
  u.username AS sender_username, u.display_name AS sender_display_name, u.avatar_path AS sender_avatar_path`;

type PublicUserRow = { id: string; username: string; display_name: string; avatar_path: string | null };
const publicUser = (user: PublicUserRow) => ({ id: user.id, username: user.username, displayName: user.display_name, avatarPath: user.avatar_path });

const isChatMember = async (chatId: string, userId: string): Promise<boolean> => {
  const result = await db.query('SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2', [chatId, userId]);
  return result.rowCount === 1;
};

const ensureChatMember = async (chatId: string, userId: string, reply: FastifyReply): Promise<boolean> => {
  if (await isChatMember(chatId, userId)) return true;
  await reply.code(404).send({ error: 'Chat not found' });
  return false;
};

export const registerChatRoutes = async (app: FastifyInstance): Promise<void> => {
  await registerSync(app, { messageColumns, serializeMessage });
  await registerChannelRoutes(app);
  await registerGroupRoutes(app);

  // Only people the caller already shares a chat with (no directory of everyone).
  app.get('/api/users', { preHandler: app.requireUser, config: { rateLimit: CHAT_READ_RATE_LIMIT } }, async (request) => {
    const users = await db.query<PublicUserRow>(
      `SELECT u.id, u.username, u.display_name, u.avatar_path
       FROM users u
       WHERE u.id <> $1
         AND EXISTS (SELECT 1 FROM chat_members a JOIN chat_members b ON b.chat_id = a.chat_id
                     WHERE a.user_id = $1 AND b.user_id = u.id
                       AND NOT EXISTS (SELECT 1 FROM channels ch WHERE ch.chat_id = a.chat_id)
                       AND NOT EXISTS (SELECT 1 FROM groups g WHERE g.chat_id = a.chat_id))
       ORDER BY u.display_name ASC, u.id ASC`,
      [request.user!.id]
    );
    return users.rows.map(publicUser);
  });

  app.get<{ Querystring: { q?: unknown } }>('/api/users/search', { preHandler: app.requireUser, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (typeof request.query.q !== 'string' || request.query.q.length > 100) return reply.code(400).send({ error: 'q is required' });
    const q = request.query.q.trim().replace(/^@/, '').trim().toLowerCase();
    // Too short or not a possible username: nothing matches (no error, so a debounced box can just call it).
    if (q.length < 3 || !/^[a-z0-9_]+$/.test(q)) return [];
    const users = await db.query<PublicUserRow>(
      `SELECT id, username, display_name, avatar_path FROM users
       WHERE id <> $1 AND username LIKE $2 ESCAPE '\\'
       ORDER BY (username = $3) DESC, username ASC LIMIT 20`,
      [request.user!.id, `${q.replace(/[\\_%]/g, '\\$&')}%`, q]
    );
    return users.rows.map(publicUser);
  });

  app.post('/api/chats/saved', { preHandler: app.requireUser, config: { rateLimit: CHAT_WRITE_RATE_LIMIT } }, async (request, reply) => {
    const userId = request.user!.id;
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query<{ chat_id: string }>('SELECT chat_id FROM saved_chats WHERE user_id = $1', [userId]);
      if (existing.rows[0]) {
        await client.query('COMMIT');
        return { id: existing.rows[0].chat_id, created: false };
      }
      const chat = await client.query<{ id: string }>("INSERT INTO chats (type) VALUES ('direct') RETURNING id");
      await client.query('INSERT INTO saved_chats (user_id, chat_id) VALUES ($1, $2)', [userId, chat.rows[0].id]);
      await client.query('INSERT INTO chat_members (chat_id, user_id) VALUES ($1, $2)', [chat.rows[0].id, userId]);
      await client.query('COMMIT');
      return reply.code(201).send({ id: chat.rows[0].id, created: true });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });

  app.post<{ Body: { userId?: unknown } }>('/api/chats', { preHandler: app.requireUser, config: { rateLimit: CHAT_WRITE_RATE_LIMIT } }, async (request, reply) => {
    const peerId = parseId(request.body?.userId);
    if (!peerId || peerId === request.user!.id) {
      return reply.code(400).send({ error: 'userId must identify another user' });
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const peer = await client.query('SELECT id FROM users WHERE id = $1', [peerId]);
      if (peer.rowCount !== 1) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ error: 'User not found' });
      }
      const existing = await client.query<{ id: string }>(
        `SELECT c.id
         FROM chats c
         WHERE c.type = 'direct'
           AND NOT EXISTS (SELECT 1 FROM channels ch WHERE ch.chat_id = c.id)
           AND NOT EXISTS (SELECT 1 FROM saved_chats sv WHERE sv.chat_id = c.id)
           AND NOT EXISTS (SELECT 1 FROM groups gr WHERE gr.chat_id = c.id)
           AND (SELECT count(*) FROM chat_members cm WHERE cm.chat_id = c.id) = 2
           AND EXISTS (SELECT 1 FROM chat_members cm WHERE cm.chat_id = c.id AND cm.user_id = $1)
           AND EXISTS (SELECT 1 FROM chat_members cm WHERE cm.chat_id = c.id AND cm.user_id = $2)
         LIMIT 1`,
        [request.user!.id, peerId]
      );
      if (existing.rows[0]) {
        await client.query('COMMIT');
        return { id: existing.rows[0].id, created: false };
      }

      const chat = await client.query<{ id: string }>("INSERT INTO chats (type) VALUES ('direct') RETURNING id");
      await client.query(
        'INSERT INTO chat_members (chat_id, user_id) VALUES ($1, $2), ($1, $3)',
        [chat.rows[0].id, request.user!.id, peerId]
      );
      await client.query('COMMIT');
      notifyChatNew(app, [peerId], chat.rows[0].id);
      return reply.code(201).send({ id: chat.rows[0].id, created: true });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  app.get('/api/chats', { preHandler: app.requireUser, config: { rateLimit: CHAT_READ_RATE_LIMIT } }, async (request) => {
    const chats = await db.query<{
      id: string;
      type: 'direct' | 'saved' | 'channel' | 'group';
      group_id: string | null;
      group_title: string | null;
      group_avatar: string | null;
      group_role: string | null;
      group_members: number | null;
      created_at: string;
      channel_id: string | null;
      channel_title: string | null;
      channel_avatar: string | null;
      channel_role: string | null;
      channel_members: number | null;
      peer_id: string | null;
      peer_username: string | null;
      peer_display_name: string | null;
      peer_avatar_path: string | null;
      unread_count: string;
      last_message: Record<string, unknown> | null;
    }>(
      `SELECT c.id, CASE WHEN ch.chat_id IS NOT NULL THEN 'channel' WHEN gr.chat_id IS NOT NULL THEN 'group' WHEN sc.chat_id IS NULL THEN c.type ELSE 'saved' END AS type, c.created_at,
              ch.id AS channel_id, ch.title AS channel_title, ch.avatar_path AS channel_avatar, chm.role AS channel_role,
              (SELECT count(*) FROM channel_members x WHERE x.channel_id = ch.id) AS channel_members,
              gr.id AS group_id, gr.title AS group_title, gr.avatar_path AS group_avatar, grm.role AS group_role,
              (SELECT count(*) FROM group_members x WHERE x.group_id = gr.id) AS group_members,
              peer.id AS peer_id, peer.username AS peer_username,
              peer.display_name AS peer_display_name, peer.avatar_path AS peer_avatar_path,
              (SELECT count(*) FROM messages unread
               WHERE unread.chat_id = c.id AND unread.sender_id <> $1
                 AND unread.deleted_at IS NULL
                 AND unread.id > COALESCE(mine.last_read_message_id, 0)) AS unread_count,
              (SELECT json_object(
                 'id', CAST(m.id AS TEXT), 'chatId', CAST(m.chat_id AS TEXT),
                 'senderId', CAST(m.sender_id AS TEXT), 'kind', m.kind,
                 'text', m.text,
                 'payload', CASE WHEN m.encryption_version IS NULL THEN json(${canonicalPayloadSql('m')}) ELSE json(m.payload) END,
                 'encrypted', CASE WHEN m.encryption_version IS NULL THEN NULL ELSE json_object(
                   'version', m.encryption_version, 'cipherId', m.cipher_id, 'keyVersion', m.key_version,
                   'nonce', m.nonce, 'ciphertext', m.ciphertext) END,
                 'replyToId', CASE WHEN m.reply_to_id IS NULL THEN NULL ELSE CAST(m.reply_to_id AS TEXT) END,
                 'createdAt', m.created_at, 'editedAt', m.edited_at
               )
               FROM messages m WHERE m.chat_id = c.id AND m.deleted_at IS NULL
               ORDER BY m.id DESC LIMIT 1) AS last_message
       FROM chat_members mine
       JOIN chats c ON c.id = mine.chat_id
       LEFT JOIN saved_chats sc ON sc.chat_id = c.id
       LEFT JOIN channels ch ON ch.chat_id = c.id
       LEFT JOIN channel_members chm ON chm.channel_id = ch.id AND chm.user_id = $1
       LEFT JOIN groups gr ON gr.chat_id = c.id
       LEFT JOIN group_members grm ON grm.group_id = gr.id AND grm.user_id = $1
       LEFT JOIN chat_members peer_member ON peer_member.chat_id = c.id AND peer_member.user_id <> $1 AND ch.chat_id IS NULL AND gr.chat_id IS NULL
       LEFT JOIN users peer ON peer.id = peer_member.user_id
       WHERE mine.user_id = $1 AND (sc.chat_id IS NOT NULL OR ch.chat_id IS NOT NULL OR gr.chat_id IS NOT NULL OR peer.id IS NOT NULL)
       ORDER BY COALESCE((SELECT m.created_at FROM messages m
                          WHERE m.chat_id = c.id AND m.deleted_at IS NULL
                          ORDER BY m.id DESC LIMIT 1), c.created_at) DESC, c.id DESC`,
      [request.user!.id]
    );
    return chats.rows.map((chat) => ({
      id: chat.id,
      type: chat.type,
      createdAt: chat.created_at,
      ...(chat.type === 'channel' ? {
        channelId: chat.channel_id, title: chat.channel_title, avatarPath: chat.channel_avatar, role: chat.channel_role, memberCount: Number(chat.channel_members)
      } : {}),
      ...(chat.type === 'group' ? {
        groupId: chat.group_id, title: chat.group_title, avatarPath: chat.group_avatar, role: chat.group_role, memberCount: Number(chat.group_members)
      } : {}),
      peer: chat.type === 'saved' || chat.type === 'channel' || chat.type === 'group' || !chat.peer_id ? null : {
        id: chat.peer_id,
        username: chat.peer_username,
        displayName: chat.peer_display_name,
        avatarPath: chat.peer_avatar_path
      },
      unreadCount: Number(chat.unread_count),
      lastMessage: chat.last_message
    }));
  });

  app.get<{ Params: { id: string }; Querystring: { before?: string; limit?: string } }>(
    '/api/chats/:id/messages',
    { preHandler: app.requireUser, config: { rateLimit: CHAT_READ_RATE_LIMIT } },
    async (request, reply) => {
      const chatId = parseId(request.params.id);
      const before = request.query.before === undefined ? null : parseId(request.query.before);
      const limit = parseLimit(request.query.limit);
      if (!chatId || (request.query.before !== undefined && !before) || !limit) {
        return reply.code(400).send({ error: 'Invalid chat id, before, or limit' });
      }
      if (!(await ensureChatMember(chatId, request.user!.id, reply))) return;

      const messages = await db.query<MessageRow>(
        `SELECT ${messageColumns}
         FROM (
           SELECT m.*
           FROM messages m
           WHERE m.chat_id = $1 AND ($2 IS NULL OR m.id < $2)
           ORDER BY m.id DESC
           LIMIT $3
         ) m
         JOIN users u ON u.id = m.sender_id
         ORDER BY m.id ASC`,
        [chatId, before, limit]
      );
      return messages.rows.map(serializeMessage);
    }
  );

  app.post<{ Params: { id: string }; Body: unknown }>('/api/chats/:id/messages', { preHandler: app.requireUser, config: { rateLimit: CHAT_WRITE_RATE_LIMIT } }, async (request, reply) => {
    const chatId = parseId(request.params.id);
    if (!chatId) return reply.code(400).send({ error: 'Invalid chat id' });
    if (!(await ensureChatMember(chatId, request.user!.id, reply))) return;
    if (!(await ensureCanPost(chatId, request.user!.id, reply))) return;
    const incoming = parseIncomingMessage(request.body);
    if ('error' in incoming) return reply.code(400).send({ error: incoming.error });
    const gate = await groupMessageGate(chatId, request.user!.id, 'post', isPlainObject(request.body) ? request.body.keyVersion : undefined, reply);
    if (!gate.ok) return;
    if (incoming.encryptedMediaId) {
      const media = await db.query(
        'SELECT 1 FROM encrypted_chat_media WHERE id = $1 AND chat_id = $2 AND uploader_id = $3',
        [incoming.encryptedMediaId, chatId, request.user!.id]
      );
      if (media.rowCount !== 1) return reply.code(404).send({ error: 'Encrypted media not found' });
    }

    if (incoming.attachmentId) {
      const attachment = await db.query(
        'SELECT 1 FROM attachments WHERE id = $1 AND chat_id = $2 AND uploader_id = $3 AND expired_at IS NULL',
        [incoming.attachmentId, chatId, request.user!.id]
      );
      if (attachment.rowCount !== 1) return reply.code(404).send({ error: 'Attachment not found' });
    }

    if (incoming.replyToId) {
      const replyTarget = await db.query(
        'SELECT 1 FROM messages WHERE id = $1 AND chat_id = $2 AND deleted_at IS NULL',
        [incoming.replyToId, chatId]
      );
      if (replyTarget.rowCount !== 1) return reply.code(400).send({ error: 'replyToId is not a message in this chat' });
    }

    const client = await db.connect();
    let messageId: string;
    let seq: number | null = null;
    let duplicate = false;
    try {
      await client.query('BEGIN');
      // Lookup inside the transaction: the insert trigger rejects a reused cipherId, and concurrent retries are serialized.
      const existing = incoming.clientMsgId ? await client.query<{ id: string; chat_id: string }>(
        'SELECT id, chat_id FROM messages WHERE sender_id = $1 AND client_msg_id = $2', [request.user!.id, incoming.clientMsgId]
      ) : null;
      if (existing?.rows[0]) {
        await client.query('ROLLBACK');
        if (existing.rows[0].chat_id !== chatId) return reply.code(409).send({ error: 'clientMsgId already used in another chat' });
        messageId = existing.rows[0].id;
        duplicate = true;
      } else {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO messages (chat_id, sender_id, kind, text, payload, reply_to_id, encryption_version, cipher_id, nonce, ciphertext, encrypted_media_id, attachment_id, client_msg_id, key_version)
           VALUES ($1, $2, $3, NULL, $4, $5, 2, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [chatId, request.user!.id, incoming.kind, null, incoming.replyToId, incoming.encrypted.cipherId, incoming.encrypted.nonce, incoming.encrypted.ciphertext, incoming.encryptedMediaId, incoming.attachmentId, incoming.clientMsgId, gate.keyVersion]
        );
        if (!inserted.rows[0]) throw new Error('message insert was ignored');
        messageId = inserted.rows[0].id;
        seq = await recordEvent(client, chatId, 'message.new', messageId);
        await client.query('COMMIT');
      }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    const selected = await db.query<MessageRow>(`SELECT ${messageColumns} FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id = $1`, [messageId]);
    const message = serializeMessage(selected.rows[0]);
    if (duplicate) return reply.code(200).send(message);
    app.realtime.broadcastToChat(chatId, { type: 'message.new', chatId, message, seq: seq! });
    return reply.code(201).send(message);
  });

  app.post<{ Params: { id: string }; Body: { messageId?: unknown } }>('/api/chats/:id/read', { preHandler: app.requireUser, config: { rateLimit: CHAT_WRITE_RATE_LIMIT } }, async (request, reply) => {
    const chatId = parseId(request.params.id);
    const messageId = parseId(request.body?.messageId);
    if (!chatId || !messageId) return reply.code(400).send({ error: 'Invalid chat id or messageId' });
    if (!(await ensureChatMember(chatId, request.user!.id, reply))) return;
    const message = await db.query('SELECT 1 FROM messages WHERE id = $1 AND chat_id = $2', [messageId, chatId]);
    if (message.rowCount !== 1) return reply.code(404).send({ error: 'Message not found' });
    await db.query(
      `UPDATE chat_members
       SET last_read_message_id = CASE
         WHEN last_read_message_id IS NULL OR last_read_message_id < $3 THEN $3
         ELSE last_read_message_id
       END
       WHERE chat_id = $1 AND user_id = $2`,
      [chatId, request.user!.id, messageId]
    );
    app.realtime.broadcastToChat(chatId, { type: 'read', chatId, userId: request.user!.id, messageId });
    return reply.code(204).send();
  });

  app.patch<{ Params: { id: string; messageId: string }; Body: unknown }>(
    '/api/chats/:id/messages/:messageId',
    { preHandler: app.requireUser, config: { rateLimit: CHAT_WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const chatId = parseId(request.params.id);
      const messageId = parseId(request.params.messageId);
      const encrypted = isPlainObject(request.body) ? parseEncryptedMessageV2(request.body.encrypted) : null;
      if (!chatId || !messageId || !encrypted) return reply.code(400).send({ error: 'Invalid chat id, message id, or encrypted content' });
      if (!(await ensureChatMember(chatId, request.user!.id, reply))) return;
      if (!(await ensureCanPost(chatId, request.user!.id, reply))) return;
      const gate = await groupMessageGate(chatId, request.user!.id, 'edit', isPlainObject(request.body) ? request.body.keyVersion : undefined, reply);
      if (!gate.ok) return;
      const client = await db.connect();
      let updated: { id: string } | undefined;
      let seq = 0;
      try {
        await client.query('BEGIN');
        updated = (await client.query<{ id: string }>(
        `UPDATE messages
         SET text = NULL, encryption_version = 2, cipher_id = $1, nonce = $2, ciphertext = $3,
             key_version = COALESCE($7, key_version),
             edited_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = $4 AND chat_id = $5 AND sender_id = $6 AND kind = 'text' AND deleted_at IS NULL
         RETURNING id`,
        [encrypted.cipherId, encrypted.nonce, encrypted.ciphertext, messageId, chatId, request.user!.id, gate.keyVersion]
        )).rows[0];
        if (updated) seq = await recordEvent(client, chatId, 'message.edited', updated.id);
        await client.query(updated ? 'COMMIT' : 'ROLLBACK');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
      if (!updated) return reply.code(404).send({ error: 'Editable message not found' });
      const selected = await db.query<MessageRow>(`SELECT ${messageColumns} FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id = $1`, [updated.id]);
      const message = serializeMessage(selected.rows[0]);
      app.realtime.broadcastToChat(chatId, { type: 'message.edited', chatId, message, seq });
      return message;
    }
  );

  app.delete<{ Params: { id: string; messageId: string } }>(
    '/api/chats/:id/messages/:messageId',
    { preHandler: app.requireUser, config: { rateLimit: CHAT_WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const chatId = parseId(request.params.id);
      const messageId = parseId(request.params.messageId);
      if (!chatId || !messageId) return reply.code(400).send({ error: 'Invalid chat id or message id' });
      if (!(await ensureChatMember(chatId, request.user!.id, reply))) return;
      if (!(await ensureCanPost(chatId, request.user!.id, reply))) return;
      const gate = await groupMessageGate(chatId, request.user!.id, 'delete', undefined, reply);
      if (!gate.ok) return;
      const client = await db.connect();
      let deleted: { id: string } | undefined;
      let seq = 0;
      try {
        await client.query('BEGIN');
        deleted = (await client.query<{ id: string }>(
        `UPDATE messages
         SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), text = NULL, payload = NULL,
             encryption_version = NULL, cipher_id = NULL, nonce = NULL, ciphertext = NULL
         WHERE id = $1 AND chat_id = $2 AND (sender_id = $3 OR $4 = 1) AND deleted_at IS NULL
         RETURNING id`,
        [messageId, chatId, request.user!.id, gate.staff ? 1 : 0]
        )).rows[0];
        if (deleted) seq = await recordEvent(client, chatId, 'message.deleted', deleted.id);
        await client.query(deleted ? 'COMMIT' : 'ROLLBACK');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
      if (!deleted) return reply.code(404).send({ error: 'Deletable message not found' });
      const selected = await db.query<MessageRow>(`SELECT ${messageColumns} FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id = $1`, [deleted.id]);
      const message = serializeMessage(selected.rows[0]);
      app.realtime.broadcastToChat(chatId, { type: 'message.deleted', chatId, message, seq });
      return message;
    }
  );
};
