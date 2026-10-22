import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { wrapChannelKey, unwrapChannelKey } from './channelKeys.js';
import { db, type DbClient } from './db.js';

// Private channels (os-8). See docs/CHANNELS.md. Channel code lives here; chats.ts only has small hooks.
type Role = 'owner' | 'admin' | 'member';
const READ = { max: 240, timeWindow: '1 minute' } as const;
const WRITE = { max: 60, timeWindow: '1 minute' } as const;
const JOIN = { max: 30, timeWindow: '1 minute' } as const;
const MAX_CHANNELS_PER_OWNER = 50;
const MAX_INVITES = 20;
const MAX_MEMBERS = 10_000;

const parseId = (value: unknown): string | null => {
  const text = typeof value === 'number' ? String(value) : value;
  return typeof text === 'string' && /^[1-9]\d*$/.test(text) ? text : null;
};
const parseTitle = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const title = value.normalize('NFC').replace(/\s+/g, ' ').trim();
  return title.length >= 1 && title.length <= 80 && !/(?![\u200C\u200D])\p{C}/u.test(title) ? title : null;
};
const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

// Server-held channel key (NOT end-to-end: the server can unwrap it).

/** Role of this user in the chat if it is a channel; null when the chat is not a channel (or user is not in it). */
export const channelRoleForChat = async (chatId: string, userId: string, q: Pick<DbClient, 'query'> = db): Promise<Role | null | 'none'> => {
  const row = await q.query<{ role: Role | null }>(
    `SELECT cm.role FROM channels c LEFT JOIN channel_members cm ON cm.channel_id = c.id AND cm.user_id = $2 WHERE c.chat_id = $1`,
    [chatId, userId]
  );
  if (!row.rows[0]) return 'none'; // not a channel chat
  return row.rows[0].role;
};

/** The refusal (status + body) when the chat is a channel and the caller may not post; null when posting is allowed. */
export const postRefusal = async (chatId: string, userId: string, q: Pick<DbClient, 'query'> = db): Promise<{ status: number; body: { error: string } } | null> => {
  const role = await channelRoleForChat(chatId, userId, q);
  if (role === 'none' || role === 'owner' || role === 'admin') return null;
  if (role === null) return { status: 404, body: { error: 'Chat not found' } };
  return { status: 403, body: { error: 'Only channel owners and admins can post' } };
};

/** Hook for message routes: false (and a reply sent) when the chat is a channel and the caller may not post. */
export const ensureCanPost = async (chatId: string, userId: string, reply: FastifyReply): Promise<boolean> => {
  const refusal = await postRefusal(chatId, userId);
  if (!refusal) return true;
  await reply.code(refusal.status).send(refusal.body);
  return false;
};

type ChannelRow = { id: string; chat_id: string; owner_id: string; title: string; avatar_path: string | null; role: Role };

const getMine = async (channelId: string, userId: string): Promise<ChannelRow | null> => {
  const result = await db.query<ChannelRow>(
    `SELECT c.id, c.chat_id, c.owner_id, c.title, c.avatar_path, cm.role
     FROM channels c JOIN channel_members cm ON cm.channel_id = c.id AND cm.user_id = $2 WHERE c.id = $1`,
    [channelId, userId]
  );
  return result.rows[0] ?? null;
};

const memberCount = async (channelId: string): Promise<number> =>
  Number((await db.query<{ n: number }>('SELECT count(*) AS n FROM channel_members WHERE channel_id = $1', [channelId])).rows[0].n);

const removeMember = async (channel: { id: string; chat_id: string }, userId: string, bannedBy: string | null = null): Promise<void> => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM channel_members WHERE channel_id = $1 AND user_id = $2', [channel.id, userId]);
    await client.query('DELETE FROM chat_members WHERE chat_id = $1 AND user_id = $2', [channel.chat_id, userId]);
    if (bannedBy) await client.query('INSERT OR REPLACE INTO channel_bans (channel_id, user_id, banned_by) VALUES ($1, $2, $3)', [channel.id, userId, bannedBy]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
};

