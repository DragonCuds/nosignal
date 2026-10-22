import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { db, type DbClient } from './db.js';
import { notifyChatNew } from './realtime.js';

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
const fingerprint = (jwk: JsonWebKey): string => createHash('sha256').update(`P-256:${jwk.x}:${jwk.y}`).digest('hex');
const parseJwk = (value: string | null): JsonWebKey | null => {
  if (!value) return null;
  try { const parsed: unknown = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonWebKey : null; } catch { return null; }
};

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

/** Anything that can run a query: the shared `db`, or a transaction `client` (never use `db` while a client holds BEGIN). */
export type Queryable = Pick<DbClient, 'query'>;
/** A refused gate: the HTTP status and JSON body the route answers with. */
export type GateFailure = { ok: false; status: number; body: Record<string, unknown> };
export type GateResult = { ok: true; keyVersion: number | null; staff: boolean } | GateFailure;

/**
 * Gate decision for the message routes, pure data (no reply). Non-group chats pass straight through ({ok:true, keyVersion:null}).
 * In a group: posting/editing needs the CURRENT key version and no pending rotation; deleting is allowed for the
 * sender or an owner/admin (`staff`). Call it with a transaction client to decide on the state the write will really see.
 */
export const groupGateCheck = async (
  q: Queryable, chatId: string, userId: string, action: 'post' | 'edit' | 'delete', keyVersion: unknown
): Promise<GateResult> => {
  const row = await q.query<{ key_version: number; pending_version: number | null; role: Role | null }>(
    `SELECT g.key_version, g.pending_version, gm.role FROM groups g
     LEFT JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = $2 WHERE g.chat_id = $1`,
    [chatId, userId]
  );
  const group = row.rows[0];
  if (!group) return { ok: true, keyVersion: null, staff: false };
  if (!group.role) return { ok: false, status: 404, body: { error: 'Chat not found' } };
  if (action === 'delete') return { ok: true, keyVersion: null, staff: group.role === 'owner' || group.role === 'admin' };
  if (group.key_version < 1 || group.pending_version !== null) {
    return { ok: false, status: 409, body: { error: 'Group key rotation pending; an admin must open the group first' } };
  }
  if (keyVersion !== group.key_version) {
    return { ok: false, status: 400, body: { error: `keyVersion must be the current group key version (${group.key_version})`, keyVersion: group.key_version } };
  }
  return { ok: true, keyVersion: group.key_version, staff: false };
};

