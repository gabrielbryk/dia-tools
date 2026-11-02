import { createHmac, pbkdf2Sync } from 'node:crypto';
const publicConstant = Buffer.from('iOe1Ue/XtonbieE/5m1nAgewvWQlePHRcKnoU10EyOM=', 'base64');
export function deriveRoot(secret: Uint8Array): Buffer {
  return pbkdf2Sync(secret, 'saltysalt', 1003, 16, 'sha1');
}
export function deriveDatabaseKey(root: Uint8Array, context: string): Buffer {
  const salt = createHmac('sha256', publicConstant).update(context).digest();
  const prk = createHmac('sha256', salt).update(root).digest();
  const key = createHmac('sha256', prk)
    .update(Buffer.concat([Buffer.from(context), Buffer.from([1])]))
    .digest();
  prk.fill(0);
  return key;
}
export function keychainRoot(): Buffer {
  if (process.platform !== 'darwin') throw new Error('Dia Keychain access requires macOS.');
  const result = Bun.spawnSync(
    ['/usr/bin/security', 'find-generic-password', '-s', 'Dia Safe Storage', '-a', 'Dia', '-w'],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  if (result.exitCode !== 0)
    throw new Error(
      'macOS did not grant access to Dia Safe Storage. Approve its Keychain prompt and retry.',
    );
  const output = Buffer.from(result.stdout);
  const password = output.at(-1) === 10 ? output.subarray(0, -1) : output;
  if (!password.length) throw new Error('Dia Safe Storage returned an empty value.');
  try {
    return deriveRoot(password);
  } finally {
    output.fill(0);
    result.stdout.fill(0);
  }
}
