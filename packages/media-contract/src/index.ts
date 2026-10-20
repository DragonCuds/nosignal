export * from './attachments.js';
export type StickerFormat = 'tgs' | 'webm' | 'webp';

export type StickerMessagePayload = {
  packId: string;
  stickerId: string;
  format: StickerFormat;
  w: number;
  h: number;
  emoji: string;
};

export type GifMessagePayload = {
  gifId: string;
  mp4Url: string;
  w: number;
  h: number;
  durationMs: number;
};

/** Payload for a sticker or GIF message shared by every tel media consumer. */
export type MessagePayload = StickerMessagePayload | GifMessagePayload;

export type RealtimeMessage = {
  id: string;
  chatId: string;
  senderId: string;
  /** Idempotency key chosen by the sender (weak-net). Same (sender, clientMsgId) never creates a 2nd message. */
  clientMsgId?: string | null;
  kind: 'text' | 'sticker' | 'gif' | 'photo' | 'video' | 'voice' | 'file';
  text: string | null;
  payload: unknown | null;
  replyToId: string | null;
  /** 32-hex id of the E2EE attachment (photo/video/voice/file messages), else null. */
  attachmentId?: string | null;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  sender: {
    id: string;
    username: string;
    displayName: string;
    avatarPath: string | null;
  };
};

/** `seq` = global event-log number (see /api/sync). Present on message.* events. */
export type RealtimeServerEvent =
  | { type: 'message.new'; chatId: string; message: RealtimeMessage; seq?: number }
  | { type: 'message.edited'; chatId: string; message: RealtimeMessage; seq?: number }
  | { type: 'message.deleted'; chatId: string; message: RealtimeMessage; seq?: number }
  | { type: 'read'; chatId: string; userId: string; messageId: string }
  | { type: 'typing'; chatId: string; userId: string; isTyping: boolean }
  | { type: 'presence'; userId: string; online: boolean; lastSeen: string | null }
  | { type: 'pong'; t: number }
  | { type: 'hello' };

export type RealtimeClientEvent = {
  type: 'typing';
  chatId: string;
  isTyping?: boolean;
};

/** App-level heartbeat: client sends, server answers {type:'pong', t} with the same t. */
export type RealtimeClientPing = { type: 'ping'; t: number };

export type SyncEvent = {
  seq: number;
  type: 'message.new' | 'message.edited' | 'message.deleted';
  chatId: string;
  message: RealtimeMessage;
};

/** GET /api/sync?since=N. reset=true -> too much missed, client must refetch lists instead. */
export type SyncResponse = { events: SyncEvent[]; latest: number; reset: boolean };

export * from './media.js';
