/**
 * Copyright (C) 2012-2017 Mailvelope GmbH
 * Licensed under the GNU Affero General Public License version 3
 */

import mvelo from '../lib/lib-mvelo';
const l10n = mvelo.l10n.getMessage;
import * as openpgp from 'openpgp';
import * as defaults from './defaults';
import * as prefs from './prefs';
import * as pwdCache from './pwdCache';
import {randomString, symEncrypt} from './crypto';
import * as uiLog from './uiLog';
import {getById as getKeyringById, getKeyringWithPrivKey, syncPublicKeys} from './keyring';
import {getUserId, mapKeys} from './key';
import * as keyringSync from './keyringSync';
import * as trustKey from './trustKey';

export async function init() {
  await defaults.init();
  await prefs.init();
  pwdCache.init();
  initOpenPGP();
  trustKey.init();
}

function initOpenPGP() {
  openpgp.config.commentstring = 'https://www.mailvelope.com';
  openpgp.config.versionstring = `Mailvelope v${defaults.getVersion()}`;
  openpgp.initWorker({path: 'dep/openpgp.worker.js'});
}

/**
 * Decrypt armored PGP message
 * @param  {String} options.armored - armored PGP message
 * @param  {String} options.keyringId
 * @param  {Function} options.unlockKey - callback to unlock key
 * @param  {String|Array} options.senderAddress - email address of sender, used to indentify key for signature verification
 * @param  {Boolean} options.selfSigned - message is self signed (decrypt email draft scenario)
 * @return {Promise<Object>} - decryption result {data: String, signatures: Array}
 */
export async function decryptMessage({armored, keyringId, unlockKey, senderAddress, selfSigned}) {
  const message = readMessage({armoredText: armored});
  const encryptionKeyIds = message.getEncryptionKeyIds();
  const keyring = getKeyringWithPrivKey(encryptionKeyIds, keyringId);
  if (!keyring) {
    throw noKeyFoundError(encryptionKeyIds);
  }
  let {data, signatures} = await keyring.getPgpBackend().decrypt({armored, message, keyring, unlockKey, senderAddress, selfSigned, encryptionKeyIds});
  // sync public keys for signing
  await syncPublicKeys(keyring, signatures.map(sig => sig.keyid));
  signatures = signatures.map(sig => addSigningKeyDetails(sig, keyring));
  return {data, signatures};
}

function addSigningKeyDetails(signature, keyring) {
  if (signature.valid !== null) {
    const signingKey = keyring.keystore.getKeysForId(signature.keyid, true);
    signature.keyDetails = mapKeys(signingKey)[0];
  }
  return signature;
}

function noKeyFoundError(encryptionKeyIds) {
  const keyid = encryptionKeyIds[0].toHex();
  let errorMsg = l10n('message_no_keys', [keyid.toUpperCase()]);
  for (let i = 1; i < encryptionKeyIds.length; i++) {
    errorMsg = `${errorMsg} ${l10n('word_or')} ${encryptionKeyIds[i].toHex().toUpperCase()}`;
  }
  return new mvelo.Error(errorMsg, 'NO_KEY_FOUND');
}

/**
 * Parse armored PGP message
 * @param  {String} options.armoredText
 * @param  {Uint8Array} options.binary]
 * @return {openppg.message.Message}
 */
export function readMessage({armoredText, binary}) {
  if (armoredText) {
    try {
      return openpgp.message.readArmored(armoredText);
    } catch (e) {
      console.log('Error parsing armored text', e);
      throw new mvelo.Error(l10n('message_read_error', [e]), 'ARMOR_PARSE_ERROR');
    }
  } else if (binary) {
    try {
      return openpgp.message.read(binary);
    } catch (e) {
      console.log('Error parsing binary file', e);
      throw new mvelo.Error(l10n('file_read_error', [e]), 'BINARY_PARSE_ERROR');
    }
  } else {
    throw new Error('No message to read');
  }
}

/**
 * Encrypt PGP message
 * @param {String} options.data - as native JavaScript string
 * @param {String} options.keyringId
 * @param  {Function} options.unlockKey - callback to unlock key
 * @param {Array<String>} options.encryptionKeyIds - key Id of encryption keys
 * @param {String} options.signingKeyId - key Id of signing key
 * @param {String} options.uiLogSource - UI source that triggered encryption, used for logging
 * @return {Promise<String>} - armored PGP message
 */
export async function encryptMessage({data, keyringId, unlockKey, encryptionKeyIds, signingKeyId, uiLogSource}) {
  const keyring = getKeyringWithPrivKey(signingKeyId, keyringId);
  if (!keyring) {
    throw new mvelo.Error('No primary key found', 'NO_PRIMARY_KEY_FOUND');
  }
  await syncPublicKeys(keyring, encryptionKeyIds);
  try {
    const result = await keyring.getPgpBackend().encrypt({data, keyring, unlockKey, encryptionKeyIds, signingKeyId});
    logEncryption(uiLogSource, keyring, encryptionKeyIds);
    return result;
  } catch (e) {
    console.log('getPgpBackend().encrypt() error', e);
    throw new mvelo.Error(l10n('encrypt_error', [e]), 'ENCRYPT_ERROR');
  }
}

