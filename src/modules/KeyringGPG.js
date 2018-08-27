/**
 * Copyright (C) 2017 Mailvelope GmbH
 * Licensed under the GNU Affero General Public License version 3
 */

import mvelo from '../lib/lib-mvelo';
const l10n = mvelo.l10n.getMessage;
import KeyringBase from './KeyringBase';
import * as gnupg from './gnupg';

export default class KeyringGPG extends KeyringBase {
  getPgpBackend() {
    return gnupg;
  }

  getAttr() {
    return {
      default_key: this.getDefaultKeyFpr()
    };
  }

  getDefaultKey() {
    const defaultKeyFpr = this.getDefaultKeyFpr();
    return this.keystore.privateKeys.getForId(defaultKeyFpr);
  }

  getDefaultKeyFpr() {
    return this.keystore.getDefaultKeyFpr();
  }

  /**
   * Import armored keys into the keyring
   * @param  {Object<armored: String, type: String>} armoredKeys - armored keys of type 'public' or 'private'
   * @return {Array<Object>} import result messages in the form {type, message}, type could be 'error' or 'success'
   */
  async importKeys(armoredKeys) {
    armoredKeys = armoredKeys.map(key => key.armored).join('\n');
    const {Keys, summary} = await this.keystore.importKeys(armoredKeys);
    const importedFprs = [];
    const result = Keys.map(({key, status}) => {
      const fingerprint = key.fingerprint;
      importedFprs.push(fingerprint);
      // import successful, remove existing keys with this fingerprint
      this.keystore.removeKeysForId(fingerprint.toLowerCase());
      const userId = key.get('userids')[0].get('uid');
      return {
        type: 'success',
        message: l10n(status === 'newkey' ? 'key_import_public_success' : 'key_import_public_update', [fingerprint, userId])
      };
    });
    const failed = summary.considered - Keys.length;
    if (failed) {
      result.push({
        type: 'error',
        message: l10n('key_import_number_of_failed', [failed])
      });
    }
    // re-add successfully imported keys
    await this.keystore.addPublicKeys(importedFprs);
    return result;
  }

  async removeKey(fingerprint, type) {
    if (type === 'private') {
      throw new mvelo.Error('Removal of private keys not supported in GPG Keyring', 'GPG_NOT_SUPPORTED');
    }
    await this.keystore.removeKey(fingerprint);
    super.removeKey(fingerprint, type);
  }
}
