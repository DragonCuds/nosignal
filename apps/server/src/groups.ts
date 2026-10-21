import type { FastifyInstance, FastifyReply } from 'fastify';
import { db } from './db.js';

// End-to-end encrypted groups (gr-1). See docs/GROUPS.md. A group is an ordinary 'direct' chat row linked in
// `groups`; members are in chat_members (messages/sync/realtime/media unchanged) and group_members (role).
// The server stores only per-member wrapped key envelopes; it never sees a group key or plaintext.
type Role = 'owner' | 'admin' | 'member';
const READ = { max: 240, timeWindow: '1 minute' } as const;
const WRITE = { max: 60, timeWindow: '1 minute' } as const;
const MAX_MEMBERS = 100;
const MAX_GROUPS_PER_OWNER = 50;

const parseId = (value: unknown): string | null => {
  const text = typeof value === 'number' ? String(value) : value;
  return typeof text === 'string' && /^[1-9]\d*$/.test(text) ? text : null;
};
const parseTitle = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const title = value.normalize('NFC').replace(/\s+/g, ' ').trim();
  return title.length >= 1 && title.length <= 80 && !/(?![\u200C\u200D])\p{C}/u.test(title) ? title : null;
};
const parseWrapped = (value: unknown): string | null =>
  typeof value === 'string' && value.length >= 16 && value.length <= 2048 && /^[A-Za-z0-9_-]+$/.test(value) ? value : null;
const parseVersion = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 1_000_000 ? value : null;

type GroupRow = {
  id: string; chat_id: string; title: string; avatar_path: string | null; created_by: string;
  key_version: number; pending_version: number | null; role: Role;
};

const getMine = async (groupId: string, userId: string): Promise<GroupRow | null> => {
  const result = await db.query<GroupRow>(
    `SELECT g.id, g.chat_id, g.title, g.avatar_path, g.created_by, g.key_version, g.pending_version, gm.role
     FROM groups g JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = $2 WHERE g.id = $1`,
    [groupId, userId]
  );
  return result.rows[0] ?? null;
};

const memberCount = async (groupId: string): Promise<number> =>
  Number((await db.query<{ n: number }>('SELECT count(*) AS n FROM group_members WHERE group_id = $1', [groupId])).rows[0].n);

const identityOf = async (userId: string): Promise<boolean> =>
  (await db.query('SELECT 1 FROM user_crypto_identities WHERE user_id = $1', [userId])).rowCount === 1;

/**
 * Hook for the message routes. Non-group chats pass straight through ({ok:true, keyVersion:null}).
 * In a group: posting/editing needs the CURRENT key version and no pending rotation; deleting is allowed for the
 * sender or an owner/admin (`staff`). A reply has been sent when ok is false.
 */
export const groupMessageGate = async (
  chatId: string, userId: string, action: 'post' | 'edit' | 'delete', keyVersion: unknown, reply: FastifyReply
): Promise<{ ok: true; keyVersion: number | null; staff: boolean } | { ok: false }> => {
  const row = await db.query<{ key_version: number; pending_version: number | null; role: Role | null }>(
    `SELECT g.key_version, g.pending_version, gm.role FROM groups g
     LEFT JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = $2 WHERE g.chat_id = $1`,
    [chatId, userId]
  );
  const group = row.rows[0];
  if (!group) return { ok: true, keyVersion: null, staff: false };
  if (!group.role) { await reply.code(404).send({ error: 'Chat not found' }); return { ok: false }; }
  if (action === 'delete') return { ok: true, keyVersion: null, staff: group.role === 'owner' || group.role === 'admin' };
  if (group.key_version < 1 || group.pending_version !== null) {
    await reply.code(409).send({ error: 'Group key rotation pending; an admin must open the group first' });
    return { ok: false };
  }
  if (keyVersion !== group.key_version) {
    await reply.code(400).send({ error: `keyVersion must be the current group key version (${group.key_version})`, keyVersion: group.key_version });
    return { ok: false };
  }
  return { ok: true, keyVersion: group.key_version, staff: false };
};

