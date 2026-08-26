/**
 * Encryption-key management for the local payroll database.
 *
 * The SQLite file itself is encrypted (see db/index.js), but that only
 * actually protects anything if the key isn't sitting next to it in plain
 * text. This module generates a random key once per install, then relies
 * on Electron's `safeStorage` — which hands off to the OS's own credential
 * store (Windows DPAPI, macOS Keychain, Linux Secret Service via libsecret)
 * — to encrypt that key at rest. We never write the raw key to disk
 * ourselves, and we deliberately do not fall back to plain-text storage
 * if OS-level protection isn't available: that would defeat the entire
 * point of encrypting the database.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { safeStorage } = require('electron');

const KEY_FILE_NAME = '.mikaju-dbkey';

function keyFilePath(userDataPath) {
  return path.join(userDataPath, KEY_FILE_NAME);
}

/**
 * Returns the database encryption key as a 64-char hex string, creating
 * and persisting a new one on first run. Throws if OS-level secure
 * storage isn't available.
 */
function getOrCreateDbKey(userDataPath) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'Mikaju Payroll cannot start: no OS-level secure credential store is ' +
      'available on this machine (Windows Credential Manager, macOS Keychain, ' +
      'or a Linux Secret Service provider such as gnome-keyring or kwallet). ' +
      'The payroll database encryption key cannot be safely stored without ' +
      'one. On Linux, install and unlock a keyring and try again.'
    );
  }

  const filePath = keyFilePath(userDataPath);

  if (fs.existsSync(filePath)) {
    const encrypted = fs.readFileSync(filePath);
    const key = safeStorage.decryptString(encrypted);
    if (!/^[0-9a-f]{64}$/i.test(key)) {
      throw new Error(
        `The stored database key at ${filePath} is corrupted or unreadable. ` +
        'Do not delete this file, and do not delete mikaju.db — contact support.'
      );
    }
    return key;
  }

  const rawKey = crypto.randomBytes(32).toString('hex');
  const encrypted = safeStorage.encryptString(rawKey);
  fs.writeFileSync(filePath, encrypted, { mode: 0o600 });
  return rawKey;
}

module.exports = { getOrCreateDbKey, keyFilePath };
