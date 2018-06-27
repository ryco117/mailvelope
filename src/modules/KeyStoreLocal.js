/**
 * Copyright (C) 2018 Mailvelope GmbH
 * Licensed under the GNU Affero General Public License version 3
 */

import mvelo from '../lib/lib-mvelo';
import * as openpgp from 'openpgp';
import {KeyStoreBase} from './keyStore';
import {getKeyringAttr} from './keyring';

export default class KeyStoreLocal extends KeyStoreBase {
  async load() {
    this.clear();
    const pubArmored = await mvelo.storage.get(`mvelo.keyring.${this.id}.publicKeys`);
    this.loadKeys(pubArmored, this.publicKeys);
    const privArmored = await mvelo.storage.get(`mvelo.keyring.${this.id}.privateKeys`);
    this.loadKeys(privArmored, this.privateKeys);
  }

  async store() {
    await this.storePublic();
    await this.storePrivate();
  }

  async storePublic() {
    await this.storeKeys(`mvelo.keyring.${this.id}.publicKeys`, this.publicKeys.keys);
  }

  async storePrivate() {
    await this.storeKeys(`mvelo.keyring.${this.id}.privateKeys`, this.privateKeys.keys);
  }

  async storeKeys(storageKey, keys) {
    await mvelo.storage.set(storageKey, keys.map(key => key.armor()));
  }

  async remove() {
    await mvelo.storage.remove(`mvelo.keyring.${this.id}.publicKeys`);
    await mvelo.storage.remove(`mvelo.keyring.${this.id}.privateKeys`);
  }

  getPrimaryKeyId() {
    const primaryKeyId = getKeyringAttr(this.id, 'primary_key');
    if (primaryKeyId) {
      return primaryKeyId.toLowerCase();
    }
    return '';
  }

  async generateKey(options) {
    return openpgp.generateKey(options);
  }
}