/** Route hook form of groupGateCheck: a reply has been sent when ok is false. */
export const groupMessageGate = async (
  chatId: string, userId: string, action: 'post' | 'edit' | 'delete', keyVersion: unknown, reply: FastifyReply
): Promise<{ ok: true; keyVersion: number | null; staff: boolean } | { ok: false }> => {
  const gate = await groupGateCheck(db, chatId, userId, action, keyVersion);
  if (gate.ok) return gate;
  await reply.code(gate.status).send(gate.body);
  return { ok: false };
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
    if (request.body?.envelopes !== undefined) return reply.code(400).send({ error: 'Upload keys after creating the group' });
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

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const chat = await client.query<{ id: string }>("INSERT INTO chats (type) VALUES ('direct') RETURNING id");
      const group = await client.query<{ id: string }>(
        'INSERT INTO groups (chat_id, title, created_by, key_version, pending_version) VALUES ($1, $2, $3, 0, 1) RETURNING id',
        [chat.rows[0].id, title, userId]
      );
      for (const id of all) {
        await client.query('INSERT INTO chat_members (chat_id, user_id) VALUES ($1, $2)', [chat.rows[0].id, id]);
        await client.query('INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, $3)', [group.rows[0].id, id, id === userId ? 'owner' : 'member']);
      }
      await client.query('COMMIT');
      notifyChatNew(app, all.filter((id) => id !== userId), chat.rows[0].id);
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

  app.post<{ Params: { id: string }; Body: { userId?: unknown } }>('/api/groups/:id/members', { preHandler: app.requireUser, config: { rateLimit: WRITE } }, async (request, reply) => {
    const group = await mine(request.params.id, request.user!.id, reply);
    if (!group) return;
    if (!staff(group)) return reply.code(403).send({ error: 'Only owners and admins can add members' });
    const target = parseId(request.body?.userId);
    if (!target) return reply.code(400).send({ error: 'userId is required' });
    if (group.key_version < 1 || group.pending_version !== null) return reply.code(409).send({ error: 'Group key rotation pending; upload the new key first' });
    if ((await db.query('SELECT 1 FROM users WHERE id = $1', [target])).rowCount !== 1) return reply.code(404).send({ error: 'User not found' });
    if (!(await identityOf(target))) return reply.code(409).send({ error: 'That user has no encryption identity yet' });
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const fresh = (await client.query<{ key_version: number; pending_version: number | null; role: Role | null }>(
        `SELECT g.key_version, g.pending_version, gm.role FROM groups g
         LEFT JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = $2 WHERE g.id = $1`,
        [group.id, request.user!.id]
      )).rows[0];
      if (!fresh || (fresh.role !== 'owner' && fresh.role !== 'admin') || fresh.key_version < 1 || fresh.pending_version !== null) {
        await client.query('ROLLBACK');
        return reply.code(409).send({ error: 'Group membership or key version changed; refresh and retry' });
      }
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
      // No old key is given to the new member. Posting resumes after a verified rotation.
      await client.query('UPDATE groups SET pending_version = key_version + 1 WHERE id = $1', [group.id]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    notifyChatNew(app, [target], group.chat_id);
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
    // Each envelope carries the wrapper's public key as it was when wrapped (NS-07b). The browser opens an old version with it
    // only if that fingerprint was pinned before for the wrapper; the server is not trusted for this.
    const rows = await db.query<{ version: number; wrapped: string; wrapped_by: string; wrapper_fingerprint: string | null; wrapper_public_jwk: string | null }>(
      `SELECT version, wrapped, CAST(wrapped_by AS TEXT) AS wrapped_by, wrapper_fingerprint, wrapper_public_jwk FROM group_key_envelopes
       WHERE group_id = $1 AND user_id = $2
       AND ($3 IS NULL OR version = $3) ORDER BY version ${version === 'latest' ? 'DESC LIMIT 1' : 'ASC'}`,
      [group.id, request.user!.id, typeof version === 'number' ? version : null]
    );
    reply.header('Cache-Control', 'no-store');
    return rows.rows.map((r) => ({
      version: r.version, wrapped: r.wrapped, wrappedBy: r.wrapped_by,
      wrapperFingerprint: r.wrapper_fingerprint, wrapperPublicKey: parseJwk(r.wrapper_public_jwk)
    }));
  });

  app.put<{ Params: { id: string }; Body: { version?: unknown; expectedMembers?: unknown; envelopes?: unknown } }>('/api/groups/:id/keys', { preHandler: app.requireUser, config: { rateLimit: WRITE } }, async (request, reply) => {
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
      // The role was checked before BEGIN; an admin demoted or removed in between must not publish a key.
      const role = (await client.query<{ role: Role }>('SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2', [group.id, request.user!.id])).rows[0]?.role;
      if (role !== 'owner' && role !== 'admin') {
        await client.query('ROLLBACK');
        return reply.code(403).send({ error: 'Only owners and admins can rotate the key' });
      }
      const currentMembers = (await client.query<{ user_id: string; public_jwk: JsonWebKey | null }>(
        `SELECT gm.user_id, ci.public_jwk FROM group_members gm
         LEFT JOIN user_crypto_identities ci ON ci.user_id = gm.user_id WHERE gm.group_id = $1`, [group.id]
      )).rows;
      const members = currentMembers.map((r) => r.user_id);
      const expected = request.body?.expectedMembers;
      if (!Array.isArray(expected) || expected.length !== members.length || expected.length > MAX_MEMBERS ||
        expected.some((item) => !item || typeof item !== 'object' || !parseId(item.userId) ||
          typeof item.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(item.fingerprint)) ||
        new Set(expected.map((item) => item.userId)).size !== members.length ||
        currentMembers.some((member) => !member.public_jwk || expected.find((item) => item.userId === member.user_id)?.fingerprint !== fingerprint(member.public_jwk))) {
        await client.query('ROLLBACK');
        return reply.code(409).send({ error: 'Group membership or identity changed; refresh and verify keys' });
      }
      const envelopes = parseEnvelopes(request.body?.envelopes, members);
      if (!envelopes) {
        await client.query('ROLLBACK');
        return reply.code(400).send({ error: 'envelopes must contain one wrapped key for every current member' });
      }
      // The wrapper's key comes from the server's own record of the uploader's CURRENT identity (checked against
      // expectedMembers above), never from the request body.
      const wrapperKey = currentMembers.find((member) => member.user_id === request.user!.id)!.public_jwk!;
      const wrapperJwk = JSON.stringify({ kty: wrapperKey.kty, crv: wrapperKey.crv, x: wrapperKey.x, y: wrapperKey.y });
      const wrapperFingerprint = fingerprint(wrapperKey);
      for (const envelope of envelopes) {
        await client.query(
          `INSERT INTO group_key_envelopes (group_id, version, user_id, wrapped, wrapped_by, wrapper_fingerprint, wrapper_public_jwk)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [group.id, version, envelope.userId, envelope.wrapped, request.user!.id, wrapperFingerprint, wrapperJwk]);
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
