#!/usr/bin/env bash
set -euo pipefail

: "${SMOKE_USER_A:?SMOKE_USER_A is required}"
: "${SMOKE_USER_B:?SMOKE_USER_B is required}"
: "${SMOKE_PASSWORD:?SMOKE_PASSWORD is required}"

base_url="${BASE_URL:-http://127.0.0.1:3050}"
headers_a="$(mktemp)"
headers_b="$(mktemp)"
trap 'rm -f "$headers_a" "$headers_b"' EXIT

login() {
  local username="$1" headers="$2"
  curl -fsS -D "$headers" -o /dev/null \
    -H 'content-type: application/json' \
    --data "{\"username\":\"${username}\",\"password\":\"${SMOKE_PASSWORD}\"}" \
    "$base_url/api/auth/login"
  awk 'BEGIN { IGNORECASE = 1 } /^set-cookie: tel_session=/ { sub(/^set-cookie: tel_session=/, ""); sub(/;.*/, ""); gsub(/\r/, ""); print; exit }' "$headers"
}

token_a="$(login "$SMOKE_USER_A" "$headers_a")"
token_b="$(login "$SMOKE_USER_B" "$headers_b")"
[[ -n "$token_a" && -n "$token_b" ]] || { echo 'FAIL: login did not issue both session cookies' >&2; exit 1; }

api_a() { curl -fsS -H "Cookie: tel_session=$token_a" "$@"; }
api_b() { curl -fsS -H "Cookie: tel_session=$token_b" "$@"; }

users="$(api_a "$base_url/api/users")"
user_b_id="$(node -e 'const users = JSON.parse(process.argv[1]); const user = users.find((entry) => entry.username === process.argv[2]); if (!user) process.exit(1); process.stdout.write(user.id)' "$users" "$SMOKE_USER_B")"
chat="$(api_a -H 'content-type: application/json' --data "{\"userId\":\"${user_b_id}\"}" "$base_url/api/chats")"
chat_id="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).id)' "$chat")"
message_a="$(api_a -H 'content-type: application/json' --data '{"kind":"text","text":"smoke: hello from A"}' "$base_url/api/chats/$chat_id/messages")"
message_a_id="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).id)' "$message_a")"
message_b="$(api_b -H 'content-type: application/json' --data '{"kind":"text","text":"smoke: hello from B"}' "$base_url/api/chats/$chat_id/messages")"
message_b_id="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).id)' "$message_b")"
chats_a="$(api_a "$base_url/api/chats")"
chats_b="$(api_b "$base_url/api/chats")"
api_b -o /dev/null -w '%{http_code}' -H 'content-type: application/json' --data "{\"messageId\":\"${message_a_id}\"}" "$base_url/api/chats/$chat_id/read" | grep -qx '204'
edited="$(api_a -X PATCH -H 'content-type: application/json' --data '{"text":"smoke: edited by A"}' "$base_url/api/chats/$chat_id/messages/$message_a_id")"
deleted="$(api_b -X DELETE "$base_url/api/chats/$chat_id/messages/$message_b_id")"
history="$(api_a "$base_url/api/chats/$chat_id/messages?limit=50")"

node - "$chat_id" "$message_a" "$message_b" "$edited" "$deleted" "$history" "$chats_a" "$chats_b" <<'NODE'
const [chatId, messageA, messageB, edited, deleted, history, chatsA, chatsB] = process.argv.slice(2).map(JSON.parse);
const chatA = chatsA.find((chat) => chat.id === String(chatId));
const chatB = chatsB.find((chat) => chat.id === String(chatId));
if (!chatA || !chatB || history.length !== 2 || edited.text !== 'smoke: edited by A' || deleted.deletedAt === null) process.exit(1);
console.log(JSON.stringify({
  ok: true,
  chatId,
  exchangedMessageIds: [messageA.id, messageB.id],
  editedMessageId: edited.id,
  deletedMessageId: deleted.id,
  historyCount: history.length,
  unreadBeforeRead: { a: chatA.unreadCount, b: chatB.unreadCount }
}));
NODE
