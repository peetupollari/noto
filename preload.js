const { contextBridge, ipcRenderer, webFrame } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // simple calls used by your buttons
  createFolder: async (folderPath) => ipcRenderer.invoke('create-folder', folderPath),
  createFile: async (filePath, content) => ipcRenderer.invoke('create-file', filePath, content),
  deletePath: async (relativePath) => ipcRenderer.invoke('delete-path', relativePath),
  renamePath: async (sourcePath, nextName) => ipcRenderer.invoke('rename-path', sourcePath, nextName),
  movePath: async (sourcePath, destinationFolderPath) => ipcRenderer.invoke('move-path', sourcePath, destinationFolderPath),
  getTrashItems: async () => ipcRenderer.invoke('get-trash-items'),
  deleteTrashItems: async (trashPaths) => ipcRenderer.invoke('delete-trash-items', trashPaths),
  restoreTrashItems: async (trashPaths) => ipcRenderer.invoke('restore-trash-items', trashPaths),
  // settings helpers
  getSaveLocation: async () => ipcRenderer.invoke('get-save-location'),
  chooseSaveLocation: async () => ipcRenderer.invoke('choose-save-location'),
  getAppBehaviorSettings: async () => ipcRenderer.invoke('get-app-behavior-settings'),
  getAppReleaseInfo: async () => ipcRenderer.invoke('get-app-release-info'),
  checkForAppUpdate: async () => ipcRenderer.invoke('check-for-app-update'),
  installAppUpdateNow: async () => ipcRenderer.invoke('install-app-update-now'),
  setAppBehaviorSettings: async (settings) => ipcRenderer.invoke('set-app-behavior-settings', settings),
  resetLocalAppState: async (confirmationText) => ipcRenderer.invoke('reset-local-app-state', { confirmationText }),
  getWhatsNew: async () => ipcRenderer.invoke('get-whats-new'),
  openImportFiles: async () => ipcRenderer.invoke('open-import-files'),
  chooseNotePdfExportPath: async (payload) => ipcRenderer.invoke('choose-note-pdf-export-path', payload),
  exportNotePdf: async (payload) => ipcRenderer.invoke('export-note-pdf', payload),
  // Presentation Mode
  getDisplays: async () => ipcRenderer.invoke('get-displays'),
  openPresentation: async (data) => ipcRenderer.invoke('open-presentation', data),
  closePresentation: async () => ipcRenderer.invoke('close-presentation'),
  // Signal that presentation window DOM is ready
  presentationReady: () => ipcRenderer.send('presentation-ready'),
  // Send real-time updates to presentation window
  updatePresentation: (content) => ipcRenderer.send('update-presentation', content),
  updatePresentationScroll: (payload) => ipcRenderer.send('update-presentation-scroll', payload),
  setPresentationFrozen: (payload) => ipcRenderer.send('set-presentation-frozen', payload)
  ,
  onAutoUpdateState: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('auto-update-state', handler);
    return () => ipcRenderer.removeListener('auto-update-state', handler);
  }
});