export const registerChannelRoutes = async (app: FastifyInstance): Promise<void> => {
  // A channel the caller is not in is indistinguishable from one that does not exist.
  const mine = async (idParam: unknown, userId: string, reply: FastifyReply): Promise<ChannelRow | null> => {
    const id = parseId(idParam);
    const channel = id ? await getMine(id, userId) : null;
    if (!channel) { await reply.code(404).send({ error: 'Channel not found' }); return null; }
    return channel;
  };
  const staff = (channel: ChannelRow): boolean => channel.role === 'owner' || channel.role === 'admin';

  app.post<{ Body: { title?: unknown } }>('/api/channels', { preHandler: app.requireUser, config: { rateLimit: WRITE } }, async (request, reply) => {
    const title = parseTitle(request.body?.title);
    if (!title) return reply.code(400).send({ error: 'title must be 1-80 characters' });
    const userId = request.user!.id;
    const owned = await db.query<{ n: number }>('SELECT count(*) AS n FROM channels WHERE owner_id = $1', [userId]);
    if (Number(owned.rows[0].n) >= MAX_CHANNELS_PER_OWNER) return reply.code(409).send({ error: 'Too many channels' });
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const chat = await client.query<{ id: string }>("INSERT INTO chats (type) VALUES ('direct') RETURNING id");
      const channelKey = wrapChannelKey(randomBytes(32));
      const channel = await client.query<{ id: string }>(
        'INSERT INTO channels (chat_id, owner_id, title, key_id, key_wrapped) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [chat.rows[0].id, userId, title, channelKey.keyId, channelKey.wrapped]
      );
      await client.query('INSERT INTO chat_members (chat_id, user_id) VALUES ($1, $2)', [chat.rows[0].id, userId]);
      await client.query("INSERT INTO channel_members (channel_id, user_id, role) VALUES ($1, $2, 'owner')", [channel.rows[0].id, userId]);
      await client.query('COMMIT');
      return reply.code(201).send({ id: channel.rows[0].id, chatId: chat.rows[0].id });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });

  app.get<{ Params: { id: string } }>('/api/channels/:id', { preHandler: app.requireUser, config: { rateLimit: READ } }, async (request, reply) => {
    const channel = await mine(request.params.id, request.user!.id, reply);
    if (!channel) return;
    const body: Record<string, unknown> = {
      id: channel.id, chatId: channel.chat_id, title: channel.title, avatarPath: channel.avatar_path,
      role: channel.role, memberCount: await memberCount(channel.id)
    };
    if (staff(channel)) {
      const members = await db.query<{ id: string; username: string; display_name: string; role: Role }>(
        `SELECT u.id, u.username, u.display_name, cm.role FROM channel_members cm JOIN users u ON u.id = cm.user_id
         WHERE cm.channel_id = $1 ORDER BY CASE cm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.display_name, u.id LIMIT 1000`,
        [channel.id]
      );
      body.members = members.rows.map((m) => ({ id: m.id, username: m.username, displayName: m.display_name, role: m.role }));
    }
    if (channel.role === 'owner') {
      const invites = await db.query<{ id: string; created_at: string }>(
        'SELECT id, created_at FROM channel_invites WHERE channel_id = $1 AND revoked_at IS NULL ORDER BY id DESC', [channel.id]
      );
      body.invites = invites.rows.map((i) => ({ id: i.id, createdAt: i.created_at }));
      const bans = await db.query<{ id: string; username: string; display_name: string }>(
        'SELECT u.id, u.username, u.display_name FROM channel_bans b JOIN users u ON u.id = b.user_id WHERE b.channel_id = $1 ORDER BY b.banned_at DESC LIMIT 200', [channel.id]
      );
      body.bans = bans.rows.map((b) => ({ id: b.id, username: b.username, displayName: b.display_name }));
    }
    return body;
  });

  app.patch<{ Params: { id: string }; Body: { title?: unknown; avatarPath?: unknown } }>('/api/channels/:id', { preHandler: app.requireUser, config: { rateLimit: WRITE } }, async (request, reply) => {
    const channel = await mine(request.params.id, request.user!.id, reply);
    if (!channel) return;
    if (channel.role !== 'owner') return reply.code(403).send({ error: 'Only the owner can edit the channel' });
    const body = request.body ?? {};
    let title = channel.title;
    let avatar = channel.avatar_path;
    if (body.title !== undefined) {
      const parsed = parseTitle(body.title);
      if (!parsed) return reply.code(400).send({ error: 'title must be 1-80 characters' });
      title = parsed;
    }
    if (body.avatarPath !== undefined) {
      if (body.avatarPath === null) avatar = null;
      else if (typeof body.avatarPath === 'string' && body.avatarPath.length <= 200 && /^[A-Za-z0-9_./-]+$/.test(body.avatarPath) && !body.avatarPath.includes('..')) avatar = body.avatarPath;
      else return reply.code(400).send({ error: 'Invalid avatarPath' });
    }
    await db.query('UPDATE channels SET title = $1, avatar_path = $2 WHERE id = $3', [title, avatar, channel.id]);
    return { id: channel.id, title, avatarPath: avatar };
  });

  app.delete<{ Params: { id: string } }>('/api/channels/:id', { preHandler: app.requireUser, config: { rateLimit: WRITE } }, async (request, reply) => {
    const channel = await mine(request.params.id, request.user!.id, reply);
    if (!channel) return;
    if (channel.role !== 'owner') return reply.code(403).send({ error: 'Only the owner can delete the channel' });
    // Deleting the chat row cascades to the channel, members, invites, messages and attachments rows.
    await db.query('DELETE FROM chats WHERE id = $1', [channel.chat_id]);
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string } }>('/api/channels/:id/key', { preHandler: app.requireUser, config: { rateLimit: READ } }, async (request, reply) => {
    const channel = await mine(request.params.id, request.user!.id, reply);
    if (!channel) return;
    const row = await db.query<{ key_id: string; key_wrapped: string }>('SELECT key_id, key_wrapped FROM channels WHERE id = $1', [channel.id]);
    reply.header('Cache-Control', 'no-store');
    return { version: 1, key: unwrapChannelKey(row.rows[0].key_id, row.rows[0].key_wrapped).toString('base64url') };
  });

  app.post<{ Params: { id: string } }>('/api/channels/:id/invites', { preHandler: app.requireUser, config: { rateLimit: WRITE } }, async (request, reply) => {
    const channel = await mine(request.params.id, request.user!.id, reply);
    if (!channel) return;
    if (channel.role !== 'owner') return reply.code(403).send({ error: 'Only the owner can create invite links' });
    const active = await db.query<{ n: number }>('SELECT count(*) AS n FROM channel_invites WHERE channel_id = $1 AND revoked_at IS NULL', [channel.id]);
    if (Number(active.rows[0].n) >= MAX_INVITES) return reply.code(409).send({ error: 'Too many active invite links' });
    const token = randomBytes(24).toString('base64url');
    const inserted = await db.query<{ id: string }>(
      'INSERT INTO channel_invites (channel_id, token_hash, created_by) VALUES ($1, $2, $3) RETURNING id',
      [channel.id, hashToken(token), request.user!.id]
    );
    return reply.code(201).send({ id: inserted.rows[0].id, token });
  });

  app.delete<{ Params: { id: string; invId: string } }>('/api/channels/:id/invites/:invId', { preHandler: app.requireUser, config: { rateLimit: WRITE } }, async (request, reply) => {
    const channel = await mine(request.params.id, request.user!.id, reply);
    if (!channel) return;
    if (channel.role !== 'owner') return reply.code(403).send({ error: 'Only the owner can revoke invite links' });
    const invId = parseId(request.params.invId);
    const revoked = invId ? await db.query(
      "UPDATE channel_invites SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = $1 AND channel_id = $2 AND revoked_at IS NULL RETURNING id",
      [invId, channel.id]
    ) : null;
    if (!revoked || revoked.rowCount !== 1) return reply.code(404).send({ error: 'Invite not found' });
    return reply.code(204).send();
  });

  const byToken = async (token: unknown): Promise<{ id: string; chat_id: string; title: string } | null> => {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
    const result = await db.query<{ id: string; chat_id: string; title: string }>(
      `SELECT c.id, c.chat_id, c.title FROM channel_invites i JOIN channels c ON c.id = i.channel_id
       WHERE i.token_hash = $1 AND i.revoked_at IS NULL`,
      [hashToken(token)]
    );
    return result.rows[0] ?? null;
  };

  app.get<{ Params: { token: string } }>('/api/channels/join/:token', { preHandler: app.requireUser, config: { rateLimit: JOIN } }, async (request, reply) => {
    const channel = await byToken(request.params.token);
    if (!channel) return reply.code(404).send({ error: 'Invite not found' });
    return { title: channel.title, memberCount: await memberCount(channel.id) };
  });

  app.post<{ Params: { token: string } }>('/api/channels/join/:token', { preHandler: app.requireUser, config: { rateLimit: JOIN } }, async (request, reply) => {
    const channel = await byToken(request.params.token);
    if (!channel) return reply.code(404).send({ error: 'Invite not found' });
    const userId = request.user!.id;
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const already = await client.query('SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2', [channel.id, userId]);
      if (already.rowCount === 0) {
        const banned = await client.query('SELECT 1 FROM channel_bans WHERE channel_id = $1 AND user_id = $2', [channel.id, userId]);
        if (banned.rowCount === 1) {
          await client.query('ROLLBACK');
          return reply.code(403).send({ error: 'You were removed from this channel' });
        }
        const count = await client.query<{ n: number }>('SELECT count(*) AS n FROM channel_members WHERE channel_id = $1', [channel.id]);
        if (Number(count.rows[0].n) >= MAX_MEMBERS) {
          await client.query('ROLLBACK');
          return reply.code(409).send({ error: 'Channel is full' });
        }
        await client.query("INSERT INTO channel_members (channel_id, user_id, role) VALUES ($1, $2, 'member')", [channel.id, userId]);
        await client.query('INSERT OR IGNORE INTO chat_members (chat_id, user_id) VALUES ($1, $2)', [channel.chat_id, userId]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return { id: channel.id, chatId: channel.chat_id };
  });

  app.post<{ Params: { id: string } }>('/api/channels/:id/leave', { preHandler: app.requireUser, config: { rateLimit: WRITE } }, async (request, reply) => {
    const channel = await mine(request.params.id, request.user!.id, reply);
    if (!channel) return;
    if (channel.role === 'owner') return reply.code(409).send({ error: 'The owner cannot leave; delete the channel instead' });
    await removeMember(channel, request.user!.id);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string; userId: string } }>('/api/channels/:id/admins/:userId', { preHandler: app.requireUser, config: { rateLimit: WRITE } }, async (request, reply) => {
    const channel = await mine(request.params.id, request.user!.id, reply);
    if (!channel) return;
    if (channel.role !== 'owner') return reply.code(403).send({ error: 'Only the owner can manage admins' });
    const target = parseId(request.params.userId);
    const updated = target ? await db.query(
      "UPDATE channel_members SET role = 'admin' WHERE channel_id = $1 AND user_id = $2 AND role = 'member' RETURNING user_id", [channel.id, target]
    ) : null;
    if (!updated || updated.rowCount !== 1) {
      const existing = target ? await db.query("SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2 AND role = 'admin'", [channel.id, target]) : null;
      if (existing?.rowCount === 1) return reply.code(204).send();
      return reply.code(404).send({ error: 'Member not found' });
    }
    return reply.code(204).send();
  });

  app.delete<{ Params: { id: string; userId: string } }>('/api/channels/:id/admins/:userId', { preHandler: app.requireUser, config: { rateLimit: WRITE } }, async (request, reply) => {
    const channel = await mine(request.params.id, request.user!.id, reply);
    if (!channel) return;
    if (channel.role !== 'owner') return reply.code(403).send({ error: 'Only the owner can manage admins' });
    const target = parseId(request.params.userId);
    const updated = target ? await db.query(
      "UPDATE channel_members SET role = 'member' WHERE channel_id = $1 AND user_id = $2 AND role = 'admin' RETURNING user_id", [channel.id, target]
    ) : null;
    if (!updated || updated.rowCount !== 1) return reply.code(404).send({ error: 'Admin not found' });
    return reply.code(204).send();
  });

  app.delete<{ Params: { id: string; userId: string } }>('/api/channels/:id/members/:userId', { preHandler: app.requireUser, config: { rateLimit: WRITE } }, async (request, reply) => {
    const channel = await mine(request.params.id, request.user!.id, reply);
    if (!channel) return;
    if (channel.role !== 'owner') return reply.code(403).send({ error: 'Only the owner can remove members' });
    const target = parseId(request.params.userId);
    if (!target) return reply.code(404).send({ error: 'Member not found' });
    if (target === channel.owner_id) return reply.code(409).send({ error: 'The owner cannot be removed' });
    const member = await db.query('SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2', [channel.id, target]);
    if (member.rowCount !== 1) return reply.code(404).send({ error: 'Member not found' });
    await removeMember(channel, target, request.user!.id); // removed by the owner = banned from rejoining via invite links
    return reply.code(204).send();
  });

  app.delete<{ Params: { id: string; userId: string } }>('/api/channels/:id/bans/:userId', { preHandler: app.requireUser, config: { rateLimit: WRITE } }, async (request, reply) => {
    const channel = await mine(request.params.id, request.user!.id, reply);
    if (!channel) return;
    if (channel.role !== 'owner') return reply.code(403).send({ error: 'Only the owner can lift a ban' });
    const target = parseId(request.params.userId);
    const lifted = target ? await db.query('DELETE FROM channel_bans WHERE channel_id = $1 AND user_id = $2', [channel.id, target]) : null;
    return lifted?.rowCount === 1 ? reply.code(204).send() : reply.code(404).send({ error: 'Ban not found' });
  });
};
