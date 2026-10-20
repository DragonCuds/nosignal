# SQLite database conventions

The server stores its complete relational state in `$DATA_DIR/tel.db`. SQLite is opened in WAL mode with foreign-key enforcement and a 5-second busy timeout. Back up the database together with the rest of `DATA_DIR`.

## Types

- Primary and foreign keys use `INTEGER`. SQLite row ids replace PostgreSQL `BIGSERIAL`; API-facing ids remain decimal strings.
- UUIDs use canonical lowercase `TEXT`.
- Timestamps use UTC ISO-8601 `TEXT`, produced with `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`.
- Booleans use `INTEGER NOT NULL CHECK (value IN (0, 1))`.
- Values that may exceed JavaScript's safe integer range are stored as decimal `TEXT`. This replaces application-visible PostgreSQL `BIGINT` values.
- JSON and arrays use JSON-encoded `TEXT`, guarded with `json_valid(...)` where appropriate. Binary values use `BLOB`.

## SQL portability rules

- Use the SQLite timestamp expression above instead of `now()`; use modifiers such as `datetime('now', '+30 days')` instead of PostgreSQL `interval` expressions.
- Remove `FOR UPDATE`. The database facade serializes transactions and starts writers with `BEGIN IMMEDIATE`.
- Validate regular expressions in TypeScript before writing. SQLite schema checks use lengths, enumerations, and simple `GLOB` checks only where sufficient.
- SQLite supports `RETURNING`; it may be used for inserts, updates, and deletes.
- Positional parameters may stay as `$1`, `$2`, and so on. The facade translates them to SQLite named parameters.
- JSON access uses `json_extract(value, '$.field')`, construction uses `json_object(...)`, and JSON arrays use `json_each(...)`.

All multi-statement writes must use `db.connect()`, `BEGIN`, and `COMMIT`/`ROLLBACK`, releasing the client in `finally`.
