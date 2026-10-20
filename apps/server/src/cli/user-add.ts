import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { Writable } from 'node:stream';
import { db } from '../db.js';
import { createUser } from '../users.js';

const args = process.argv.slice(2);
const admin = args.includes('--admin');
const [username, displayName] = args.filter((arg) => arg !== '--admin');

class MutedOutput extends Writable {
  muted = false;

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (!this.muted) stdout.write(chunk);
    callback();
  }
}

const askForPassword = async (): Promise<string> => {
  if (!stdin.isTTY) {
    const readline = createInterface({ input: stdin, output: stdout, terminal: false });
    const password = await readline.question('Password: ');
    readline.close();
    return password;
  }

  const output = new MutedOutput();
  const readline = createInterface({ input: stdin, output, terminal: true });
  stdout.write('Password: ');
  output.muted = true;
  const password = await readline.question('');
  output.muted = false;
  stdout.write('\n');
  readline.close();
  return password;
};

const run = async (): Promise<void> => {
  if (!username || !displayName) {
    throw new Error('Usage: npm run user:add -- <username> "<display name>" [--admin]');
  }
  const password = await askForPassword();
  const id = await createUser(username, displayName, password, { allowReserved: true });
  if (admin) await db.query('UPDATE users SET is_admin = 1 WHERE id = $1', [id]);
  process.stdout.write(`Created ${admin ? 'admin ' : ''}user ${username} (id ${id})\n`);
};

run()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => db.end());