contextBridge.exposeInMainWorld('electronAPI', {
  // existing filesystem and window control methods
  getFiles: (relPath) => ipcRenderer.invoke('get-files', relPath),
  readNote: (relPath) => ipcRenderer.invoke('read-note', relPath),
  getNoteStats: (relPath) => ipcRenderer.invoke('get-note-stats', relPath),
  saveNote: (relPath, content) => ipcRenderer.invoke('save-note', relPath, content),
  // window controls
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  setZoomFactor: (factor) => {
    const parsed = Number(factor);
    if (!Number.isFinite(parsed)) return false;
    const safeFactor = Math.max(0.6, Math.min(1.6, parsed));
    webFrame.setZoomFactor(safeFactor);
    return true;
  },
  confirmClose: () => ipcRenderer.send('window-close-approved'),
  onCloseRequested: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const handler = () => callback();
    ipcRenderer.on('app-close-requested', handler);
    return () => ipcRenderer.removeListener('app-close-requested', handler);
  },
  // open external URL in default browser
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  // app state persistence
  saveAppState: (state) => ipcRenderer.invoke('save-app-state', state),
  loadAppState: () => ipcRenderer.invoke('load-app-state'),
  consumePendingJumpOpen: () => ipcRenderer.invoke('consume-pending-jump-open'),
  consumePendingTrayCreateNote: () => ipcRenderer.invoke('consume-pending-tray-create-note'),
  onJumpOpen: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('jump-open', handler);
    return () => ipcRenderer.removeListener('jump-open', handler);
  },
  onTrayCreateNote: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const handler = () => callback();
    ipcRenderer.on('tray-create-note', handler);
    return () => ipcRenderer.removeListener('tray-create-note', handler);
  },
  // Receiver for presentation mode content
  onReceivePresentationContent: (callback) => ipcRenderer.on('set-presentation-content', (_event, content) => callback(content)),
  onReceivePresentationScroll: (callback) => ipcRenderer.on('set-presentation-scroll', (_event, payload) => callback(payload)),
  onReceivePresentationFrozen: (callback) => ipcRenderer.on('set-presentation-frozen', (_event, payload) => callback(payload)),
  onPresentationStateChange: (callback) => ipcRenderer.on('presentation-state-changed', (_event, state) => callback(state))
});

contextBridge.exposeInMainWorld('authAPI', {
  getState: () => ipcRenderer.invoke('auth-get-state'),
  signIn: (email, password) => ipcRenderer.invoke('auth-sign-in', { email, password }),
  signUp: (email, password) => ipcRenderer.invoke('auth-sign-up', { email, password }),
  signOut: () => ipcRenderer.invoke('auth-sign-out'),
  deleteAccount: () => ipcRenderer.invoke('auth-delete-account'),
  getPassword: () => ipcRenderer.invoke('auth-get-password')
});

contextBridge.exposeInMainWorld('paymentAPI', {
  getState: () => ipcRenderer.invoke('payment-get-state'),
  openCheckout: () => ipcRenderer.invoke('payment-open-checkout'),
  refreshStatus: () => ipcRenderer.invoke('payment-refresh-status'),
  getNextPage: () => ipcRenderer.invoke('payment-get-next-page')
});

contextBridge.exposeInMainWorld('whatsNewAPI', {
  getState: () => ipcRenderer.invoke('whats-new-get-state'),
  complete: () => ipcRenderer.invoke('whats-new-complete')
});

contextBridge.exposeInMainWorld('cloudAPI', {
  upsertNote: (payload) => ipcRenderer.invoke('cloud-upsert-note', payload),
  updateNote: (payload) => ipcRenderer.invoke('cloud-update-note', payload),
  getNote: (payload) => ipcRenderer.invoke('cloud-get-note', payload),
  listNoteVersions: (payload) => ipcRenderer.invoke('cloud-list-note-versions', payload),
  getNoteVersion: (payload) => ipcRenderer.invoke('cloud-get-note-version', payload),
  deleteNote: (payload) => ipcRenderer.invoke('cloud-delete-note', payload),
  listInvites: () => ipcRenderer.invoke('cloud-list-invites'),
  deleteInvite: (payload) => ipcRenderer.invoke('cloud-delete-invite', payload),
  sendInvites: (payload) => ipcRenderer.invoke('cloud-send-invites', payload),
  acceptInvite: (payload) => ipcRenderer.invoke('cloud-accept-invite', payload),
  listCollaborators: (payload) => ipcRenderer.invoke('cloud-list-collaborators', payload),
  updateCollaboratorRole: (payload) => ipcRenderer.invoke('cloud-update-collaborator-role', payload),
  removeCollaborator: (payload) => ipcRenderer.invoke('cloud-remove-collaborator', payload),
  listCollaborations: () => ipcRenderer.invoke('cloud-list-collaborations'),
  getStorageUsage: () => ipcRenderer.invoke('cloud-get-storage-usage'),
  upsertPresence: (payload) => ipcRenderer.invoke('cloud-upsert-presence', payload),
  clearPresence: (payload) => ipcRenderer.invoke('cloud-clear-presence', payload),
  listPresence: (payload) => ipcRenderer.invoke('cloud-list-presence', payload)
});
