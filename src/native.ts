import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
let initialized = false;
export function loadSQLCipher(): void {
  if (initialized) return;
  const paths = [
    process.env.DIA_SQLCIPHER_LIBRARY,
    '/opt/homebrew/opt/sqlcipher/lib/libsqlcipher.dylib',
    '/usr/local/opt/sqlcipher/lib/libsqlcipher.dylib',
  ].filter(Boolean) as string[];
  const path = paths.find(existsSync);
  if (!path)
    throw new Error(
      'SQLCipher library not found. Run brew install sqlcipher, set DIA_SQLCIPHER_LIBRARY, or use a portable release.',
    );
  if (!Database.setCustomSQLite(path))
    throw new Error('SQLCipher must be loaded before opening any SQLite database.');
  const db = new Database(':memory:');
  try {
    if (!db.query('PRAGMA cipher_version').get())
      throw new Error('Selected library is not SQLCipher.');
  } finally {
    db.close();
  }
  initialized = true;
}
