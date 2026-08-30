#!/usr/bin/env node
// Resets a user's password directly against data/hub.db, bypassing the web UI
// -- for when you're locked out, or ADMIN_PASSWORD in .env didn't take effect
// because the user already existed (it only seeds the very first admin).
//
// Usage:
//   node tools/reset-password.mjs <username>              # prompts, hidden input
//   node tools/reset-password.mjs <username> <newpassword> # non-interactive
import { loadConfig } from '../src/server/config.ts';
import { openDatabase } from '../src/server/db.ts';
import { findUser, setPassword, deleteSessionsForUser } from '../src/server/auth.ts';

const ENTER = new Set(['\n', '\r']);
const CANCEL = new Set(['\u0003', '\u0004']); // Ctrl-C, Ctrl-D
const BACKSPACE = new Set(['\u007f', '\b']); // DEL, ^H

const username = process.argv[2];
if (!username) {
  console.error('Usage: node tools/reset-password.mjs <username> [newpassword]');
  process.exit(1);
}

/** Reads one line from a TTY without echoing it back. */
function promptHidden(question) {
  return new Promise((resolvePromise, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error('stdin is not a TTY -- pass the password as a third argument instead.'));
      return;
    }

    process.stdout.write(question);
    let input = '';

    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('data', onData);
    };

    const onData = (chunk) => {
      for (const char of chunk.toString('utf8')) {
        if (ENTER.has(char)) {
          cleanup();
          process.stdout.write('\n');
          resolvePromise(input);
          return;
        }
        if (CANCEL.has(char)) {
          cleanup();
          process.stdout.write('\n');
          process.exit(130);
        }
        if (BACKSPACE.has(char)) {
          input = input.slice(0, -1);
          continue;
        }
        input += char;
      }
    };

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onData);
  });
}

async function getPassword() {
  const fromArg = process.argv[3];
  if (fromArg !== undefined) return fromArg;

  const first = await promptHidden('New password: ');
  const second = await promptHidden('Confirm password: ');
  if (first !== second) {
    console.error('Passwords do not match.');
    process.exit(1);
  }
  if (first.length === 0) {
    console.error('Password cannot be empty.');
    process.exit(1);
  }
  return first;
}

const password = await getPassword();

const config = loadConfig();
const db = openDatabase(config.dataDir);

const user = findUser(db, username);
if (!user) {
  console.error(`No such user: "${username}"`);
  db.close();
  process.exit(1);
}

await setPassword(db, username, password);
deleteSessionsForUser(db, user.id);
db.close();

console.log(`Password updated for "${username}". Existing sessions were invalidated.`);
