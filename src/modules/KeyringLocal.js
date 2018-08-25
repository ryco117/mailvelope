/**
 * Copyright (C) 2018 Mailvelope GmbH
 * Licensed under the GNU Affero General Public License version 3
 */

import mvelo from '../lib/lib-mvelo';
import * as openpgp from 'openpgp';
import {getUserId, checkKeyId} from './key';
import KeyringBase from './KeyringBase';
const l10n = mvelo.l10n.getMessage;
import * as keyringSync from './keyringSync';
import * as openpgpjs from './openpgpjs';

export default class KeyringLocal extends KeyringBase {
  constructor(keyringId, keyStore) {
    super(keyringId, keyStore);
    this.sync = new keyringSync.KeyringSync(keyringId);
  }

  getPgpBackend() {
    return openpgpjs;
  }

  /**
   * Retrieve primary key. If no primary key set then take newest private key available.
   * @return {openpgp.key.Key}
   */
  getPrimaryKey() {
    let primaryKey;
    const primaryKeyFpr = this.keystore.getPrimaryKeyFpr();
    if (primaryKeyFpr) {
      primaryKey = this.keystore.privateKeys.getForId(primaryKeyFpr);
      if (!(primaryKey && this.validatePrimaryKey(primaryKey))) {
        // primary key with this id does not exist or is invalid
        this.setPrimaryKey(''); // clear primary key
        primaryKey = null;
      }
    }
    if (!primaryKey) {
      // get newest private key that is valid
      this.keystore.privateKeys.keys.forEach(key => {
        if ((!primaryKey || primaryKey.primaryKey.created < key.primaryKey.created) &&
            this.validatePrimaryKey(key)) {
          primaryKey = key;
        }
      });
      if (primaryKey) {
        this.setPrimaryKey(primaryKey.primaryKey.getFingerprint());
      }
    }
    return primaryKey ? primaryKey : null;
  }

  getPrimaryKeyFpr() {
    const primaryKey = this.getPrimaryKey();
    return primaryKey ? primaryKey.primaryKey.getFingerprint() : '';
  }

  /**
   * Import armored keys into the keyring
   * @param  {Object<armored: String, type: String>} armoredKeys - armored keys of type 'public' or 'private'
   * @return {Array<Object>} import result messages in the form {type, message}, type could be 'error' or 'success'
   */
  async importKeys(armoredKeys) {
    let result = [];
    // sort, public keys first
    armoredKeys = armoredKeys.sort((a, b) => b.type.localeCompare(a.type));
    // import
    armoredKeys.forEach(key => {
      try {
        if (key.type === 'public') {
          result = result.concat(this.importPublicKey(key.armored, this.keystore));
        } else if (key.type === 'private') {
          result = result.concat(this.importPrivateKey(key.armored, this.keystore));
        }
      } catch (e) {
        result.push({
          type: 'error',
          message: l10n('key_import_unable', [e])
        });
      }
    });
    // exit if no import succeeded
    if (!result.some(message => message.type === 'success')) {
      return result;
    }
    await this.keystore.store();
    await this.sync.commit();
    // by no primary key in the keyring set the first found private keys as primary for the keyring
    if (!this.hasPrimaryKey() && this.keystore.privateKeys.keys.length > 0) {
      await this.setPrimaryKey(this.keystore.privateKeys.keys[0].primaryKey.getFingerprint());
    }
    return result;
  }

  importPublicKey(armored) {
    const result = [];
    const imported = openpgp.key.readArmored(armored);
    if (imported.err) {
      imported.err.forEach(error => {
        console.log('Error on key.readArmored', error);
        result.push({
          type: 'error',
          message: l10n('key_import_public_read', [error.message])
        });
      });
    }
    imported.keys.forEach(pubKey => {
      // check for existing keys
      checkKeyId(pubKey, this.keystore);
      const fingerprint = pubKey.primaryKey.getFingerprint();
      let key = this.keystore.getKeysForId(fingerprint);
      const keyId = pubKey.primaryKey.getKeyId().toHex().toUpperCase();
      if (key) {
        key = key[0];
        key.update(pubKey);
        result.push({
          type: 'success',
          message: l10n('key_import_public_update', [keyId, getUserId(pubKey)])
        });
        this.sync.add(fingerprint, keyringSync.UPDATE);
      } else {
        this.keystore.publicKeys.push(pubKey);
        result.push({
          type: 'success',
          message: l10n('key_import_public_success', [keyId, getUserId(pubKey)])
        });
        this.sync.add(fingerprint, keyringSync.INSERT);
      }
    });
    return result;
  }

  importPrivateKey(armored) {
    const result = [];
    const imported = openpgp.key.readArmored(armored);
    if (imported.err) {
      imported.err.forEach(error => {
        console.log('Error on key.readArmored', error);
        result.push({
          type: 'error',
          message: l10n('key_import_private_read', [error.message])
        });
      });
    }
    imported.keys.forEach(privKey => {
      // check for existing keys
      checkKeyId(privKey, this.keystore);
      const fingerprint = privKey.primaryKey.getFingerprint();
      let key = this.keystore.getKeysForId(fingerprint);
      const keyId = privKey.primaryKey.getKeyId().toHex().toUpperCase();
      if (key) {
        key = key[0];
        if (key.isPublic()) {
          privKey.update(key);
          this.keystore.publicKeys.removeForId(fingerprint);
          this.keystore.privateKeys.push(privKey);
          result.push({
            type: 'success',
            message: l10n('key_import_private_exists', [keyId, getUserId(privKey)])
          });
          this.sync.add(fingerprint, keyringSync.UPDATE);
        } else {
          key.update(privKey);
          result.push({
            type: 'success',
            message: l10n('key_import_private_update', [keyId, getUserId(privKey)])
          });
          this.sync.add(fingerprint, keyringSync.UPDATE);
        }
      } else {
        this.keystore.privateKeys.push(privKey);
        result.push({
          type: 'success',
          message: l10n('key_import_private_success', [keyId, getUserId(privKey)])
        });
        this.sync.add(fingerprint, keyringSync.INSERT);
      }
    });
    return result;
  }

  async removeKey(fingerprint, type) {
    const removedKey = super.removeKey(fingerprint, type);
    if (type === 'private') {
      const primaryKeyFpr = this.keystore.getPrimaryKeyFpr();
      // Remove the key from the keyring attributes if primary
      if (primaryKeyFpr  === removedKey.primaryKey.getFingerprint()) {
        await this.setPrimaryKey('');
      }
    }
    this.sync.add(removedKey.primaryKey.getFingerprint(), keyringSync.DELETE);
    await this.keystore.store();
    await this.sync.commit();
  }

  async generateKey(options) {
    const newKey = await super.generateKey(options);
    this.sync.add(newKey.key.primaryKey.getFingerprint(), keyringSync.INSERT);
    await this.keystore.store();
    await this.sync.commit();
    // if no primary key in the keyring set the generated key as primary
    if (!this.hasPrimaryKey()) {
      await this.setPrimaryKey(newKey.key.primaryKey.getFingerprint());
    }
    return newKey;
  }
}