// Remove a member and mark the key as needing rotation (they know the current key).
const removeMember = async (group: GroupRow, userId: string): Promise<void> => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM group_members WHERE group_id = $1 AND user_id = $2', [group.id, userId]);
    await client.query('DELETE FROM chat_members WHERE chat_id = $1 AND user_id = $2', [group.chat_id, userId]);
    await client.query('DELETE FROM group_key_envelopes WHERE group_id = $1 AND user_id = $2', [group.id, userId]);
    await client.query('UPDATE groups SET pending_version = COALESCE(pending_version, key_version + 1) WHERE id = $1', [group.id]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
};

export const registerGroupRoutes = async (app: FastifyInstance): Promise<void> => {
  // A group the caller is not in is indistinguishable from one that does not exist.
  const mine = async (idParam: unknown, userId: string, reply: FastifyReply): Promise<GroupRow | null> => {
    const id = parseId(idParam);
    const group = id ? await getMine(id, userId) : null;
    if (!group) { await reply.code(404).send({ error: 'Group not found' }); return null; }
    return group;
  };
  const staff = (group: GroupRow): boolean => group.role === 'owner' || group.role === 'admin';

  app.post<{ Body: { title?: unknown; memberIds?: unknown; envelopes?: unknown } }>('/api/groups', { preHandler: app.requireUser, config: { rateLimit: WRITE } }, async (request, reply) => {
    const title = parseTitle(request.body?.title);
    if (!title) return reply.code(400).send({ error: 'title must be 1-80 characters' });
    const userId = request.user!.id;
    const raw = request.body?.memberIds;
    if (!Array.isArray(raw) || raw.length > MAX_MEMBERS * 2) return reply.code(400).send({ error: 'memberIds must be an array of user ids' });
    const others = new Set<string>();
    for (const item of raw) {
      const id = parseId(item);
      if (!id) return reply.code(400).send({ error: 'memberIds must be an array of user ids' });
      if (id !== userId) others.add(id);
    }
    if (others.size < 1) return reply.code(400).send({ error: 'Pick at least one other member' });
    if (others.size + 1 > MAX_MEMBERS) return reply.code(409).send({ error: `A group has at most ${MAX_MEMBERS} members` });
    const all = [userId, ...others];
    for (const id of all) {
      if (!(await identityOf(id))) return reply.code(409).send({ error: 'Every member needs an encryption identity', userId: id });
    }
    const exists = await db.query<{ n: number }>(`SELECT count(*) AS n FROM users WHERE id IN (${all.map((_, i) => `$${i + 1}`).join(',')})`, all);
    if (Number(exists.rows[0].n) !== all.length) return reply.code(404).send({ error: 'User not found' });
    const owned = await db.query<{ n: number }>('SELECT count(*) AS n FROM group_members WHERE user_id = $1 AND role = \'owner\'', [userId]);
    if (Number(owned.rows[0].n) >= MAX_GROUPS_PER_OWNER) return reply.code(409).send({ error: 'Too many groups' });

    // Optional: the creator's client may upload version-1 envelopes right away (must cover every member).
    let envelopes: { userId: string; wrapped: string }[] | null = null;
    if (request.body?.envelopes !== undefined) {
      const parsed = parseEnvelopes(request.body.envelopes, all);
      if (!parsed) return reply.code(400).send({ error: 'envelopes must contain one wrapped key for every member' });
      envelopes = parsed;
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const chat = await client.query<{ id: string }>("INSERT INTO chats (type) VALUES ('direct') RETURNING id");
      const group = await client.query<{ id: string }>(
        'INSERT INTO groups (chat_id, title, created_by, key_version, pending_version) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [chat.rows[0].id, title, userId, envelopes ? 1 : 0, envelopes ? null : 1]
      );
      for (const id of all) {
        await client.query('INSERT INTO chat_members (chat_id, user_id) VALUES ($1, $2)', [chat.rows[0].id, id]);
        await client.query('INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, $3)', [group.rows[0].id, id, id === userId ? 'owner' : 'member']);
      }
      for (const envelope of envelopes ?? []) {
        await client.query('INSERT INTO group_key_envelopes (group_id, version, user_id, wrapped, wrapped_by) VALUES ($1, 1, $2, $3, $4)', [group.rows[0].id, envelope.userId, envelope.wrapped, userId]);
      }
      await client.query('COMMIT');
      return reply.code(201).send({ id: group.rows[0].id, chatId: chat.rows[0].id });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });

  // Exactly one wrapped key per expected user id; no extras, no duplicates.
  const parseEnvelopes = (value: unknown, expected: string[]): { userId: string; wrapped: string }[] | null => {
    if (!Array.isArray(value) || value.length !== expected.length) return null;
    const seen = new Set<string>();
    const out: { userId: string; wrapped: string }[] = [];
    for (const item of value) {
      if (typeof item !== 'object' || item === null) return null;
      const userId = parseId((item as { userId?: unknown }).userId);
      const wrapped = parseWrapped((item as { wrapped?: unknown }).wrapped);
      if (!userId || !wrapped || seen.has(userId) || !expected.includes(userId)) return null;
      seen.add(userId);
      out.push({ userId, wrapped });
    }
    return out;
  };

  app.get<{ Params: { id: string } }>('/api/groups/:id', { preHandler: app.requireUser, config: { rateLimit: READ } }, async (request, reply) => {
    const group = await mine(request.params.id, request.user!.id, reply);
    if (!group) return;
    const members = await db.query<{ id: string; username: string; display_name: string; role: Role; public_jwk: unknown }>(
      `SELECT u.id, u.username, u.display_name, gm.role, ci.public_jwk
       FROM group_members gm JOIN users u ON u.id = gm.user_id LEFT JOIN user_crypto_identities ci ON ci.user_id = u.id
       WHERE gm.group_id = $1 ORDER BY CASE gm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.display_name, u.id LIMIT ${MAX_MEMBERS}`,
      [group.id]
    );
    return {
      id: group.id, chatId: group.chat_id, title: group.title, avatarPath: group.avatar_path, role: group.role,
      memberCount: members.rows.length, keyVersion: group.key_version,
      // Set (to the version to upload) while a rotation is required; only owners/admins can act on it.
      pendingKeyVersion: group.pending_version,
      members: members.rows.map((m) => ({ id: m.id, username: m.username, displayName: m.display_name, role: m.role, publicKey: m.public_jwk ?? null }))
    };
  });

  app.patch<{ Params: { id: string }; Body: { title?: unknown } }>('/api/groups/:id', { preHandler: app.requireUser, config: { rateLimit: WRITE } }, async (request, reply) => {
    const group = await mine(request.params.id, request.user!.id, reply);
    if (!group) return;
    if (!staff(group)) return reply.code(403).send({ error: 'Only owners and admins can rename the group' });
    const title = parseTitle(request.body?.title);
    if (!title) return reply.code(400).send({ error: 'title must be 1-80 characters' });
    await db.query('UPDATE groups SET title = $1 WHERE id = $2', [title, group.id]);
    return { id: group.id, title };
  });

  app.delete<{ Params: { id: string } }>('/api/groups/:id', { preHandler: app.requireUser, config: { rateLimit: WRITE } }, async (request, reply) => {
    const group = await mine(request.params.id, request.user!.id, reply);
    if (!group) return;
    if (group.role !== 'owner') return reply.code(403).send({ error: 'Only the owner can delete the group' });
    // Deleting the chat row cascades to the group, members, envelopes, messages and attachments rows.
    await db.query('DELETE FROM chats WHERE id = $1', [group.chat_id]);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>('/api/groups/:id/leave', { preHandler: app.requireUser, config: { rateLimit: WRITE } }, async (request, reply) => {
    const group = await mine(request.params.id, request.user!.id, reply);
    if (!group) return;
    if (group.role === 'owner') return reply.code(409).send({ error: 'The owner must transfer ownership or delete the group' });
    await removeMember(group, request.user!.id);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string }; Body: { userId?: unknown; envelope?: unknown } }>('/api/groups/:id/members', { preHandler: app.requireUser, config: { rateLimit: WRITE } }, async (request, reply) => {
    const group = await mine(request.params.id, request.user!.id, reply);
    if (!group) return;
    if (!staff(group)) return reply.code(403).send({ error: 'Only owners and admins can add members' });
    const target = parseId(request.body?.userId);
    const wrapped = parseWrapped(request.body?.envelope);
    if (!target || !wrapped) return reply.code(400).send({ error: 'userId and envelope are required' });
    if (group.key_version < 1 || group.pending_version !== null) return reply.code(409).send({ error: 'Group key rotation pending; upload the new key first' });
    if ((await db.query('SELECT 1 FROM users WHERE id = $1', [target])).rowCount !== 1) return reply.code(404).send({ error: 'User not found' });
    if (!(await identityOf(target))) return reply.code(409).send({ error: 'That user has no encryption identity yet' });
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      if ((await client.query('SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2', [group.id, target])).rowCount === 1) {
        await client.query('ROLLBACK');
        return reply.code(409).send({ error: 'Already a member' });
      }
      const count = await client.query<{ n: number }>('SELECT count(*) AS n FROM group_members WHERE group_id = $1', [group.id]);
      if (Number(count.rows[0].n) >= MAX_MEMBERS) {
        await client.query('ROLLBACK');
        return reply.code(409).send({ error: `A group has at most ${MAX_MEMBERS} members` });
      }
      await client.query("INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, 'member')", [group.id, target]);
      await client.query('INSERT OR IGNORE INTO chat_members (chat_id, user_id) VALUES ($1, $2)', [group.chat_id, target]);
      // Only the CURRENT key version: the new member cannot read older messages.
      await client.query('INSERT INTO group_key_envelopes (group_id, version, user_id, wrapped, wrapped_by) VALUES ($1, $2, $3, $4, $5)', [group.id, group.key_version, target, wrapped, request.user!.id]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return reply.code(204).send();
  });

  app.delete<{ Params: { id: string; userId: string } }>('/api/groups/:id/members/:userId', { preHandler: app.requireUser, config: { rateLimit: WRITE } }, async (request, reply) => {
    const group = await mine(request.params.id, request.user!.id, reply);
    if (!group) return;
    const target = parseId(request.params.userId);
    if (!target) return reply.code(404).send({ error: 'Member not found' });
    if (target === request.user!.id) {
      if (group.role === 'owner') return reply.code(409).send({ error: 'The owner must transfer ownership or delete the group' });
      await removeMember(group, target);
      return reply.code(204).send();
    }
    if (!staff(group)) return reply.code(403).send({ error: 'Only owners and admins can remove members' });
    const row = await db.query<{ role: Role }>('SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2', [group.id, target]);
    if (!row.rows[0]) return reply.code(404).send({ error: 'Member not found' });
    if (row.rows[0].role === 'owner') return reply.code(409).send({ error: 'The owner cannot be removed' });
    if (row.rows[0].role === 'admin' && group.role !== 'owner') return reply.code(403).send({ error: 'Only the owner can remove an admin' });
    await removeMember(group, target);
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string }; Querystring: { version?: unknown } }>('/api/groups/:id/keys', { preHandler: app.requireUser, config: { rateLimit: READ } }, async (request, reply) => {
    const group = await mine(request.params.id, request.user!.id, reply);
    if (!group) return;
    const raw = request.query.version;
    let version: number | 'latest' | null = null;
    if (raw !== undefined) {
      if (raw === 'latest') version = 'latest';
      else if (typeof raw === 'string' && /^[1-9]\d{0,6}$/.test(raw)) version = Number(raw);
      else return reply.code(400).send({ error: 'version must be a number or latest' });
    }
    const rows = await db.query<{ version: number; wrapped: string; wrapped_by: string }>(
      `SELECT version, wrapped, CAST(wrapped_by AS TEXT) AS wrapped_by FROM group_key_envelopes WHERE group_id = $1 AND user_id = $2
       AND ($3 IS NULL OR version = $3) ORDER BY version ${version === 'latest' ? 'DESC LIMIT 1' : 'ASC'}`,
      [group.id, request.user!.id, typeof version === 'number' ? version : null]
    );
    reply.header('Cache-Control', 'no-store');
    return rows.rows.map((r) => ({ version: r.version, wrapped: r.wrapped, wrappedBy: r.wrapped_by }));
  });

  app.put<{ Params: { id: string }; Body: { version?: unknown; envelopes?: unknown } }>('/api/groups/:id/keys', { preHandler: app.requireUser, config: { rateLimit: WRITE } }, async (request, reply) => {
    const group = await mine(request.params.id, request.user!.id, reply);
    if (!group) return;
    if (!staff(group)) return reply.code(403).send({ error: 'Only owners and admins can rotate the key' });
    const version = parseVersion(request.body?.version);
    if (!version) return reply.code(400).send({ error: 'version must be a positive integer' });
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      // Re-read inside the transaction: members/pending may have changed since the first read.
      const fresh = await client.query<{ key_version: number; pending_version: number | null }>('SELECT key_version, pending_version FROM groups WHERE id = $1', [group.id]);
      const current = fresh.rows[0];
      if (version !== current.pending_version && version !== current.key_version + 1) {
        await client.query('ROLLBACK');
        return reply.code(409).send({ error: 'Wrong key version', keyVersion: current.key_version, pendingKeyVersion: current.pending_version });
      }
      const members = (await client.query<{ user_id: string }>('SELECT user_id FROM group_members WHERE group_id = $1', [group.id])).rows.map((r) => r.user_id);
      const envelopes = parseEnvelopes(request.body?.envelopes, members);
      if (!envelopes) {
        await client.query('ROLLBACK');
        return reply.code(400).send({ error: 'envelopes must contain one wrapped key for every current member' });
      }
      for (const envelope of envelopes) {
        await client.query('INSERT INTO group_key_envelopes (group_id, version, user_id, wrapped, wrapped_by) VALUES ($1, $2, $3, $4, $5)', [group.id, version, envelope.userId, envelope.wrapped, request.user!.id]);
      }
      await client.query('UPDATE groups SET key_version = $1, pending_version = NULL WHERE id = $2', [version, group.id]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      // A concurrent upload of the same version hits the primary key: report it as a conflict.
      if (error instanceof Error && /UNIQUE|constraint/i.test(error.message)) return reply.code(409).send({ error: 'Key version already uploaded' });
      throw error;
    } finally {
      client.release();
    }
    return reply.code(204).send();
  });

  const setRole = async (request: { params: { id: string; userId: string }; user?: { id: string } | null }, reply: FastifyReply, from: Role, to: Role): Promise<void> => {
    const group = await mine(request.params.id, request.user!.id, reply);
    if (!group) return;
    if (group.role !== 'owner') { await reply.code(403).send({ error: 'Only the owner can manage admins' }); return; }
    const target = parseId(request.params.userId);
    const row = target ? await db.query<{ role: Role }>('SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2', [group.id, target]) : null;
    const current = row?.rows[0]?.role;
    if (!target || !current || current === 'owner') { await reply.code(404).send({ error: 'Member not found' }); return; }
    if (current === from) await db.query('UPDATE group_members SET role = $1 WHERE group_id = $2 AND user_id = $3', [to, group.id, target]);
    await reply.code(204).send();
  };
  app.post<{ Params: { id: string; userId: string } }>('/api/groups/:id/admins/:userId', { preHandler: app.requireUser, config: { rateLimit: WRITE } }, async (request, reply) => setRole(request, reply, 'member', 'admin'));
  app.delete<{ Params: { id: string; userId: string } }>('/api/groups/:id/admins/:userId', { preHandler: app.requireUser, config: { rateLimit: WRITE } }, async (request, reply) => setRole(request, reply, 'admin', 'member'));

  // Extra (not in the first contract): hand ownership to another member; the old owner becomes admin.
  app.post<{ Params: { id: string; userId: string } }>('/api/groups/:id/owner/:userId', { preHandler: app.requireUser, config: { rateLimit: WRITE } }, async (request, reply) => {
    const group = await mine(request.params.id, request.user!.id, reply);
    if (!group) return;
    if (group.role !== 'owner') return reply.code(403).send({ error: 'Only the owner can transfer ownership' });
    const target = parseId(request.params.userId);
    const row = target ? await db.query('SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2', [group.id, target]) : null;
    if (!target || target === request.user!.id || row?.rowCount !== 1) return reply.code(404).send({ error: 'Member not found' });
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query("UPDATE group_members SET role = 'admin' WHERE group_id = $1 AND user_id = $2", [group.id, request.user!.id]);
      await client.query("UPDATE group_members SET role = 'owner' WHERE group_id = $1 AND user_id = $2", [group.id, target]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return reply.code(204).send();
  });
};