/**
 * Log encryption operation
 * @param  {String} source - source that triggered encryption operation
 * @param {KeyringBase} keyring
 * @param  {Array<String>} keyIds - key ID of used keys
 */
function logEncryption(source, keyring, keyIds) {
  if (source) {
    const keys = keyring.getKeysByIds(keyIds);
    const recipients = keys.map(key => getUserId(key, false));
    uiLog.push(source, l10n('security_log_encryption_operation', [recipients.join(', ')]));
  }
}

export function readCleartextMessage(armoredText, keyringId) {
  const result = {};
  try {
    result.message = openpgp.cleartext.readArmored(armoredText);
  } catch (e) {
    console.log('openpgp.cleartext.readArmored', e);
    throw {
      message: l10n('cleartext_read_error', [e])
    };
  }

  result.signers = [];
  const signingKeyIds = result.message.getSigningKeyIds();
  if (signingKeyIds.length === 0) {
    throw {
      message: 'No signatures found'
    };
  }
  for (let i = 0; i < signingKeyIds.length; i++) {
    const signer = {};
    signer.keyid = signingKeyIds[i].toHex();
    signer.key = getKeyringById(keyringId).keystore.getKeysForId(signer.keyid, true);
    signer.key = signer.key ? signer.key[0] : null;
    if (signer.key) {
      signer.userid = getUserId(signer.key);
    }
    result.signers.push(signer);
  }

  return result;
}

export function verifyMessage(message, signers) {
  return Promise.resolve()
  .then(() => {
    const keys = signers.map(signer => signer.key).filter(key => key !== null);
    return openpgp.verify({message, publicKeys: keys});
  })
  .then(({signatures}) => {
    signers = signers.map(signer => {
      signer.valid = signer.key && signatures.some(verifiedSig => signer.keyid === verifiedSig.keyid.toHex() && verifiedSig.valid);
      // remove key object
      delete signer.key;
      return signer;
    });
    return signers;
  })
  .catch(e => {
    throw {
      message: l10n('verify_error', [e])
    };
  });
}

/**
 * @param {String} message
 * @param {String} signKey
 * @return {Promise<String>}
 */
export function signMessage(message, signKey) {
  return openpgp.sign({data: message, privateKeys: signKey})
  .then(msg => msg.data);
}

export function createPrivateKeyBackup(primaryKey, keyPwd) {
  let backupCode;
  return Promise.resolve()
  .then(() => {
    // create backup code
    backupCode = randomString(26);
    // create packet structure
    const packetList = new openpgp.packet.List();
    const literal = new openpgp.packet.Literal();
    let text = 'Version: 1\n';
    text += `Pwd: ${keyPwd}\n`;
    literal.setText(text);
    packetList.push(literal);
    packetList.concat(primaryKey.toPacketlist());
    // symmetrically encrypt with backup code
    const msg = new openpgp.message.Message(packetList);
    return symEncrypt(msg, backupCode);
  })
  .then(msg => ({backupCode, message: msg.armor()}));
}

function parseMetaInfo(txt) {
  const result = {};
  txt.replace(/\r/g, '').split('\n').forEach(row => {
    if (row.length) {
      const keyValue = row.split(/:\s/);
      result[keyValue[0]] = keyValue[1];
    }
  });
  return result;
}

export function restorePrivateKeyBackup(armoredBlock, code) {
  //console.log('restorePrivateKeyBackup', armoredBlock);
  return Promise.resolve()
  .then(() => {
    const message = openpgp.message.readArmored(armoredBlock);
    if (!(message.packets.length === 2 &&
          message.packets[0].tag === 3 && // Symmetric-Key Encrypted Session Key Packet
          message.packets[0].sessionKeyAlgorithm === 'aes256' &&
          (message.packets[0].sessionKeyEncryptionAlgorithm === null || message.packets[0].sessionKeyEncryptionAlgorithm === 'aes256') &&
          message.packets[1].tag === 18 // Sym. Encrypted Integrity Protected Data Packet
    )) {
      throw {message: 'Illegal private key backup structure.'};
    }
    return message.decrypt(null, null, code)
    .catch(() => {
      throw {message: 'Could not decrypt message with this restore code', code: 'WRONG_RESTORE_CODE'};
    });
  })
  .then(message => {
    // extract password
    const pwd = parseMetaInfo(message.getText()).Pwd;
    // remove literal data packet
    const keyPackets = message.packets.slice(1);
    const privKey =  new openpgp.key.Key(keyPackets);
    return {key: privKey, password: pwd};
  })
  .catch(error => {
    throw mvelo.util.mapError(error);
  });
}

/**
 * @param  {openpgp.key.Key} key - key to decrypt and verify signature
 * @param  {openpgp.message.Message} message - sync packet
 * @return {Promise<Object,Error>}
 */
