/**
 * Implements the ActiveSync protocol for Hotmail and Exchange.
 **/

define(
  [
    'mailcomposer',
    'wbxml',
    'activesync/codepages',
    'activesync/protocol',
    '../a64',
    './folder',
    './jobs',
    '../util',
    'exports'
  ],
  function(
    $mailcomposer,
    $wbxml,
    $ascp,
    $activesync,
    $a64,
    $asfolder,
    $asjobs,
    $util,
    exports
  ) {
'use strict';

const bsearchForInsert = $util.bsearchForInsert;

function ActiveSyncAccount(universe, accountDef, folderInfos, dbConn,
                           receiveProtoConn, _LOG) {
  this.universe = universe;
  this.id = accountDef.id;
  this.accountDef = accountDef;

  this.conn = new $activesync.Connection(accountDef.credentials.username,
                                         accountDef.credentials.password);
  this._db = dbConn;

  this._jobDriver = new $asjobs.ActiveSyncJobDriver(this);

  this.enabled = true;
  this.problems = [];

  this.identities = accountDef.identities;

  var ourIdentity = accountDef.identities[0];
  var ourNameAndAddress = {
    name: ourIdentity.name,
    address: ourIdentity.address,
  };

  this.folders = [];
  this._folderStorages = {};
  this._folderInfos = folderInfos;
  this._serverIdToFolderId = {};
  this._deadFolderIds = null;

  this.meta = folderInfos.$meta;
  this.mutations = folderInfos.$mutations;

  // Sync existing folders
  for (var folderId in folderInfos) {
    if (folderId[0] === '$')
      continue;
    var folderInfo = folderInfos[folderId];

    this._folderStorages[folderId] =
      new $asfolder.ActiveSyncFolderStorage(this, folderInfo, this._db);
    this._serverIdToFolderId[folderInfo.$meta.serverId] = folderId;
    this.folders.push(folderInfo.$meta);
  }
  // TODO: we should probably be smarter about sorting.
  this.folders.sort(function(a, b) { return a.path.localeCompare(b.path); });

  if (this.meta.syncKey != '0') {
    // TODO: this is a really hacky way of syncing folders after the first
    // time.
    var account = this;
    setTimeout(function() { account.syncFolderList(function() {}) }, 1000);
  }
}
exports.ActiveSyncAccount = ActiveSyncAccount;
ActiveSyncAccount.prototype = {
  toString: function asa_toString() {
    return '[ActiveSyncAccount: ' + this.id + ']';
  },

  toBridgeWire: function asa_toBridgeWire() {
    return {
      id: this.accountDef.id,
      name: this.accountDef.name,
      path: this.accountDef.name,
      type: this.accountDef.type,

      enabled: this.enabled,
      problems: this.problems,

      identities: this.identities,

      credentials: {
        username: this.accountDef.credentials.username,
      },

      servers: [
        {
          type: this.accountDef.type,
          connInfo: this.accountDef.connInfo
        },
      ]
    };
  },

  toBridgeFolder: function asa_toBridgeFolder() {
    return {
      id: this.accountDef.id,
      name: this.accountDef.name,
      path: this.accountDef.name,
      type: 'account',
    };
  },

  get numActiveConns() {
    return 0;
  },

  saveAccountState: function asa_saveAccountState(reuseTrans) {
    let perFolderStuff = [];
    for (let [,folder] in Iterator(this.folders)) {
      let folderStuff = this._folderStorages[folder.id]
                           .generatePersistenceInfo();
      if (folderStuff)
        perFolderStuff.push(folderStuff);
    }

    let trans = this._db.saveAccountFolderStates(
      this.id, this._folderInfos, perFolderStuff, this._deadFolderIds,
      function stateSaved() {},
      reuseTrans);
    this._deadFolderIds = null;
    return trans;
  },

  shutdown: function asa_shutdown() {
  },

  sliceFolderMessages: function asa_sliceFolderMessages(folderId,
                                                        bridgeHandle) {
    this._folderStorages[folderId]._sliceFolderMessages(bridgeHandle);
  },

  syncFolderList: function asa_syncFolderList(callback) {
    let account = this;

    const fh = $ascp.FolderHierarchy.Tags;
    let w = new $wbxml.Writer('1.3', 1, 'UTF-8');
    w.stag(fh.FolderSync)
       .tag(fh.SyncKey, this.meta.syncKey)
     .etag();

    this.conn.doCommand(w, function(aError, aResponse) {
      let e = new $wbxml.EventParser();
      let deferredAddedFolders = [];

      e.addEventListener([fh.FolderSync, fh.SyncKey], function(node) {
        account.meta.syncKey = node.children[0].textContent;
      });

      e.addEventListener([fh.FolderSync, fh.Changes, [fh.Add, fh.Delete]],
                         function(node) {
        let folder = {};
        for (let [,child] in Iterator(node.children))
          folder[child.localTagName] = child.children[0].textContent;

        if (node.tag === fh.Add) {
          if (!account._addedFolder(folder.ServerId, folder.ParentId,
                                    folder.DisplayName, folder.Type))
            deferredAddedFolders.push(folder);
        }
        else {
          account._deletedFolder(folder.ServerId);
        }
      });

      e.run(aResponse);

      // It's possible we got some folders in an inconvenient order (i.e. child
      // folders before their parents). Keep trying to add folders until we're
      // done.
      while (deferredAddedFolders.length) {
        let moreDeferredAddedFolders = [];
        for (let [,folder] in Iterator(deferredAddedFolders)) {
          if (!account._addedFolder(folder.ServerId, folder.ParentId,
                                    folder.DisplayName, folder.Type))
            moreDeferredAddedFolders.push(folder);
        }
        if (moreDeferredAddedFolders.length === deferredAddedFolders.length)
          throw new Error('got some orphaned folders');
        deferredAddedFolders = moreDeferredAddedFolders;
      }

      account.saveAccountState();
      callback();
    });
  },

  // Map folder type numbers from ActiveSync to Gaia's types
  _folderTypes: {
     1: 'normal', // User-created generic folder
     2: 'inbox',
     3: 'drafts',
     4: 'trash',
     5: 'sent',
     6: 'normal', // Outbox, actually
    12: 'normal', // User-created mail folder
  },

  /**
   * Update the internal database and notify the appropriate listeners when we
   * discover a new folder.
   *
   * @param {string} serverId A GUID representing the new folder
   * @param {string} parentId A GUID representing the parent folder, or '0' if
   *   this is a root-level folder
   * @param {string} displayName The display name for the new folder
   * @param {string} typeNum A numeric value representing the new folder's type,
   *   corresponding to the mapping in _folderTypes above
   * @return {object} the folderMeta if we added the folder, true if we don't
   *   care about this kind of folder, or null if we need to wait until later
   *   (e.g. if we haven't added the folder's parent yet)
   */
  _addedFolder: function asa__addedFolder(serverId, parentId, displayName,
                                          typeNum) {
    if (!(typeNum in this._folderTypes))
      return true; // Not a folder type we care about.

    let path = displayName;
    let depth = 0;
    if (parentId !== '0') {
      let parentFolderId = this._serverIdToFolderId[parentId];
      if (parentFolderId === undefined)
        return null;
      let parent = this._folderInfos[parentFolderId];
      path = parent.$meta.path + '/' + path;
      depth = parent.$meta.depth + 1;
    }

    console.log('Added folder ' + displayName + ' (' + folderId + ')');
    let folderId = this.id + '/' + $a64.encodeInt(this.meta.nextFolderNum++);
    let folderInfo = this._folderInfos[folderId] = {
      $meta: {
        id: folderId,
        serverId: serverId,
        name: displayName,
        path: path,
        type: this._folderTypes[typeNum],
        depth: depth,
      },
      $impl: {
        nextHeaderBlock: 0,
        nextBodyBlock: 0,
      },
    };

    this._folderStorages[folderId] = new $asfolder.ActiveSyncFolderStorage(
      this, folderInfo, this._db);
    this._serverIdToFolderId[serverId] = folderId;

    let folderMeta = folderInfo.$meta;
    let idx = bsearchForInsert(this.folders, folderMeta, function(a, b) {
      return a.path.localeCompare(b.path);
    });
    this.folders.splice(idx, 0, folderMeta);

    this.universe.__notifyAddedFolder(this.id, folderMeta);

    return folderMeta;
  },

  /**
   * Update the internal database and notify the appropriate listeners when we
   * find out a folder has been removed.
   *
   * @param {string} serverId A GUID representing the deleted folder
   */
  _deletedFolder: function asa__deletedFolder(serverId) {
    let folderId = this._serverIdToFolderId[serverId],
        folderInfo = this._folderInfos[folderId],
        folderMeta = folderInfo.$meta;

    console.log('Deleted folder ' + folderMeta.name + ' (' + folderId + ')');
    delete this._serverIdToFolderId[serverId];
    delete this._folderInfos[folderId];
    delete this._folderStorages[folderId];

    var idx = this.folders.indexOf(folderMeta);
    this.folders.splice(idx, 1);

    if (this._deadFolderIds === null)
      this._deadFolderIds = [];
    this._deadFolderIds.push(folderId);

    this.universe.__notifyRemovedFolder(this.id, folderMeta);
  },

  /**
   * Create a folder that is the child/descendant of the given parent folder.
   * If no parent folder id is provided, we attempt to create a root folder.
   *
   * @args[
   *   @param[parentFolderId String]
   *   @param[folderName]
   *   @param[containOnlyOtherFolders Boolean]{
   *     Should this folder only contain other folders (and no messages)?
   *     On some servers/backends, mail-bearing folders may not be able to
   *     create sub-folders, in which case one would have to pass this.
   *   }
   *   @param[callback @func[
   *     @args[
   *       @param[error @oneof[
   *         @case[null]{
   *           No error, the folder got created and everything is awesome.
   *         }
   *         @case['offline']{
   *           We are offline and can't create the folder.
   *         }
   *         @case['already-exists']{
   *           The folder appears to already exist.
   *         }
   *         @case['unknown']{
   *           It didn't work and we don't have a better reason.
   *         }
   *       ]]
   *       @param[folderMeta ImapFolderMeta]{
   *         The meta-information for the folder.
   *       }
   *     ]
   *   ]]{
   *   }
   * ]
   */
  createFolder: function asa_createFolder(parentFolderId, folderName,
                                          containOnlyOtherFolders, callback) {
    let account = this;
    let parentFolderServerId = parentFolderId ?
      this._folderInfos[parentFolderId] : '0';

    const fh = $ascp.FolderHierarchy.Tags;
    const fhStatus = $ascp.FolderHierarchy.Enums.Status;
    const folderType = $ascp.FolderHierarchy.Enums.Type.Mail;

    let w = new $wbxml.Writer('1.3', 1, 'UTF-8');
    w.stag(fh.FolderCreate)
       .tag(fh.SyncKey, this.meta.syncKey)
       .tag(fh.ParentId, parentFolderServerId)
       .tag(fh.DisplayName, folderName)
       .tag(fh.Type, folderType)
     .etag();

    this.conn.doCommand(w, function(aError, aResponse) {
      let e = new $wbxml.EventParser();
      let status, serverId;

      e.addEventListener([fh.FolderCreate, fh.Status], function(node) {
        status = node.children[0].textContent;
      });
      e.addEventListener([fh.FolderCreate, fh.SyncKey], function(node) {
        account.meta.syncKey = node.children[0].textContent;
      });
      e.addEventListener([fh.FolderCreate, fh.ServerId], function(node) {
        serverId = node.children[0].textContent;
      });

      e.run(aResponse);

      if (status === fhStatus.Success) {
        let folderMeta = account._addedFolder(serverId, parentFolderServerId,
                                              folderName, folderType);
        callback(null, folderMeta);
      }
      else if (status === fhStatus.FolderExists) {
        callback('already-exists');
      }
      else {
        callback('unknown');
      }
    });
  },

  /**
   * Delete an existing folder WITHOUT ANY ABILITY TO UNDO IT.  Current UX
   * does not desire this, but the unit tests do.
   *
   * Callback is like the createFolder one, why not.
   */
  deleteFolder: function asa_deleteFolder(folderId, callback) {
    let account = this;
    let folderMeta = this._folderInfos[folderId].$meta;

    const fh = $ascp.FolderHierarchy.Tags;
    const fhStatus = $ascp.FolderHierarchy.Enums.Status;
    const folderType = $ascp.FolderHierarchy.Enums.Type.Mail;

    let w = new $wbxml.Writer('1.3', 1, 'UTF-8');
    w.stag(fh.FolderDelete)
       .tag(fh.SyncKey, this.meta.syncKey)
       .tag(fh.ServerId, folderMeta.serverId)
     .etag();

    this.conn.doCommand(w, function(aError, aResponse) {
      let e = new $wbxml.EventParser();
      let status;

      e.addEventListener([fh.FolderDelete, fh.Status], function(node) {
        status = node.children[0].textContent;
      });
      e.addEventListener([fh.FolderDelete, fh.SyncKey], function(node) {
        account.meta.syncKey = node.children[0].textContent;
      });

      e.run(aResponse);
      if (status === fhStatus.Success) {
        account._deletedFolder(folderMeta.serverId);
        callback(null, folderMeta);
      }
      else {
        callback('unknown');
      }
    });
  },

  sendMessage: function asa_sendMessage(composedMessage, callback) {
    // XXX: This is very hacky and gross. Fix it to use pipes later.
    composedMessage._cacheOutput = true;
    composedMessage._composeMessage();

    const cm = $ascp.ComposeMail.Tags;
    let w = new $wbxml.Writer('1.3', 1, 'UTF-8');
    w.stag(cm.SendMail)
       .tag(cm.ClientId, Date.now().toString()+'@mozgaia')
       .tag(cm.SaveInSentItems)
       .stag(cm.Mime)
         .opaque(composedMessage._outputBuffer)
       .etag()
     .etag();

    this.conn.doCommand(w, function(aError, aResponse) {
      if (aResponse === null)
        callback(null);
      else {
        dump('Error sending message. XML dump follows:\n' + aResponse.dump() +
             '\n');
      }
    });
  },

  getFolderStorageForFolderId: function asa_getFolderStorageForFolderId(
                               folderId) {
    return this._folderStorages[folderId];
  },

  getFolderStorageForServerId: function asa_getFolderStorageForServerId(
                               serverId) {
    return this._folderStorages[this._serverIdToFolderId[serverId]];
  },

  runOp: function asa_runOp(op, mode, callback) {
    dump('runOp('+JSON.stringify(op)+', '+mode+', '+callback+')\n');

    let methodName = mode + '_' + op.type;
    let isLocal = /^local_/.test(mode);

    if (!isLocal)
      op.status = mode + 'ing';

    if (!(methodName in this._jobDriver))
      throw new Error("Unsupported op: '" + op.type + "' (mode: " + mode + ")");

    if (callback) {
      this._jobDriver[methodName](op, function(error) {
        if (!isLocal)
          op.status = mode + 'ne';
        callback(error);
      });
    }
    else {
      this._jobDriver[methodName](op);
      if (!isLocal)
        op.status = mode + 'ne';
    }
  },
};

}); // end define