export function decryptSyncMessage(key, message) {
  return openpgp.decrypt({message, privateKey: key, publicKeys: key})
  .then(msg => {
    // check signature
    const sig = msg.signatures[0];
    if (!(sig && sig.valid && sig.keyid.equals(key.getSigningKeyPacket().getKeyId()))) {
      throw new Error('Signature of synced keyring is invalid');
    }
    const syncData = JSON.parse(msg.data);
    const publicKeys = [];
    const changeLog = {};
    let fingerprint;
    for (fingerprint in syncData.insertedKeys) {
      publicKeys.push({
        type: 'public',
        armored: syncData.insertedKeys[fingerprint].armored
      });
      changeLog[fingerprint] = {
        type: keyringSync.INSERT,
        time: syncData.insertedKeys[fingerprint].time
      };
    }
    for (fingerprint in syncData.deletedKeys) {
      changeLog[fingerprint] = {
        type: keyringSync.DELETE,
        time: syncData.deletedKeys[fingerprint].time
      };
    }
    return {
      changeLog,
      keys: publicKeys
    };
  });
}

/**
 * @param  {Key} key - used to sign and encrypt the package
 * @param  {Object} changeLog
 * @param  {String} keyringId - selects keyring for the sync
 * @return {Promise<Object, Error>} - the encrypted message and the own public key
 */
export async function encryptSyncMessage(key, changeLog, keyringId) {
  let syncData = {};
  syncData.insertedKeys = {};
  syncData.deletedKeys = {};
  const keyStore = getKeyringById(keyringId).keystore;
  keyStore.publicKeys.keys.forEach(pubKey => {
    convertChangeLog(pubKey, changeLog, syncData);
  });
  keyStore.privateKeys.keys.forEach(privKey => {
    convertChangeLog(privKey.toPublic(), changeLog, syncData);
  });
  for (const fingerprint in changeLog) {
    if (changeLog[fingerprint].type === keyringSync.DELETE) {
      syncData.deletedKeys[fingerprint] = {
        time: changeLog[fingerprint].time
      };
    }
  }
  syncData = JSON.stringify(syncData);
  const msg = await openpgp.encrypt({data: syncData, publicKeys: key, privateKeys: key});
  return msg.data;
}

function convertChangeLog(key, changeLog, syncData) {
  const fingerprint = key.primaryKey.getFingerprint();
  const logEntry = changeLog[fingerprint];
  if (!logEntry) {
    console.log(`Key ${fingerprint} in keyring but not in changeLog.`);
    return;
  }
  if (logEntry.type === keyringSync.INSERT) {
    syncData.insertedKeys[fingerprint] = {
      armored: key.armor(),
      time: logEntry.time
    };
  } else if (logEntry.type === keyringSync.DELETE) {
    console.log(`Key ${fingerprint} in keyring but has DELETE in changeLog.`);
  } else {
    console.log('Invalid changeLog type:', logEntry.type);
  }
}

export function encryptFile({plainFile, receipients, armor}) {
  let keys;
  return Promise.resolve()
  .then(() => {
    keys = receipients.map(receipient => {
      const keyArray = getKeyringById(receipient.keyringId).keystore.getKeysForId(receipient.keyid);
      return keyArray ? keyArray[0] : null;
    }).filter(key => key !== null);
    if (keys.length === 0) {
      throw {message: 'No key found for encryption'};
    }
    const content = mvelo.util.dataURL2str(plainFile.content);
    const data = mvelo.util.str2Uint8Array(content);
    return openpgp.encrypt({data, publicKeys: keys, filename: plainFile.name, armor});
  })
  .then(msg => {
    logEncryption('security_log_encrypt_dialog', keys);
    if (armor) {
      return msg.data;
    } else {
      return mvelo.util.Uint8Array2str(msg.message.packets.write());
    }
  })
  .catch(e => {
    console.log('openpgp.encrypt() error', e);
    throw {message: l10n('encrypt_error', [e.message])};
  });
}

export async function decryptFile(encryptedFile, unlockKey) {
  let armoredText;
  let binary;
  try {
    const content = mvelo.util.dataURL2str(encryptedFile.content);
    if (/^-----BEGIN PGP MESSAGE-----/.test(content)) {
      armoredText = content;
    } else {
      binary = mvelo.util.str2Uint8Array(content);
    }
    const message = readMessage({armoredText, binary});
    const encryptionKeyIds = message.getEncryptionKeyIds();
    const keyring = getKeyringWithPrivKey(encryptionKeyIds);
    if (!keyring) {
      throw noKeyFoundError(encryptionKeyIds);
    }
    const result = await keyring.getPgpBackend().decrypt({base64: mvelo.util.dataURL2base64(encryptedFile.content), message, keyring, unlockKey, encryptionKeyIds, format: 'binary'});
    return {
      name: result.filename || encryptedFile.name.slice(0, -4),
      content: mvelo.util.Uint8Array2str(result.data)
    };
  } catch (error) {
    console.log('pgpModel.decryptFile() error', error);
    throw mvelo.util.mapError(error);
  }
}
