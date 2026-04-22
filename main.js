const { app, BrowserWindow, ipcMain, dialog, shell, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { Menu, Tray, nativeImage } = require('electron');

let mainWindow;
let presentationWin = null; // Track the presentation window
let cachedPresentationContent = ''; // Store content temporarily
let cachedPresentationScroll = { ratio: 0 };
let cachedPresentationFrozen = false;

// Settings file location
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');
const DEFAULT_BASE = path.join(app.getPath('documents'), 'all_folders');
const TRASH_DIR_NAME = '.noto_bin';
const TRASH_ITEMS_DIR_NAME = 'items';
const TRASH_META_FILE_NAME = 'trash-meta.json';
const AUTH_SESSION_FILE = path.join(app.getPath('userData'), 'auth-session.json');
const AUTH_PASSWORD_FILE = path.join(app.getPath('userData'), 'auth-password.json');
const PROJECT_SUPABASE_CONFIG_FILE = path.join(__dirname, 'supabase.config.json');
const PROJECT_CLOUD_STORAGE_CONFIG_FILE = path.join(__dirname, 'cloud-storage.config.json');
const APP_PACKAGE_FILE = path.join(__dirname, 'package.json');
const APP_RELEASE_CONFIG_FILE = path.join(__dirname, 'app-release.config.json');
const DEFAULT_CLOUD_STORAGE_BUCKET = 'noto-cloud-notes';
const DEFAULT_CLOUD_STORAGE_PREFIX = 'notes';
const DEFAULT_GLOBAL_USER_QUOTA_KB = 1000;
const CLOUD_MANIFEST_CACHE_MS = 15 * 1000;
const WINDOWS_APP_USER_MODEL_ID = 'com.noto.app';
const JUMP_OPEN_NOTE_ARG_PREFIX = '--open-note=';
const JUMP_OPEN_FOLDER_ARG_PREFIX = '--open-folder=';
const JUMP_LIST_RECENT_LIMIT = 3;
const SUPPORTED_EXTERNAL_NOTE_EXTENSIONS = new Set(['.md', '.markdown', '.txt']);

let supabaseClient = null;
let supabaseConfigError = '';

const cloudManifestCache = new Map();
let pendingJumpOpenRequest = null;
let pendingTrayCreateNoteRequest = false;
let jumpListRefreshTimer = null;
let trayIcon = null;
let isExplicitQuitRequested = false;
let quitGuardRequestInFlight = false;

function readSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
      return JSON.parse(raw || '{}');
    }
  } catch (e) {
    console.error('Failed to read settings:', e);
  }
  return {};
}

function writeSettings(obj) {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(obj, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('Failed to write settings:', e);
    return false;
  }
}

const DEFAULT_APP_BEHAVIOR_SETTINGS = Object.freeze({
  closeAppOnWindowClose: false,
  openOnSystemStart: false
});

function hasSeenWelcomeScreen() {
  const settings = readSettingsObject();
  if (Object.prototype.hasOwnProperty.call(settings, 'hasSeenWelcomeScreen')) {
    return Boolean(settings.hasSeenWelcomeScreen);
  }
  const hasExistingUsage =
    fs.existsSync(APP_STATE_FILE)
    || fs.existsSync(AUTH_SESSION_FILE)
    || fs.existsSync(AUTH_PASSWORD_FILE);
  return hasExistingUsage;
}

function markWelcomeScreenSeen() {
  const nextSettings = {
    ...readSettingsObject(),
    hasSeenWelcomeScreen: true
  };
  return writeSettings(nextSettings);
}

function readSettingsObject() {
  const parsed = readSettings();
  return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
}

function normalizeAppBehaviorSettings(raw = {}) {
  const source = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  return {
    closeAppOnWindowClose: Boolean(source.closeAppOnWindowClose),
    openOnSystemStart: Boolean(source.openOnSystemStart)
  };
}

function readAppBehaviorSettings() {
  return {
    ...DEFAULT_APP_BEHAVIOR_SETTINGS,
    ...normalizeAppBehaviorSettings(readSettingsObject())
  };
}

function writeAppBehaviorSettings(partial = {}) {
  const nextSettings = {
    ...readSettingsObject(),
    ...partial
  };
  const normalized = normalizeAppBehaviorSettings(nextSettings);
  nextSettings.closeAppOnWindowClose = normalized.closeAppOnWindowClose;
  nextSettings.openOnSystemStart = normalized.openOnSystemStart;
  if (!writeSettings(nextSettings)) return null;
  return normalized;
}

function supportsOpenOnSystemStartSetting() {
  return (
    (process.platform === 'win32' || process.platform === 'darwin')
    && typeof app.setLoginItemSettings === 'function'
    && typeof app.getLoginItemSettings === 'function'
  );
}

function buildLoginItemSettingsQuery() {
  if (process.platform === 'win32' && process.defaultApp) {
    return {
      path: process.execPath,
      args: [app.getAppPath()]
    };
  }
  return {};
}

function readOpenOnSystemStartState() {
  if (!supportsOpenOnSystemStartSetting()) return false;
  try {
    const settings = app.getLoginItemSettings(buildLoginItemSettingsQuery());
    return Boolean(settings && settings.openAtLogin);
  } catch (error) {
    return false;
  }
}

function applyOpenOnSystemStartSetting(enabled) {
  if (!supportsOpenOnSystemStartSetting()) {
    throw new Error('Open on computer start is not supported on this platform.');
  }
  const desired = Boolean(enabled);
  app.setLoginItemSettings({
    ...buildLoginItemSettingsQuery(),
    openAtLogin: desired
  });
  return readOpenOnSystemStartState();
}

function syncStoredOpenOnSystemStartSetting() {
  if (!supportsOpenOnSystemStartSetting()) return readAppBehaviorSettings();
  const stored = readAppBehaviorSettings();
  try {
    const actual = applyOpenOnSystemStartSetting(stored.openOnSystemStart);
    return writeAppBehaviorSettings({ openOnSystemStart: actual }) || stored;
  } catch (error) {
    return stored;
  }
}

function getBaseDir() {
  const s = readSettings();
  const dir = (s && s.saveLocation) ? s.saveLocation : DEFAULT_BASE;
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    console.error('Could not ensure base dir exists:', e);
  }
  return dir;
}

function normalizeRelativePath(relPath = '') {
  return String(relPath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

function getImportMimeType(filePath = '') {
  const ext = String(path.extname(String(filePath || '')).toLowerCase());
  switch (ext) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    case '.bmp': return 'image/bmp';
    case '.svg': return 'image/svg+xml';
    case '.csv': return 'text/csv';
    default: return '';
  }
}

function isPathInside(parentPath, targetPath) {
  const rel = path.relative(parentPath, targetPath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function resolveInsideBase(relPath = '') {
  const base = getBaseDir();
  const safeRel = normalizeRelativePath(relPath);
  const resolved = path.resolve(base, safeRel || '');
  if (!isPathInside(base, resolved)) throw new Error('Path escapes base directory');
  return resolved;
}

function getAppIconPath() {
  return path.join(__dirname, 'src', 'img', 'notologo.png');
}

function decodeJumpArgValue(rawValue = '') {
  const raw = String(rawValue || '');
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch (error) {
    return raw;
  }
}

function getResolvedExistingFilePath(rawValue = '') {
  const value = String(rawValue || '').trim();
  if (!value || value.startsWith('-')) return '';
  let candidate = '';
  try {
    candidate = path.resolve(value);
  } catch (error) {
    return '';
  }
  if (!candidate || !fs.existsSync(candidate)) return '';
  try {
    return fs.statSync(candidate).isFile() ? candidate : '';
  } catch (error) {
    return '';
  }
}

function parseLaunchRequest(argv = []) {
  const args = Array.isArray(argv) ? argv : [];
  let notePath = '';
  let folderPath = '';
  let externalFilePath = '';
  const defaultAppScriptPath = process.defaultApp
    ? path.resolve(process.argv[1] || app.getAppPath())
    : '';
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = String(arg || '').trim();
    if (!value) continue;
    if (value.startsWith(JUMP_OPEN_NOTE_ARG_PREFIX)) {
      notePath = normalizeRelativePath(decodeJumpArgValue(value.slice(JUMP_OPEN_NOTE_ARG_PREFIX.length)));
      continue;
    }
    if (value.startsWith(JUMP_OPEN_FOLDER_ARG_PREFIX)) {
      folderPath = normalizeRelativePath(decodeJumpArgValue(value.slice(JUMP_OPEN_FOLDER_ARG_PREFIX.length)));
      continue;
    }
    if (index === 0) continue;
    if (process.defaultApp && index === 1) {
      let resolvedValue = '';
      try {
        resolvedValue = path.resolve(value);
      } catch (error) {}
      if (!resolvedValue || resolvedValue === defaultAppScriptPath) continue;
    }
    if (value.startsWith('-')) continue;
    if (!externalFilePath) {
      externalFilePath = getResolvedExistingFilePath(value);
    }
  }
  if (notePath) return { kind: 'note', path: notePath };
  if (folderPath) return { kind: 'folder', path: folderPath };
  if (externalFilePath) return { kind: 'external-file', path: externalFilePath };
  return null;
}

function quoteLaunchArg(value = '') {
  return `"${String(value || '').replace(/"/g, '\\"')}"`;
}

function buildLaunchArgs(extraArg = '') {
  const pieces = [];
  if (process.defaultApp) {
    const appArg = process.argv[1] || app.getAppPath();
    if (appArg) pieces.push(quoteLaunchArg(appArg));
  }
  const tail = String(extraArg || '').trim();
  if (tail) pieces.push(tail);
  return pieces.join(' ');
}

function getJumpEntryDisplayTitle(relPath, isDirectory) {
  const baseName = path.basename(String(relPath || '').trim());
  if (!baseName) return isDirectory ? 'Folder' : 'Note';
  return isDirectory ? baseName : baseName.replace(/\.md$/i, '');
}

function supportsExternalNoteImport(filePath = '') {
  const ext = String(path.extname(String(filePath || '')).toLowerCase());
  return SUPPORTED_EXTERNAL_NOTE_EXTENSIONS.has(ext);
}

function getTrashRootDir() {
  const trashRoot = path.join(getBaseDir(), TRASH_DIR_NAME);
  if (!fs.existsSync(trashRoot)) fs.mkdirSync(trashRoot, { recursive: true });
  return trashRoot;
}

function getTrashItemsDir() {
  const trashItems = path.join(getTrashRootDir(), TRASH_ITEMS_DIR_NAME);
  if (!fs.existsSync(trashItems)) fs.mkdirSync(trashItems, { recursive: true });
  return trashItems;
}

function getTrashMetaFilePath() {
  return path.join(getTrashRootDir(), TRASH_META_FILE_NAME);
}

function resolveInsideTrash(relPath = '') {
  const trashRoot = getTrashRootDir();
  const safeRel = normalizeRelativePath(relPath);
  const resolved = path.resolve(trashRoot, safeRel || '');
  if (!isPathInside(trashRoot, resolved)) throw new Error('Path escapes trash directory');
  return resolved;
}

function readTrashMeta() {
  try {
    const metaPath = getTrashMetaFilePath();
    if (!fs.existsSync(metaPath)) return [];
    const parsed = JSON.parse(fs.readFileSync(metaPath, 'utf8') || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function writeTrashMeta(entries) {
  const metaPath = getTrashMetaFilePath();
  const payload = Array.isArray(entries) ? entries : [];
  fs.writeFileSync(metaPath, JSON.stringify(payload, null, 2), 'utf8');
}

function movePathWithFallback(sourceAbs, destinationAbs) {
  try {
    fs.renameSync(sourceAbs, destinationAbs);
    return;
  } catch (e) {
    if (!e || e.code !== 'EXDEV') throw e;
  }

  const stat = fs.statSync(sourceAbs);
  if (stat.isDirectory()) {
    fs.cpSync(sourceAbs, destinationAbs, { recursive: true });
    fs.rmSync(sourceAbs, { recursive: true, force: false });
  } else {
    fs.copyFileSync(sourceAbs, destinationAbs);
    fs.unlinkSync(sourceAbs);
  }
}

function buildTrashTreeNode(absPath, deletedAt) {
  const stat = fs.statSync(absPath);
  const node = {
    name: path.basename(absPath),
    trashPath: path.relative(getTrashRootDir(), absPath).replace(/\\/g, '/'),
    isDirectory: stat.isDirectory(),
    deletedAt,
    children: []
  };

  if (node.isDirectory) {
    const children = fs.readdirSync(absPath, { withFileTypes: true });
    node.children = children.map((child) =>
      buildTrashTreeNode(path.join(absPath, child.name), deletedAt)
    );
  }

  return node;
}

function readJsonFileIfExists(filePath, fallback = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw || '{}');
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : fallback;
  } catch (e) {
    return fallback;
  }
}

function readAppReleaseInfo() {
  const packageData = readJsonFileIfExists(APP_PACKAGE_FILE, {});
  const configData = readJsonFileIfExists(APP_RELEASE_CONFIG_FILE, {});
  const version = typeof packageData.version === 'string' && packageData.version.trim()
    ? packageData.version.trim()
    : '0.0.0';
  return {
    version,
    showAlphaBadge: Boolean(configData.showAlphaBadge),
    showBetaBadge: Boolean(configData.showBetaBadge)
  };
}

function toSafePositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.floor(parsed));
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function pickEmbeddedSingle(value) {
  if (Array.isArray(value)) {
    return value.find((entry) => entry && typeof entry === 'object') || null;
  }
  return value && typeof value === 'object' ? value : null;
}

function getEmailDisplayName(email = '') {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return '';
  const localPart = normalized.split('@')[0] || '';
  if (!localPart) return '';
  return localPart
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function getSessionUserDisplayName(session) {
  const metadata = session && session.user && session.user.user_metadata && typeof session.user.user_metadata === 'object'
    ? session.user.user_metadata
    : {};
  return firstNonEmptyString(
    metadata.full_name,
    metadata.name,
    metadata.display_name,
    metadata.preferred_username,
    metadata.user_name,
    metadata.username
  );
}

function isMissingSchemaColumnError(error, columnNames = []) {
  const message = String(error && error.message ? error.message : '').toLowerCase();
  if (!message) return false;
  if (!message.includes('column') && !message.includes('schema cache')) return false;
  return columnNames.some((columnName) => message.includes(String(columnName || '').toLowerCase()));
}

function normalizeStoragePrefix(prefix) {
  const raw = String(prefix || '').trim().replace(/\\/g, '/');
  const stripped = raw.replace(/^\/+/, '').replace(/\/+$/, '');
  return stripped || DEFAULT_CLOUD_STORAGE_PREFIX;
}

function resolveCloudStorageConfig() {
  const fileConfig = readJsonFileIfExists(PROJECT_CLOUD_STORAGE_CONFIG_FILE, {});
  const bucketRaw = DEFAULT_CLOUD_STORAGE_BUCKET;
  const prefixRaw = DEFAULT_CLOUD_STORAGE_PREFIX;
  const quotaRaw =
    process.env.SUPABASE_STORAGE_QUOTA_KB ??
    fileConfig.globalUserQuotaKb ??
    DEFAULT_GLOBAL_USER_QUOTA_KB;
  const globalUserQuotaKb = toSafePositiveInt(quotaRaw, DEFAULT_GLOBAL_USER_QUOTA_KB);
  return {
    bucket: String(bucketRaw || '').trim() || DEFAULT_CLOUD_STORAGE_BUCKET,
    objectPrefix: normalizeStoragePrefix(prefixRaw),
    globalUserQuotaKb,
    globalUserQuotaBytes: globalUserQuotaKb * 1000
  };
}

function buildCloudNoteStoragePath(noteId, storageConfig = resolveCloudStorageConfig()) {
  const safeNoteId = String(noteId || '').trim();
  if (!safeNoteId) return '';
  const prefix = normalizeStoragePrefix(storageConfig.objectPrefix);
  return `${prefix}/collaborations/${safeNoteId}/content.md`;
}

function buildCloudNoteVersionsFolder(noteId, storageConfig = resolveCloudStorageConfig()) {
  const safeNoteId = String(noteId || '').trim();
  if (!safeNoteId) return '';
  const prefix = normalizeStoragePrefix(storageConfig.objectPrefix);
  return `${prefix}/collaborations/${safeNoteId}/versions`;
}

function buildUserManifestStoragePath(userId, storageConfig = resolveCloudStorageConfig()) {
  const safeUserId = String(userId || '').trim();
  if (!safeUserId) return '';
  const prefix = normalizeStoragePrefix(storageConfig.objectPrefix);
  return `${prefix}/users/${safeUserId}/manifest.json`;
}

function buildUserNoteStoragePath(userId, noteId, storageConfig = resolveCloudStorageConfig()) {
  const safeUserId = String(userId || '').trim();
  const safeNoteId = String(noteId || '').trim();
  if (!safeUserId || !safeNoteId) return '';
  const prefix = normalizeStoragePrefix(storageConfig.objectPrefix);
  return `${prefix}/users/${safeUserId}/notes/${safeNoteId}.md`;
}

function buildUserNoteVersionsFolder(userId, noteId, storageConfig = resolveCloudStorageConfig()) {
  const safeUserId = String(userId || '').trim();
  const safeNoteId = String(noteId || '').trim();
  if (!safeUserId || !safeNoteId) return '';
  const prefix = normalizeStoragePrefix(storageConfig.objectPrefix);
  return `${prefix}/users/${safeUserId}/notes/${safeNoteId}/versions`;
}

function makeStorageVersionTag() {
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rnd}`;
}

function buildVersionedCloudNoteStoragePath(noteId, storageConfig = resolveCloudStorageConfig()) {
  const folder = buildCloudNoteVersionsFolder(noteId, storageConfig);
  if (!folder) return '';
  return `${folder}/${makeStorageVersionTag()}.md`;
}

function buildVersionedUserNoteStoragePath(userId, noteId, storageConfig = resolveCloudStorageConfig()) {
  const folder = buildUserNoteVersionsFolder(userId, noteId, storageConfig);
  if (!folder) return '';
  return `${folder}/${makeStorageVersionTag()}.md`;
}

function normalizeIsoOrEmpty(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return '';
  return new Date(parsed).toISOString();
}

function isUuidLike(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || '').trim());
}

function normalizeUserManifestEntry(noteId, userId, entry, storageConfig = resolveCloudStorageConfig()) {
  const safeNoteId = String(noteId || '').trim();
  if (!safeNoteId || !isUuidLike(safeNoteId)) return null;
  const source = (entry && typeof entry === 'object') ? entry : {};
  const title = String(source.title || source.name || 'Untitled').trim() || 'Untitled';
  const storagePathRaw = String(source.storagePath || source.path || '').trim();
  const storagePath = storagePathRaw || buildUserNoteStoragePath(userId, safeNoteId, storageConfig);
  return {
    title,
    storagePath,
    updatedAt: normalizeIsoOrEmpty(source.updatedAt || source.updated_at),
    contentSize: normalizeContentSize(source.contentSize ?? source.content_size ?? source.sizeBytes ?? source.size_bytes ?? source.size),
    shared: Boolean(source.shared)
  };
}

function normalizeUserNoteManifest(raw, userId, storageConfig = resolveCloudStorageConfig()) {
  const source = (raw && typeof raw === 'object') ? raw : {};
  const sourceNotes = (source.notes && typeof source.notes === 'object' && !Array.isArray(source.notes))
    ? source.notes
    : {};
  const notes = {};
  Object.entries(sourceNotes).forEach(([noteId, value]) => {
    const normalized = normalizeUserManifestEntry(noteId, userId, value, storageConfig);
    if (normalized) notes[noteId] = normalized;
  });
  return { version: 1, notes };
}

function getManifestCacheKey(userId, storageConfig = resolveCloudStorageConfig()) {
  const safeUserId = String(userId || '').trim();
  const bucket = String(storageConfig.bucket || '').trim();
  const prefix = normalizeStoragePrefix(storageConfig.objectPrefix);
  return `${bucket}::${prefix}::${safeUserId}`;
}

function getCachedUserManifest(userId, storageConfig = resolveCloudStorageConfig()) {
  const key = getManifestCacheKey(userId, storageConfig);
  if (!key) return null;
  const entry = cloudManifestCache.get(key);
  if (!entry || !entry.manifest || !Number.isFinite(entry.fetchedAt)) return null;
  if (Date.now() - entry.fetchedAt > CLOUD_MANIFEST_CACHE_MS) return null;
  return entry.manifest;
}

function setCachedUserManifest(userId, manifest, storageConfig = resolveCloudStorageConfig()) {
  const key = getManifestCacheKey(userId, storageConfig);
  if (!key) return;
  cloudManifestCache.set(key, { fetchedAt: Date.now(), manifest });
}

function invalidateCachedUserManifest(userId, storageConfig = resolveCloudStorageConfig()) {
  const key = getManifestCacheKey(userId, storageConfig);
  if (!key) return;
  cloudManifestCache.delete(key);
}

async function ensurePersonalRootNoteRow(client, session, storageConfig = resolveCloudStorageConfig()) {
  const userId = session && session.user && session.user.id ? String(session.user.id).trim() : '';
  const ownerEmail = session && session.user && session.user.email ? String(session.user.email).toLowerCase() : '';
  if (!userId) return { success: false, error: 'Missing user id.' };
  const rootNoteId = userId;

  const { data: existing, error: fetchError } = await client
    .from('notes')
    .select('id, owner_id')
    .eq('id', rootNoteId)
    .maybeSingle();
  if (fetchError) return { success: false, error: readableErrorMessage(fetchError.message, 'Failed to prepare cloud storage root.') };
  if (existing && existing.id) {
    if (existing.owner_id && existing.owner_id !== userId) {
      return { success: false, error: 'Cloud root note id conflict for this user.' };
    }
    return { success: true, rootNoteId };
  }

  const manifestPath = buildUserManifestStoragePath(userId, storageConfig);
  const { error: insertError } = await client
    .from('notes')
    .insert({
      id: rootNoteId,
      owner_id: userId,
      owner_email: ownerEmail,
      title: '__noto_personal_root__',
      content: '',
      storage_bucket: storageConfig.bucket,
      storage_path: manifestPath,
      content_size: 0
    });
  if (insertError && !isDuplicateConstraintError(insertError)) {
    return { success: false, error: readableErrorMessage(insertError.message, 'Failed to prepare cloud storage root.') };
  }

  if (ownerEmail) {
    await client
      .from('note_collaborators')
      .upsert({
        note_id: rootNoteId,
        user_id: userId,
        collaborator_email: ownerEmail,
        role: 'owner'
      }, { onConflict: 'note_id,user_id' });
  }

  return { success: true, rootNoteId };
}

async function readUserNoteManifest(client, userId, storageConfig = resolveCloudStorageConfig(), options = {}) {
  const safeUserId = String(userId || '').trim();
  if (!safeUserId) return { success: false, error: 'Missing user id.' };
  if (!options.force) {
    const cached = getCachedUserManifest(safeUserId, storageConfig);
    if (cached) return { success: true, manifest: cached };
  }

  const manifestPath = buildUserManifestStoragePath(safeUserId, storageConfig);
  if (!manifestPath) return { success: false, error: 'Invalid manifest path.' };
  const bucket = String(storageConfig.bucket || '').trim();

  const { data, error } = await client
    .storage
    .from(bucket)
    .download(manifestPath);
  if (error) {
    if (isStorageNotFoundError(error)) {
      const empty = { version: 1, notes: {} };
      setCachedUserManifest(safeUserId, empty, storageConfig);
      return { success: true, manifest: empty, missing: true };
    }
    return {
      success: false,
      error: readableErrorMessage(error.message, 'Cloud manifest is unavailable.'),
      permissionDenied: isStoragePermissionError(error)
    };
  }

  try {
    let rawText = '';
    if (Buffer.isBuffer(data)) rawText = data.toString('utf8');
    else if (data && typeof data.text === 'function') rawText = await data.text();
    else if (data && typeof data.arrayBuffer === 'function') rawText = Buffer.from(await data.arrayBuffer()).toString('utf8');
    else rawText = String(data || '');

    const parsed = rawText ? JSON.parse(rawText) : {};
    const manifest = normalizeUserNoteManifest(parsed, safeUserId, storageConfig);
    setCachedUserManifest(safeUserId, manifest, storageConfig);
    return { success: true, manifest };
  } catch (e) {
    return { success: false, error: readableErrorMessage(e && e.message, 'Failed to parse cloud note manifest.') };
  }
}

async function writeUserNoteManifest(client, userId, manifest, storageConfig = resolveCloudStorageConfig()) {
  const safeUserId = String(userId || '').trim();
  if (!safeUserId) return { success: false, error: 'Missing user id.' };
  const normalized = normalizeUserNoteManifest(manifest, safeUserId, storageConfig);
  const manifestPath = buildUserManifestStoragePath(safeUserId, storageConfig);
  if (!manifestPath) return { success: false, error: 'Invalid manifest path.' };
  const payload = Buffer.from(JSON.stringify(normalized, null, 2), 'utf8');
  const { error } = await client
    .storage
    .from(storageConfig.bucket)
    .upload(manifestPath, payload, {
      upsert: true,
      contentType: 'application/json; charset=utf-8',
      cacheControl: '0'
    });
  if (error) {
    return {
      success: false,
      error: readableErrorMessage(error.message, 'Failed to save cloud note manifest.'),
      permissionDenied: isStoragePermissionError(error)
    };
  }
  setCachedUserManifest(safeUserId, normalized, storageConfig);
  return { success: true, manifest: normalized };
}

function getManifestNoteEntry(manifest, noteId) {
  const safeNoteId = String(noteId || '').trim();
  if (!safeNoteId || !manifest || typeof manifest !== 'object') return null;
  const notes = (manifest.notes && typeof manifest.notes === 'object') ? manifest.notes : {};
  return notes[safeNoteId] && typeof notes[safeNoteId] === 'object' ? notes[safeNoteId] : null;
}

function getUtf8ByteSize(value) {
  return Buffer.byteLength(String(value || ''), 'utf8');
}

function normalizeContentSize(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function readableErrorMessage(rawMessage, fallback) {
  const normalized = String(rawMessage == null ? '' : rawMessage).trim();
  if (!normalized || normalized === '{}' || normalized === '[object Object]') return fallback;
  return normalized;
}

function isStorageNotFoundError(error) {
  const codeRaw = error && (error.statusCode ?? error.status ?? error.code);
  const code = String(codeRaw || '').toLowerCase();
  const message = String(error && error.message ? error.message : '').toLowerCase();
  if (code === '404') return true;
  if (message.includes('not found')) return true;
  if (message.includes('no such file')) return true;
  if (message.includes('does not exist')) return true;
  return false;
}

function isStoragePermissionError(error) {
  const codeRaw = error && (error.statusCode ?? error.status ?? error.code);
  const code = String(codeRaw || '').toLowerCase();
  const message = String(error && error.message ? error.message : '').toLowerCase();
  if (code === '401' || code === '403') return true;
  if (code === '42501') return true;
  if (message.includes('permission')) return true;
  if (message.includes('forbidden')) return true;
  if (message.includes('not authorized')) return true;
  if (message.includes('unauthorized')) return true;
  if (message.includes('policy')) return true;
  if (message.includes('row-level security')) return true;
  if (message.includes('rls')) return true;
  return false;
}

function isDuplicateConstraintError(error) {
  const code = String(error && error.code ? error.code : '').toLowerCase();
  const message = String(error && error.message ? error.message : '').toLowerCase();
  if (code === '23505') return true;
  if (message.includes('duplicate key')) return true;
  if (message.includes('already exists')) return true;
  return false;
}

function normalizeStorageObjectPath(value) {
  return String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

function splitStorageObjectPath(storagePath) {
  const safePath = normalizeStorageObjectPath(storagePath);
  if (!safePath) return { folder: '', name: '' };
  const slash = safePath.lastIndexOf('/');
  if (slash === -1) return { folder: '', name: safePath };
  return {
    folder: safePath.slice(0, slash),
    name: safePath.slice(slash + 1)
  };
}

async function listStorageFolderObjects(client, bucket, folderPath) {
  const safeBucket = String(bucket || '').trim();
  const safeFolder = normalizeStorageObjectPath(folderPath);
  if (!safeBucket || !safeFolder) return { success: true, objects: [] };
  const pageSize = 1000;
  let offset = 0;
  const all = [];
  while (true) {
    const { data, error } = await client
      .storage
      .from(safeBucket)
      .list(safeFolder, { limit: pageSize, offset, sortBy: { column: 'name', order: 'asc' } });
    if (error) {
      return {
        success: false,
        error: readableErrorMessage(error.message, 'Failed to list cloud storage files.')
      };
    }
    const page = Array.isArray(data) ? data : [];
    if (!page.length) break;
    all.push(...page);
    if (page.length < pageSize) break;
    offset += page.length;
  }
  return { success: true, objects: all };
}

function parseVersionTimestampFromPath(storagePath) {
  const safePath = normalizeStorageObjectPath(storagePath);
  if (!safePath) return 0;
  const { name } = splitStorageObjectPath(safePath);
  const base = name.replace(/\.[^./]+$/, '');
  const tag = String(base.split('-')[0] || '').trim();
  if (!tag) return 0;
  if (/^\d{11,}$/.test(tag)) {
    const parsed = Number(tag);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  const parsedBase36 = parseInt(tag, 36);
  return Number.isFinite(parsedBase36) ? parsedBase36 : 0;
}

function storageObjectTimestamp(object, storagePath) {
  const createdAt = Date.parse(String(object && object.created_at ? object.created_at : ''));
  if (Number.isFinite(createdAt) && createdAt > 0) return createdAt;
  const updatedAt = Date.parse(String(object && object.updated_at ? object.updated_at : ''));
  if (Number.isFinite(updatedAt) && updatedAt > 0) return updatedAt;
  const metadataUpdated = Date.parse(String(object && object.metadata && object.metadata.lastModified ? object.metadata.lastModified : ''));
  if (Number.isFinite(metadataUpdated) && metadataUpdated > 0) return metadataUpdated;
  return parseVersionTimestampFromPath(storagePath);
}

async function trimVersionFolderRetention(client, bucket, folderPath, maxVersions = 50, keepPaths = []) {
  const safeBucket = String(bucket || '').trim();
  const safeFolder = normalizeStorageObjectPath(folderPath);
  if (!safeBucket || !safeFolder) return { success: true };
  const listResult = await listStorageFolderObjects(client, safeBucket, safeFolder);
  if (!listResult.success) return listResult;
  const keepLimit = Math.max(1, toSafePositiveInt(maxVersions, 50));
  const protectSet = new Set((Array.isArray(keepPaths) ? keepPaths : []).map((item) => normalizeStorageObjectPath(item)).filter(Boolean));
  const entries = (listResult.objects || [])
    .map((item) => {
      const name = String(item && item.name ? item.name : '').trim();
      if (!name || name.endsWith('/')) return null;
      const fullPath = `${safeFolder}/${name}`;
      return {
        fullPath,
        ts: storageObjectTimestamp(item, fullPath)
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (b.ts !== a.ts) return b.ts - a.ts;
      return String(a.fullPath).localeCompare(String(b.fullPath));
    });
  if (entries.length <= keepLimit) return { success: true };
  let keepBudget = keepLimit;
  const toRemove = [];
  for (const entry of entries) {
    if (protectSet.has(entry.fullPath)) {
      keepBudget = Math.max(0, keepBudget - 1);
      continue;
    }
    if (keepBudget > 0) {
      keepBudget -= 1;
      continue;
    }
    toRemove.push(entry.fullPath);
  }
  if (!toRemove.length) return { success: true };
  const { error } = await client
    .storage
    .from(safeBucket)
    .remove(toRemove);
  if (error) {
    return {
      success: false,
      error: readableErrorMessage(error.message, 'Failed to trim version history files.')
    };
  }
  return { success: true };
}

async function removeStorageFolderContents(client, bucket, folderPath) {
  const safeBucket = String(bucket || '').trim();
  const safeFolder = normalizeStorageObjectPath(folderPath);
  if (!safeBucket || !safeFolder) return { success: true };
  const listResult = await listStorageFolderObjects(client, safeBucket, safeFolder);
  if (!listResult.success) return listResult;
  const paths = (listResult.objects || [])
    .map((item) => {
      const name = String(item && item.name ? item.name : '').trim();
      if (!name || name.endsWith('/')) return '';
      return `${safeFolder}/${name}`;
    })
    .filter(Boolean);
  if (!paths.length) return { success: true };
  const { error } = await client
    .storage
    .from(safeBucket)
    .remove(paths);
  if (error) {
    return {
      success: false,
      error: readableErrorMessage(error.message, 'Failed to delete cloud version files.')
    };
  }
  return { success: true };
}

async function getUserOwnedCloudStorageUsageBytes(client, userId, options = {}) {
  const safeUserId = String(userId || '').trim();
  if (!safeUserId) return { success: false, error: 'Missing user id.' };
  const storageConfig = resolveCloudStorageConfig();
  const allowPartial = Boolean(options.allowPartial);
  const bucket = String(storageConfig.bucket || '').trim();
  const prefix = normalizeStoragePrefix(storageConfig.objectPrefix);
  const userNotesFolder = `${prefix}/users/${safeUserId}/notes`;
  const userNotesPrefix = `${userNotesFolder}/`;

  function normalizeStorageObjectPath(value) {
    return String(value || '')
      .trim()
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')
      .replace(/\/+$/, '');
  }

  async function listStorageFolderObjects(folderPath) {
    const safeFolder = normalizeStorageObjectPath(folderPath);
    const pageSize = 1000;
    let offset = 0;
    const all = [];

    while (true) {
      const { data, error } = await client
        .storage
        .from(bucket)
        .list(safeFolder, { limit: pageSize, offset, sortBy: { column: 'name', order: 'asc' } });
      if (error) {
        return {
          success: false,
          error: readableErrorMessage(error.message, 'Failed to list cloud storage files.')
        };
      }
      const page = Array.isArray(data) ? data : [];
      if (!page.length) break;
      all.push(...page);
      if (page.length < pageSize) break;
      offset += page.length;
    }

    return { success: true, objects: all };
  }

  function extractListedObjectSize(object) {
    const metadata = (object && object.metadata && typeof object.metadata === 'object') ? object.metadata : {};
    const sizeCandidate = metadata.size ?? metadata.contentLength ?? object.size ?? 0;
    return normalizeContentSize(sizeCandidate);
  }

  function splitStoragePath(storagePath) {
    const safePath = normalizeStorageObjectPath(storagePath);
    if (!safePath) return { folder: '', name: '' };
    const slash = safePath.lastIndexOf('/');
    if (slash === -1) return { folder: '', name: safePath };
    return {
      folder: safePath.slice(0, slash),
      name: safePath.slice(slash + 1)
    };
  }

  async function getStorageObjectSizeByPath(storagePath, folderCache) {
    const safePath = normalizeStorageObjectPath(storagePath);
    if (!safePath) return { success: false, error: 'Missing storage path.', missing: true };
    const { folder, name } = splitStoragePath(safePath);
    if (!name) return { success: false, error: 'Invalid storage path.', missing: true };
    const cacheKey = folder;
    if (!folderCache.has(cacheKey)) {
      folderCache.set(cacheKey, await listStorageFolderObjects(folder));
    }
    const folderResult = folderCache.get(cacheKey);
    if (!folderResult || !folderResult.success) {
      return {
        success: false,
        error: (folderResult && folderResult.error) || 'Failed to inspect cloud storage usage.'
      };
    }
    const objects = Array.isArray(folderResult.objects) ? folderResult.objects : [];
    const found = objects.find((item) => String(item && item.name ? item.name : '') === name);
    if (!found) return { success: false, error: 'Cloud file is missing.', missing: true };
    return { success: true, sizeBytes: extractListedObjectSize(found) };
  }

  let personalUsageBytes = 0;
  const personalListResult = await listStorageFolderObjects(userNotesFolder);
  if (!personalListResult.success) {
    if (!allowPartial) {
      return {
        success: false,
        error: personalListResult.error || 'Failed to calculate personal cloud storage usage.'
      };
    }
  } else {
    const objects = Array.isArray(personalListResult.objects) ? personalListResult.objects : [];
    personalUsageBytes = objects.reduce((sum, object) => sum + extractListedObjectSize(object), 0);
  }

  const { data, error } = await client
    .from('notes')
    .select('id, storage_path, content_size')
    .eq('owner_id', safeUserId);
  if (error) return { success: false, error: readableErrorMessage(error.message, 'Failed to calculate storage usage.') };

  const rows = Array.isArray(data) ? data : [];
  let rowUsageBytes = 0;
  const folderCache = new Map();
  for (const row of rows) {
    const rowId = row && row.id ? String(row.id).trim() : '';
    const rowPath = normalizeStorageObjectPath(row && row.storage_path);
    const isRootRow = rowId === safeUserId;
    const isPersonalRow = rowPath && (rowPath === userNotesFolder || rowPath.startsWith(userNotesPrefix));
    if (isRootRow || isPersonalRow) continue;

    let rowSize = normalizeContentSize(row && row.content_size);
    if (rowSize <= 0 && rowPath) {
      const pathSize = await getStorageObjectSizeByPath(rowPath, folderCache);
      if (pathSize.success) {
        rowSize = pathSize.sizeBytes;
      } else if (!allowPartial && !pathSize.missing) {
        return {
          success: false,
          error: pathSize.error || 'Failed to calculate collaborative storage usage.'
        };
      }
    }
    rowUsageBytes += rowSize;
  }

  return { success: true, usageBytes: personalUsageBytes + rowUsageBytes, manifest: { version: 1, notes: {} } };
}

async function evaluateOwnerStorageQuota(client, ownerId, nextContentBytes, previousContentBytes = 0, options = {}) {
  const config = resolveCloudStorageConfig();
  const usageResult = await getUserOwnedCloudStorageUsageBytes(client, ownerId, {
    ...options,
    force: true,
    allowPartial: true
  });
  if (!usageResult.success) {
    return {
      ok: false,
      code: 'storage_usage_failed',
      error: usageResult.error || 'Failed to calculate storage usage.'
    };
  }
  const previous = normalizeContentSize(previousContentBytes);
  const next = Math.max(0, Number(nextContentBytes) || 0);
  const projectedUsageBytes = Math.max(0, usageResult.usageBytes - previous + next);
  if (projectedUsageBytes > config.globalUserQuotaBytes) {
    return {
      ok: false,
      code: 'storage_quota_exceeded',
      error: `Cloud storage limit reached (${config.globalUserQuotaKb} KB per user).`,
      usageBytes: usageResult.usageBytes,
      projectedUsageBytes,
      quotaBytes: config.globalUserQuotaBytes,
      quotaKb: config.globalUserQuotaKb
    };
  }
  return {
    ok: true,
    usageBytes: usageResult.usageBytes,
    projectedUsageBytes,
    quotaBytes: config.globalUserQuotaBytes,
    quotaKb: config.globalUserQuotaKb
  };
}

async function uploadNoteContentToStorage(client, bucket, storagePath, content) {
  const safeBucket = String(bucket || '').trim();
  const safePath = String(storagePath || '').trim();
  if (!safeBucket || !safePath) return { success: false, error: 'Missing storage destination.' };
  const body = Buffer.from(String(content || ''), 'utf8');
  const { error } = await client
    .storage
    .from(safeBucket)
    .upload(safePath, body, {
      upsert: true,
      contentType: 'text/markdown; charset=utf-8',
      cacheControl: '0'
    });
  if (error) {
    return {
      success: false,
      error: readableErrorMessage(error.message, 'Failed to upload cloud note file.'),
      permissionDenied: isStoragePermissionError(error)
    };
  }
  return { success: true, sizeBytes: body.length };
}

async function downloadNoteContentFromStorage(client, bucket, storagePath) {
  const safeBucket = String(bucket || '').trim();
  const safePath = String(storagePath || '').trim();
  if (!safeBucket || !safePath) return { success: false, error: 'Missing storage source.' };
  const { data, error } = await client
    .storage
    .from(safeBucket)
    .download(safePath);
  if (error) {
    return {
      success: false,
      error: readableErrorMessage(error.message, 'Failed to download cloud note file.'),
      missing: isStorageNotFoundError(error),
      permissionDenied: isStoragePermissionError(error)
    };
  }
  if (!data) return { success: false, error: 'Cloud note file is unavailable.', missing: true };
  try {
    if (Buffer.isBuffer(data)) return { success: true, content: data.toString('utf8') };
    if (typeof data.text === 'function') {
      const text = await data.text();
      return { success: true, content: String(text || '') };
    }
    if (typeof data.arrayBuffer === 'function') {
      const raw = await data.arrayBuffer();
      return { success: true, content: Buffer.from(raw).toString('utf8') };
    }
    if (typeof data === 'string') return { success: true, content: data };
    return { success: false, error: 'Unexpected cloud file format.' };
  } catch (e) {
    return { success: false, error: readableErrorMessage(e && e.message, 'Failed to decode cloud note file.') };
  }
}

async function removeNoteContentFromStorage(client, bucket, storagePath) {
  const safeBucket = String(bucket || '').trim();
  const safePath = String(storagePath || '').trim();
  if (!safeBucket || !safePath) return { success: true };
  const { error } = await client
    .storage
    .from(safeBucket)
    .remove([safePath]);
  if (error && !isStorageNotFoundError(error)) {
    return {
      success: false,
      error: readableErrorMessage(error.message, 'Failed to delete cloud note file.'),
      permissionDenied: isStoragePermissionError(error)
    };
  }
  return { success: true };
}

async function getAccessibleSharedNoteRow(client, noteId) {
  const safeNoteId = String(noteId || '').trim();
  if (!safeNoteId) return { success: true, note: null };
  const { data, error } = await client
    .from('notes')
    .select('id, owner_id, owner_email, title, updated_at, storage_bucket, storage_path, content_size')
    .eq('id', safeNoteId)
    .maybeSingle();
  if (error) return { success: false, error: readableErrorMessage(error.message, 'Failed to access note.') };
  return { success: true, note: data || null };
}

async function loadPersonalManifestContext(client, userId, storageConfig = resolveCloudStorageConfig(), options = {}) {
  if (options.ensureRoot && options.session) {
    const rootResult = await ensurePersonalRootNoteRow(client, options.session, storageConfig);
    if (!rootResult.success) {
      return {
        success: false,
        error: rootResult.error || 'Failed to prepare cloud storage root.',
        missing: false
      };
    }
  }

  const manifestResult = await readUserNoteManifest(client, userId, storageConfig, options);
  if (!manifestResult.success) {
    if (options.allowPermissionFallback) {
      const emptyManifest = { version: 1, notes: {} };
      return {
        success: true,
        manifest: emptyManifest,
        missing: false,
        permissionDenied: Boolean(manifestResult.permissionDenied),
        permissionFallback: true
      };
    }
    return {
      success: false,
      error: manifestResult.error || 'Cloud note access is unavailable.',
      missing: Boolean(manifestResult.missing),
      permissionDenied: Boolean(manifestResult.permissionDenied)
    };
  }
  const manifest = manifestResult.manifest || { version: 1, notes: {} };
  if (!manifest.notes || typeof manifest.notes !== 'object') manifest.notes = {};
  return {
    success: true,
    manifest,
    missing: Boolean(manifestResult.missing),
    permissionDenied: Boolean(manifestResult.permissionDenied)
  };
}

async function upsertPersonalNoteInManifest(client, session, options = {}) {
  const storageConfig = options.storageConfig || resolveCloudStorageConfig();
  const ownerId = session && session.user && session.user.id ? String(session.user.id) : '';
  if (!ownerId) return { success: false, error: 'Missing user id.' };
  const noteId = String(options.noteId || '').trim() || randomUUID();
  if (!isUuidLike(noteId)) return { success: false, error: 'Invalid note id.' };
  const title = String(options.title || 'Untitled');
  const content = String(options.content || '');
  const contentSize = getUtf8ByteSize(content);
  const preserveHistory = Boolean(options.versionHistoryEnabled);
  const historyMaxVersions = Math.max(1, toSafePositiveInt(options.historyMaxVersions, 50));

  const manifestCtx = await loadPersonalManifestContext(client, ownerId, storageConfig, {
    allowPermissionFallback: true
  });
  if (!manifestCtx.success) return manifestCtx;
  const { manifest } = manifestCtx;
  const prevEntry = getManifestNoteEntry(manifest, noteId);
  const previousContentSize = normalizeContentSize(prevEntry && prevEntry.contentSize);
  const quotaGate = await evaluateOwnerStorageQuota(client, ownerId, contentSize, previousContentSize, { session });
  if (!quotaGate.ok) {
    return {
      success: false,
      error: quotaGate.error || 'Storage quota exceeded.',
      code: quotaGate.code || 'storage_quota_exceeded',
      usageBytes: quotaGate.usageBytes,
      projectedUsageBytes: quotaGate.projectedUsageBytes,
      quotaBytes: quotaGate.quotaBytes,
      quotaKb: quotaGate.quotaKb
    };
  }

  const previousStoragePath = prevEntry && prevEntry.storagePath ? String(prevEntry.storagePath).trim() : '';
  const storagePath = buildVersionedUserNoteStoragePath(ownerId, noteId, storageConfig)
    || buildUserNoteStoragePath(ownerId, noteId, storageConfig);
  const uploadResult = await uploadNoteContentToStorage(client, storageConfig.bucket, storagePath, content);
  if (!uploadResult.success) {
    return { success: false, error: uploadResult.error || 'Failed to upload note file.' };
  }

  manifest.notes[noteId] = normalizeUserManifestEntry(noteId, ownerId, {
    title,
    storagePath,
    updatedAt: new Date().toISOString(),
    contentSize: uploadResult.sizeBytes,
    shared: Boolean(prevEntry && prevEntry.shared)
  }, storageConfig);

  const saveResult = await writeUserNoteManifest(client, ownerId, manifest, storageConfig);
  if (!saveResult.success) {
    const saveError = String(saveResult.error || '').toLowerCase();
    const manifestBlocked = Boolean(saveResult.permissionDenied || saveError.includes('manifest'));
    if (!manifestBlocked) {
      await removeNoteContentFromStorage(client, storageConfig.bucket, storagePath);
      const baseError = saveResult.error || 'Failed to update cloud note manifest.';
      const hint = saveResult.permissionDenied
        ? ' Apply the latest supabase/cloud-notes.sql storage policies in Supabase.'
        : '';
      return { success: false, error: `${baseError}${hint}`.trim() };
    }

    // Keep the uploaded note file usable even if manifest writes are blocked.
    setCachedUserManifest(ownerId, manifest, storageConfig);
    if (preserveHistory) {
      const historyFolder = buildUserNoteVersionsFolder(ownerId, noteId, storageConfig);
      await trimVersionFolderRetention(client, storageConfig.bucket, historyFolder, historyMaxVersions, [storagePath]);
    }
    return {
      success: true,
      noteId,
      updatedAt: new Date().toISOString(),
      usageBytes: quotaGate.projectedUsageBytes,
      quotaBytes: quotaGate.quotaBytes,
      personal: true
    };
  }
  const updatedEntry = getManifestNoteEntry(saveResult.manifest, noteId);
  if (preserveHistory) {
    const historyFolder = buildUserNoteVersionsFolder(ownerId, noteId, storageConfig);
    await trimVersionFolderRetention(client, storageConfig.bucket, historyFolder, historyMaxVersions, [storagePath]);
  } else if (previousStoragePath && previousStoragePath !== storagePath) {
    await removeNoteContentFromStorage(client, storageConfig.bucket, previousStoragePath);
  }

  return {
    success: true,
    noteId,
    updatedAt: updatedEntry && updatedEntry.updatedAt ? updatedEntry.updatedAt : new Date().toISOString(),
    usageBytes: quotaGate.projectedUsageBytes,
    quotaBytes: quotaGate.quotaBytes,
    personal: true
  };
}

async function getPersonalNoteFromManifest(client, session, noteId, storageConfig = resolveCloudStorageConfig(), options = {}) {
  const ownerId = session && session.user && session.user.id ? String(session.user.id) : '';
  const safeNoteId = String(noteId || '').trim();
  if (!ownerId || !safeNoteId) return { success: false, error: 'Missing note id.', missing: true };
  const manifestCtx = await loadPersonalManifestContext(client, ownerId, storageConfig);
  if (!manifestCtx.success) {
    const fallbackStoragePath = buildUserNoteStoragePath(ownerId, safeNoteId, storageConfig);
    const fallbackDownload = await downloadNoteContentFromStorage(client, storageConfig.bucket, fallbackStoragePath);
    if (fallbackDownload.success) {
      const fallbackEntry = normalizeUserManifestEntry(safeNoteId, ownerId, {
        title: 'Untitled',
        storagePath: fallbackStoragePath,
        updatedAt: '',
        contentSize: getUtf8ByteSize(fallbackDownload.content || ''),
        shared: false
      }, storageConfig);
      const payload = {
        success: true,
        note: {
          id: safeNoteId,
          title: 'Untitled',
          content: fallbackDownload.content,
          updated_at: '',
          owner_id: ownerId
        }
      };
      if (options.includeContext && fallbackEntry) {
        payload.entry = fallbackEntry;
        payload.manifest = { version: 1, notes: { [safeNoteId]: fallbackEntry } };
      }
      return payload;
    }
    return {
      success: false,
      error: manifestCtx.error || 'Failed to load cloud note manifest.',
      missing: Boolean(manifestCtx.missing)
    };
  }
  const entry = getManifestNoteEntry(manifestCtx.manifest, safeNoteId);
  if (!entry) {
    const fallbackStoragePath = buildUserNoteStoragePath(ownerId, safeNoteId, storageConfig);
    const fallbackDownload = await downloadNoteContentFromStorage(client, storageConfig.bucket, fallbackStoragePath);
    if (fallbackDownload.success) {
      const fallbackEntry = normalizeUserManifestEntry(safeNoteId, ownerId, {
        title: 'Untitled',
        storagePath: fallbackStoragePath,
        updatedAt: '',
        contentSize: getUtf8ByteSize(fallbackDownload.content || ''),
        shared: false
      }, storageConfig);
      const payload = {
        success: true,
        note: {
          id: safeNoteId,
          title: 'Untitled',
          content: fallbackDownload.content,
          updated_at: '',
          owner_id: ownerId
        }
      };
      if (options.includeContext && fallbackEntry) {
        payload.entry = fallbackEntry;
        payload.manifest = { version: 1, notes: { [safeNoteId]: fallbackEntry } };
      }
      return payload;
    }
    return { success: false, error: 'Note not found or access denied.', missing: true };
  }

  const storagePath = String(entry.storagePath || '').trim() || buildUserNoteStoragePath(ownerId, safeNoteId, storageConfig);
  const downloadResult = await downloadNoteContentFromStorage(client, storageConfig.bucket, storagePath);
  if (!downloadResult.success) {
    return {
      success: false,
      error: downloadResult.error || 'Failed to load cloud note file.',
      missing: Boolean(downloadResult.missing)
    };
  }

  const payload = {
    success: true,
    note: {
      id: safeNoteId,
      title: entry.title || 'Untitled',
      content: downloadResult.content,
      updated_at: entry.updatedAt || '',
      owner_id: ownerId
    }
  };
  if (options.includeContext) {
    payload.entry = entry;
    payload.manifest = manifestCtx.manifest;
  }
  return payload;
}

async function deletePersonalNoteFromManifest(client, session, noteId, storageConfig = resolveCloudStorageConfig()) {
  const ownerId = session && session.user && session.user.id ? String(session.user.id) : '';
  const safeNoteId = String(noteId || '').trim();
  if (!ownerId || !safeNoteId) return { success: false, error: 'Missing note id.', missing: true };
  const manifestCtx = await loadPersonalManifestContext(client, ownerId, storageConfig);
  if (!manifestCtx.success) {
    if (!manifestCtx.missing) {
      const fallbackStoragePath = buildUserNoteStoragePath(ownerId, safeNoteId, storageConfig);
      const fallbackRemove = await removeNoteContentFromStorage(client, storageConfig.bucket, fallbackStoragePath);
      if (!fallbackRemove.success) {
        return { success: false, error: fallbackRemove.error || 'Failed to delete note file.' };
      }
      const fallbackVersionsFolder = buildUserNoteVersionsFolder(ownerId, safeNoteId, storageConfig);
      await removeStorageFolderContents(client, storageConfig.bucket, fallbackVersionsFolder);
      return { success: true };
    }
    return {
      success: false,
      error: manifestCtx.error || 'Failed to load cloud note manifest.',
      missing: Boolean(manifestCtx.missing)
    };
  }
  const entry = getManifestNoteEntry(manifestCtx.manifest, safeNoteId);
  if (!entry) return { success: false, error: 'Note not found or access denied.', missing: true };

  const storagePath = String(entry.storagePath || '').trim() || buildUserNoteStoragePath(ownerId, safeNoteId, storageConfig);
  const removeResult = await removeNoteContentFromStorage(client, storageConfig.bucket, storagePath);
  if (!removeResult.success) return { success: false, error: removeResult.error || 'Failed to delete note file.' };
  const versionsFolder = buildUserNoteVersionsFolder(ownerId, safeNoteId, storageConfig);
  await removeStorageFolderContents(client, storageConfig.bucket, versionsFolder);

  delete manifestCtx.manifest.notes[safeNoteId];
  const saveResult = await writeUserNoteManifest(client, ownerId, manifestCtx.manifest, storageConfig);
  if (!saveResult.success) return { success: false, error: saveResult.error || 'Failed to update cloud note manifest.' };
  return { success: true };
}

async function ensureSharedNoteRowForInvites(client, session, noteId, storageConfig = resolveCloudStorageConfig()) {
  const ownerId = session && session.user && session.user.id ? String(session.user.id) : '';
  const ownerEmail = session && session.user && session.user.email ? String(session.user.email).toLowerCase() : '';
  const safeNoteId = String(noteId || '').trim();
  if (!ownerId || !safeNoteId) return { success: false, error: 'Missing note id.' };

  const sharedRowResult = await getAccessibleSharedNoteRow(client, safeNoteId);
  if (!sharedRowResult.success) return { success: false, error: sharedRowResult.error || 'Failed to access note.' };
  if (sharedRowResult.note && sharedRowResult.note.id) {
    if (sharedRowResult.note.owner_id && sharedRowResult.note.owner_id === ownerId) {
      await client
        .from('note_collaborators')
        .upsert({
          note_id: safeNoteId,
          user_id: ownerId,
          collaborator_email: ownerEmail,
          role: 'owner'
        }, { onConflict: 'note_id,user_id' });
    }
    return { success: true, note: sharedRowResult.note };
  }

  const personalResult = await getPersonalNoteFromManifest(client, session, safeNoteId, storageConfig, { includeContext: true });
  if (!personalResult.success) {
    return {
      success: false,
      error: personalResult.error || 'Note not found.',
      missing: Boolean(personalResult.missing)
    };
  }
  const personalEntry = personalResult.entry || {};
  const personalPath = String(personalEntry.storagePath || '').trim() || buildUserNoteStoragePath(ownerId, safeNoteId, storageConfig);
  const sharedPath = buildVersionedCloudNoteStoragePath(safeNoteId, storageConfig)
    || buildCloudNoteStoragePath(safeNoteId, storageConfig);
  const content = personalResult.note && typeof personalResult.note.content === 'string' ? personalResult.note.content : '';

  const { data: inserted, error: insertError } = await client
    .from('notes')
    .insert({
      id: safeNoteId,
      owner_id: ownerId,
      owner_email: ownerEmail,
      title: personalEntry.title || personalResult.note.title || 'Untitled',
      content: '',
      storage_bucket: storageConfig.bucket,
      storage_path: sharedPath,
      content_size: 0
    })
    .select('id, title, updated_at, owner_id, owner_email, storage_bucket, storage_path, content_size')
    .maybeSingle();
  if (insertError) return { success: false, error: readableErrorMessage(insertError.message, 'Failed to enable sharing for note.') };

  const uploadShared = await uploadNoteContentToStorage(client, storageConfig.bucket, sharedPath, content);
  if (!uploadShared.success) {
    await client.from('notes').delete().eq('id', safeNoteId);
    return { success: false, error: uploadShared.error || 'Failed to prepare shared note file.' };
  }

  const { data: finalized, error: finalizeError } = await client
    .from('notes')
    .update({
      title: personalEntry.title || personalResult.note.title || 'Untitled',
      storage_bucket: storageConfig.bucket,
      storage_path: sharedPath,
      content_size: uploadShared.sizeBytes
    })
    .eq('id', safeNoteId)
    .select('id, title, updated_at, owner_id, owner_email, storage_bucket, storage_path, content_size')
    .maybeSingle();
  if (finalizeError) {
    await removeNoteContentFromStorage(client, storageConfig.bucket, sharedPath);
    await client.from('notes').delete().eq('id', safeNoteId);
    return { success: false, error: readableErrorMessage(finalizeError.message, 'Failed to finalize shared note.') };
  }

  await client
    .from('note_collaborators')
    .upsert({
      note_id: safeNoteId,
      user_id: ownerId,
      collaborator_email: ownerEmail,
      role: 'owner'
    }, { onConflict: 'note_id,user_id' });

  if (personalResult.manifest && personalResult.manifest.notes && personalResult.manifest.notes[safeNoteId]) {
    personalResult.manifest.notes[safeNoteId] = normalizeUserManifestEntry(safeNoteId, ownerId, {
      ...personalResult.manifest.notes[safeNoteId],
      storagePath: sharedPath,
      shared: true,
      contentSize: uploadShared.sizeBytes,
      updatedAt: finalized && finalized.updated_at ? finalized.updated_at : new Date().toISOString()
    }, storageConfig);
    await writeUserNoteManifest(client, ownerId, personalResult.manifest, storageConfig);
  }

  if (personalPath && personalPath !== sharedPath) {
    await removeNoteContentFromStorage(client, storageConfig.bucket, personalPath);
  }

  return { success: true, note: finalized || inserted || null };
}

async function resolveCloudVersionContext(client, session, noteId, storageConfig = resolveCloudStorageConfig()) {
  const safeNoteId = String(noteId || '').trim();
  if (!safeNoteId) return { success: false, error: 'Missing note id.', missing: true };
  const sharedRowResult = await getAccessibleSharedNoteRow(client, safeNoteId);
  if (!sharedRowResult.success) {
    return { success: false, error: sharedRowResult.error || 'Failed to load note versions.' };
  }
  if (sharedRowResult.note && sharedRowResult.note.id) {
    const bucket = String(sharedRowResult.note.storage_bucket || storageConfig.bucket || '').trim() || storageConfig.bucket;
    return {
      success: true,
      bucket,
      folder: buildCloudNoteVersionsFolder(safeNoteId, storageConfig),
      currentStoragePath: normalizeStorageObjectPath(sharedRowResult.note.storage_path || ''),
      noteId: safeNoteId
    };
  }

  const ownerId = session && session.user && session.user.id ? String(session.user.id) : '';
  if (!ownerId) return { success: false, error: 'Missing user id.' };
  const manifestCtx = await loadPersonalManifestContext(client, ownerId, storageConfig);
  if (!manifestCtx.success) {
    return {
      success: false,
      error: manifestCtx.error || 'Failed to load cloud note manifest.',
      missing: Boolean(manifestCtx.missing)
    };
  }
  const entry = getManifestNoteEntry(manifestCtx.manifest, safeNoteId);
  if (!entry) return { success: false, error: 'Note not found or access denied.', missing: true };
  return {
    success: true,
    bucket: storageConfig.bucket,
    folder: buildUserNoteVersionsFolder(ownerId, safeNoteId, storageConfig),
    currentStoragePath: normalizeStorageObjectPath(entry.storagePath || ''),
    noteId: safeNoteId
  };
}

function resolveSupabaseConfig() {
  const fileConfig = readJsonFileIfExists(PROJECT_SUPABASE_CONFIG_FILE, {});
  const url = String(process.env.SUPABASE_URL || fileConfig.url || '').trim();
  const anonKey = String(process.env.SUPABASE_ANON_KEY || fileConfig.anonKey || '').trim();
  const deleteAccountUrl = String(process.env.SUPABASE_DELETE_ACCOUNT_URL || fileConfig.deleteAccountUrl || '').trim();
  return { url, anonKey, deleteAccountUrl };
}

function isSupabaseConfigured() {
  const config = resolveSupabaseConfig();
  return Boolean(config.url && config.anonKey);
}

function ensureSupabaseClient() {
  if (supabaseClient) return supabaseClient;

  const config = resolveSupabaseConfig();
  if (!config.url || !config.anonKey) {
    supabaseConfigError = 'Supabase is not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY, or add supabase.config.json.';
    return null;
  }

  try {
    supabaseClient = createClient(config.url, config.anonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false
      }
    });
    supabaseConfigError = '';
    return supabaseClient;
  } catch (e) {
    supabaseConfigError = 'Failed to initialize Supabase client.';
    return null;
  }
}

function createAuthedSupabaseClient(accessToken) {
  const config = resolveSupabaseConfig();
  if (!config.url || !config.anonKey) return null;
  const token = typeof accessToken === 'string' ? accessToken.trim() : '';
  if (!token) return null;
  return createClient(config.url, config.anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    },
    global: {
      headers: {
        Authorization: `Bearer ${token}`
      }
    }
  });
}

async function getFreshSession() {
  const stored = readAuthSession();
  if (!stored || !stored.access_token || !stored.refresh_token || !stored.user || !stored.user.id) {
    return { session: null, error: 'Not authenticated.' };
  }
  const config = resolveSupabaseConfig();
  if (!config.url || !config.anonKey) return { session: null, error: 'Supabase is not configured.' };

  try {
    const client = createClient(config.url, config.anonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false
      }
    });
    const { data, error } = await client.auth.setSession({
      access_token: stored.access_token,
      refresh_token: stored.refresh_token
    });
    if (error) return { session: null, error: readableErrorMessage(error.message, 'Session expired.') };
    if (data && data.session) {
      writeAuthSession(data.session);
      return { session: data.session, error: '' };
    }
    return { session: stored, error: '' };
  } catch (e) {
    return { session: stored, error: '' };
  }
}

async function requireAuthSession() {
  const { session, error } = await getFreshSession();
  if (!session || error) return { session: null, error: readableErrorMessage(error, 'Not authenticated.') };
  return { session, error: '' };
}

async function requireCloudAccessContext() {
  const { session, error } = await requireAuthSession();
  if (error) return { session: null, client: null, error };

  const client = createAuthedSupabaseClient(session.access_token);
  if (!client) return { session: null, client: null, error: 'Supabase is not configured.' };
  return { session, client, error: '' };
}

function cloudAccessErrorResponse(context = {}) {
  const payload = {
    success: false,
    error: readableErrorMessage(context.error, 'Cloud access unavailable.')
  };
  if (context.code) payload.code = context.code;
  return payload;
}

function normalizeStoredSession(session) {
  if (!session || typeof session !== 'object') return null;
  const accessToken = typeof session.access_token === 'string' ? session.access_token.trim() : '';
  const refreshToken = typeof session.refresh_token === 'string' ? session.refresh_token.trim() : '';
  if (!accessToken || !refreshToken) return null;

  const expiresAtRaw = Number(session.expires_at);
  const user = (session.user && typeof session.user === 'object')
    ? {
        id: typeof session.user.id === 'string' ? session.user.id : '',
        email: typeof session.user.email === 'string' ? session.user.email : ''
      }
    : null;

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: typeof session.token_type === 'string' ? session.token_type : 'bearer',
    expires_at: Number.isFinite(expiresAtRaw) ? expiresAtRaw : null,
    user
  };
}

function readAuthSession() {
  try {
    if (!fs.existsSync(AUTH_SESSION_FILE)) return null;
    const raw = fs.readFileSync(AUTH_SESSION_FILE, 'utf8');
    const parsed = JSON.parse(raw || '{}');
    const normalized = normalizeStoredSession(parsed);
    if (!normalized) {
      fs.unlinkSync(AUTH_SESSION_FILE);
      return null;
    }
    return normalized;
  } catch (e) {
    return null;
  }
}

function writeAuthSession(session) {
  const normalized = normalizeStoredSession(session);
  if (!normalized) {
    try {
      if (fs.existsSync(AUTH_SESSION_FILE)) fs.unlinkSync(AUTH_SESSION_FILE);
    } catch (e) {}
    return false;
  }

  try {
    fs.writeFileSync(AUTH_SESSION_FILE, JSON.stringify(normalized, null, 2), 'utf8');
    return true;
  } catch (e) {
    return false;
  }
}

function clearAuthSession() {
  try {
    if (fs.existsSync(AUTH_SESSION_FILE)) fs.unlinkSync(AUTH_SESSION_FILE);
  } catch (e) {}
}

function readAuthPassword() {
  try {
    if (!fs.existsSync(AUTH_PASSWORD_FILE)) return { plain: '', length: 0 };
    const raw = fs.readFileSync(AUTH_PASSWORD_FILE, 'utf8');
    const parsed = JSON.parse(raw || '{}');
    const plain = typeof parsed.plain === 'string' ? parsed.plain : '';
    const lenRaw = Number(parsed.length);
    const length = Number.isFinite(lenRaw) && lenRaw >= 0 ? Math.floor(lenRaw) : (plain ? plain.length : 0);
    return { plain, length };
  } catch (e) {
    return { plain: '', length: 0 };
  }
}

function writeAuthPassword(plain) {
  const value = String(plain || '');
  if (!value) {
    clearAuthPassword();
    return false;
  }
  const payload = { plain: value, length: value.length };
  try {
    fs.writeFileSync(AUTH_PASSWORD_FILE, JSON.stringify(payload, null, 2), 'utf8');
    return true;
  } catch (e) {
    return false;
  }
}

function clearAuthPassword() {
  try {
    if (fs.existsSync(AUTH_PASSWORD_FILE)) fs.unlinkSync(AUTH_PASSWORD_FILE);
  } catch (e) {}
}

function getAuthStateSnapshot() {
  const session = readAuthSession();
  const configured = isSupabaseConfigured();
  return {
    configured,
    authenticated: Boolean(session && session.access_token && session.refresh_token),
    email: session && session.user && session.user.email ? session.user.email : ''
  };
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function validateEmailAndPassword(email, password) {
  const normalizedEmail = normalizeEmail(email);
  const normalizedPassword = String(password || '');
  if (!normalizedEmail || !normalizedPassword) return 'Email and password are required.';
  if (normalizedPassword.length < 6) return 'Password must be at least 6 characters.';
  return '';
}

function getStartupPagePath() {
  const srcDir = path.join(__dirname, 'src');
  const welcomePath = path.join(srcDir, 'welcome.html');
  const loginPath = path.join(srcDir, 'login.html');
  const indexPath = path.join(srcDir, 'index.html');
  const legacyIndexPath = path.join(__dirname, 'index.html');

  if (fs.existsSync(welcomePath) && !hasSeenWelcomeScreen()) {
    markWelcomeScreenSeen();
    return welcomePath;
  }
  if (fs.existsSync(indexPath)) return indexPath;
  if (fs.existsSync(loginPath)) return loginPath;
  return legacyIndexPath;
}

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  mainWindow = new BrowserWindow({
    width: 1300,
    height: 800,
    icon: getAppIconPath(),
    title: 'Noto',
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      devTools: false
    }
  });

  mainWindow.loadFile(getStartupPagePath());
  mainWindow.webContents.on('did-finish-load', () => {
    flushPendingRendererLaunchSignals();
  });
  mainWindow.on('closed', () => {
    quitGuardRequestInFlight = false;
    isExplicitQuitRequested = false;
    mainWindow = null;
  });
  mainWindow.__allowGuardedClose = false;
  mainWindow.on('close', (event) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.__allowGuardedClose) {
      mainWindow.__allowGuardedClose = false;
      quitGuardRequestInFlight = false;
      return;
    }
    if (!isExplicitQuitRequested && !readAppBehaviorSettings().closeAppOnWindowClose && hideMainWindowToTray()) {
      event.preventDefault();
      return;
    }

    const pageUrl = String(mainWindow.webContents && mainWindow.webContents.getURL ? mainWindow.webContents.getURL() : '').toLowerCase();
    const shouldGuardClose = pageUrl.includes('index.html');
    if (!shouldGuardClose) return;
    if (quitGuardRequestInFlight) {
      event.preventDefault();
      return;
    }

    event.preventDefault();
    quitGuardRequestInFlight = true;
    try {
      mainWindow.webContents.send('app-close-requested');
    } catch (e) {
      quitGuardRequestInFlight = false;
      mainWindow.__allowGuardedClose = true;
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
      }, 0);
    }
  });
  return mainWindow;
}

app.setName('Noto');
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('before-quit', () => {
    isExplicitQuitRequested = true;
  });
  app.on('second-instance', (_event, argv) => {
    const launchRequest = parseLaunchRequest(argv);
    if (launchRequest) {
      dispatchLaunchRequest(launchRequest);
      return;
    }
    showMainWindow();
  });

  app.whenReady().then(() => {
    if (process.platform === 'win32') {
      app.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID);
    }
    syncStoredOpenOnSystemStartSetting();
    createWindow();
    createWindowsTrayIfNeeded();
    refreshWindowsShellUi({ immediate: true });
    const startupLaunchRequest = parseLaunchRequest(process.argv);
    if (startupLaunchRequest) dispatchLaunchRequest(startupLaunchRequest);
  });
}

// --- WINDOW CONTROLS ---
ipcMain.on('window-minimize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.minimize();
});

ipcMain.on('window-maximize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    win.isMaximized() ? win.unmaximize() : win.maximize();
  }
});

ipcMain.on('window-close', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.close();
});

ipcMain.on('window-close-approved', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  win.__allowGuardedClose = true;
  win.close();
});

// --- AUTH ---
ipcMain.handle('auth-get-state', async () => {
  const state = getAuthStateSnapshot();
  return {
    success: true,
    configured: state.configured,
    authenticated: state.authenticated,
    email: state.email,
    error: (!state.configured && supabaseConfigError) ? supabaseConfigError : ''
  };
});

ipcMain.handle('auth-sign-in', async (_, payload = {}) => {
  try {
    const email = normalizeEmail(payload && payload.email);
    const password = String(payload && payload.password ? payload.password : '');
    const validationError = validateEmailAndPassword(email, password);
    if (validationError) return { success: false, error: validationError };

    const supabase = ensureSupabaseClient();
    if (!supabase) {
      return {
        success: false,
        error: supabaseConfigError || 'Supabase is not configured.'
      };
    }

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return { success: false, error: error.message || 'Login failed.' };
    if (!data || !data.session) return { success: false, error: 'Login failed. No active session returned.' };

    writeAuthSession(data.session);
    writeAuthPassword(password);
    const stored = readAuthSession();
    return {
      success: true,
      authenticated: Boolean(stored),
      email: (stored && stored.user && stored.user.email) ? stored.user.email : email
    };
  } catch (e) {
    return { success: false, error: e.message || 'Login failed.' };
  }
});

ipcMain.handle('auth-sign-up', async (_, payload = {}) => {
  try {
    const email = normalizeEmail(payload && payload.email);
    const password = String(payload && payload.password ? payload.password : '');
    const validationError = validateEmailAndPassword(email, password);
    if (validationError) return { success: false, error: validationError };

    const supabase = ensureSupabaseClient();
    if (!supabase) {
      return {
        success: false,
        error: supabaseConfigError || 'Supabase is not configured.'
      };
    }

    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) return { success: false, error: error.message || 'Signup failed.' };

    if (data && data.session) {
      writeAuthSession(data.session);
      writeAuthPassword(password);
      return { success: true, authenticated: true, requiresEmailConfirmation: false };
    }

    // If email confirmations are disabled, this succeeds and returns a session.
    const signInResult = await supabase.auth.signInWithPassword({ email, password });
    if (!signInResult.error && signInResult.data && signInResult.data.session) {
      writeAuthSession(signInResult.data.session);
      writeAuthPassword(password);
      return { success: true, authenticated: true, requiresEmailConfirmation: false };
    }

    clearAuthSession();
    return {
      success: true,
      authenticated: false,
      requiresEmailConfirmation: true,
      message: 'Account created. Confirm your email before logging in if confirmation is enabled.'
    };
  } catch (e) {
    return { success: false, error: e.message || 'Signup failed.' };
  }
});

ipcMain.handle('auth-delete-account', async () => {
  try {
    const savedSession = readAuthSession();
    if (!savedSession || !savedSession.user || !savedSession.user.id) {
      return { success: false, error: 'Not authenticated.' };
    }

    const config = resolveSupabaseConfig();
    if (!config.deleteAccountUrl) {
      return {
        success: false,
        error: 'Delete account requires a secure backend endpoint. Set SUPABASE_DELETE_ACCOUNT_URL or deleteAccountUrl in supabase.config.json.'
      };
    }

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.anonKey || savedSession.access_token}`,
      'x-user-token': savedSession.access_token
    };
    if (config.anonKey) headers.apikey = config.anonKey;

    const res = await fetch(config.deleteAccountUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ userId: savedSession.user.id })
    });

    if (!res.ok) {
      let message = 'Delete account failed.';
      try {
        const payload = await res.json();
        if (payload && payload.error) message = String(payload.error);
      } catch (e) {}
      return { success: false, error: message };
    }

    clearAuthSession();
    clearAuthPassword();
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message || 'Delete account failed.' };
  }
});

ipcMain.handle('auth-sign-out', async () => {
  try {
    const savedSession = readAuthSession();
    const supabase = ensureSupabaseClient();
    if (supabase && savedSession) {
      try {
        await supabase.auth.setSession({
          access_token: savedSession.access_token,
          refresh_token: savedSession.refresh_token
        });
        await supabase.auth.signOut();
      } catch (e) {}
    }
    clearAuthSession();
    clearAuthPassword();
    return { success: true };
  } catch (e) {
    const savedSession = readAuthSession();
    clearAuthSession();
    clearAuthPassword();
    return { success: true };
  }
});

ipcMain.handle('auth-get-password', async () => {
  const payload = readAuthPassword();
  return { success: true, plain: payload.plain, length: payload.length };
});

// --- CLOUD NOTES ---
ipcMain.handle('cloud-upsert-note', async (_, payload = {}) => {
  try {
    const context = await requireCloudAccessContext();
    if (context.error) return cloudAccessErrorResponse(context);
    const { session, client } = context;

    const title = String(payload.title || 'Untitled');
    const content = String(payload.content || '');
    const noteId = typeof payload.noteId === 'string' ? payload.noteId.trim() : '';
    const ownerEmail = (session.user.email || '').toLowerCase();
    const storageConfig = resolveCloudStorageConfig();
    const contentBytes = getUtf8ByteSize(content);
    const preserveHistory = Boolean(payload.versionHistoryEnabled);
    const historyMaxVersions = Math.max(1, toSafePositiveInt(payload.historyMaxVersions, 50));

    async function ensureOwnerCollaborator(noteIdValue) {
      try {
        await client
          .from('note_collaborators')
          .upsert({
            note_id: noteIdValue,
            user_id: session.user.id,
            collaborator_email: ownerEmail,
            role: 'owner'
          }, { onConflict: 'note_id,user_id' });
      } catch (e) {}
    }

    if (noteId) {
      const sharedRowResult = await getAccessibleSharedNoteRow(client, noteId);
      if (!sharedRowResult.success) return { success: false, error: sharedRowResult.error || 'Failed to update note.' };
      const shared = sharedRowResult.note;
      if (shared && shared.id) {
        if (shared.owner_id && shared.owner_id === session.user.id) {
          const quotaGate = await evaluateOwnerStorageQuota(client, shared.owner_id, contentBytes, shared.content_size, { session });
          if (!quotaGate.ok) {
            return {
              success: false,
              error: quotaGate.error || 'Storage quota exceeded.',
              code: quotaGate.code || 'storage_quota_exceeded',
              usageBytes: quotaGate.usageBytes,
              projectedUsageBytes: quotaGate.projectedUsageBytes,
              quotaBytes: quotaGate.quotaBytes,
              quotaKb: quotaGate.quotaKb
            };
          }
        }

        const bucket = String(shared.storage_bucket || storageConfig.bucket || '').trim() || storageConfig.bucket;
        const previousStoragePath = String(shared.storage_path || '').trim();
        const storagePath = buildVersionedCloudNoteStoragePath(shared.id, storageConfig)
          || buildCloudNoteStoragePath(shared.id, storageConfig);
        const uploadResult = await uploadNoteContentToStorage(client, bucket, storagePath, content);
        if (!uploadResult.success) return { success: false, error: uploadResult.error || 'Failed to update note file.' };

        const { data, error: updateError } = await client
          .from('notes')
          .update({
            title,
            content: '',
            storage_bucket: bucket,
            storage_path: storagePath,
            content_size: uploadResult.sizeBytes
          })
          .eq('id', shared.id)
          .select('id, updated_at')
          .maybeSingle();
        if (updateError) {
          await removeNoteContentFromStorage(client, bucket, storagePath);
          return { success: false, error: readableErrorMessage(updateError.message, 'Failed to update note.') };
        }
        if (!data || !data.id) {
          await removeNoteContentFromStorage(client, bucket, storagePath);
          return { success: false, error: 'Note not found or access denied.', missing: true };
        }
        if (preserveHistory) {
          const historyFolder = buildCloudNoteVersionsFolder(shared.id, storageConfig);
          await trimVersionFolderRetention(client, bucket, historyFolder, historyMaxVersions, [storagePath]);
        } else if (previousStoragePath && previousStoragePath !== storagePath) {
          await removeNoteContentFromStorage(client, bucket, previousStoragePath);
        }
        await ensureOwnerCollaborator(shared.id);
        return { success: true, noteId: data.id, updatedAt: data.updated_at };
      }

      return upsertPersonalNoteInManifest(client, session, {
        storageConfig,
        noteId,
        title,
        content,
        versionHistoryEnabled: preserveHistory,
        historyMaxVersions
      });
    }

    return upsertPersonalNoteInManifest(client, session, {
      storageConfig,
      title,
      content,
      versionHistoryEnabled: preserveHistory,
      historyMaxVersions
    });
  } catch (e) {
    return { success: false, error: readableErrorMessage(e && e.message, 'Failed to upload note.') };
  }
});

ipcMain.handle('cloud-update-note', async (_, payload = {}) => {
  try {
    const context = await requireCloudAccessContext();
    if (context.error) return cloudAccessErrorResponse(context);
    const { session, client } = context;

    const noteId = typeof payload.noteId === 'string' ? payload.noteId.trim() : '';
    if (!noteId) return { success: false, error: 'Missing note id.' };
    const title = String(payload.title || 'Untitled');
    const content = String(payload.content || '');
    const storageConfig = resolveCloudStorageConfig();
    const contentBytes = getUtf8ByteSize(content);
    const preserveHistory = Boolean(payload.versionHistoryEnabled);
    const historyMaxVersions = Math.max(1, toSafePositiveInt(payload.historyMaxVersions, 50));

    const sharedRowResult = await getAccessibleSharedNoteRow(client, noteId);
    if (!sharedRowResult.success) return { success: false, error: sharedRowResult.error || 'Failed to update note.' };
    const existing = sharedRowResult.note;

    if (existing && existing.id) {
      if (existing.owner_id && existing.owner_id === session.user.id) {
        const quotaGate = await evaluateOwnerStorageQuota(client, existing.owner_id, contentBytes, existing.content_size, { session });
        if (!quotaGate.ok) {
          return {
            success: false,
            error: quotaGate.error || 'Storage quota exceeded.',
            code: quotaGate.code || 'storage_quota_exceeded',
            usageBytes: quotaGate.usageBytes,
            projectedUsageBytes: quotaGate.projectedUsageBytes,
            quotaBytes: quotaGate.quotaBytes,
            quotaKb: quotaGate.quotaKb
          };
        }
      }

      const bucket = String(existing.storage_bucket || storageConfig.bucket || '').trim() || storageConfig.bucket;
      const previousStoragePath = String(existing.storage_path || '').trim();
      const storagePath = buildVersionedCloudNoteStoragePath(existing.id, storageConfig)
        || buildCloudNoteStoragePath(existing.id, storageConfig);
      const uploadResult = await uploadNoteContentToStorage(client, bucket, storagePath, content);
      if (!uploadResult.success) return { success: false, error: uploadResult.error || 'Failed to update note file.' };

      const { data, error: updateError } = await client
        .from('notes')
        .update({
          title,
          content: '',
          storage_bucket: bucket,
          storage_path: storagePath,
          content_size: uploadResult.sizeBytes
        })
        .eq('id', noteId)
        .select('id, updated_at')
        .maybeSingle();
      if (updateError) {
        await removeNoteContentFromStorage(client, bucket, storagePath);
        return { success: false, error: readableErrorMessage(updateError.message, 'Failed to update note.') };
      }
      if (!data || !data.id) {
        await removeNoteContentFromStorage(client, bucket, storagePath);
        return { success: false, error: 'Note not found or access denied.', missing: true };
      }
      if (preserveHistory) {
        const historyFolder = buildCloudNoteVersionsFolder(existing.id, storageConfig);
        await trimVersionFolderRetention(client, bucket, historyFolder, historyMaxVersions, [storagePath]);
      } else if (previousStoragePath && previousStoragePath !== storagePath) {
        await removeNoteContentFromStorage(client, bucket, previousStoragePath);
      }
      return { success: true, noteId: data.id, updatedAt: data.updated_at };
    }

    return upsertPersonalNoteInManifest(client, session, {
      storageConfig,
      noteId,
      title,
      content,
      versionHistoryEnabled: preserveHistory,
      historyMaxVersions
    });
  } catch (e) {
    return { success: false, error: readableErrorMessage(e && e.message, 'Failed to update note.') };
  }
});

ipcMain.handle('cloud-get-note', async (_, payload = {}) => {
  try {
    const context = await requireCloudAccessContext();
    if (context.error) return cloudAccessErrorResponse(context);
    const { session, client } = context;

    const noteId = typeof payload.noteId === 'string' ? payload.noteId.trim() : '';
    if (!noteId) return { success: false, error: 'Missing note id.' };
    const storageConfig = resolveCloudStorageConfig();

    const sharedRowResult = await getAccessibleSharedNoteRow(client, noteId);
    if (!sharedRowResult.success) return { success: false, error: sharedRowResult.error || 'Failed to load note.' };
    const shared = sharedRowResult.note;
    if (shared && shared.id) {
      let content = '';
      const storagePath = String(shared.storage_path || '').trim();
      if (storagePath) {
        const bucket = String(shared.storage_bucket || storageConfig.bucket || '').trim() || storageConfig.bucket;
        const downloadResult = await downloadNoteContentFromStorage(client, bucket, storagePath);
        if (!downloadResult.success) {
          return {
            success: false,
            error: downloadResult.error || 'Failed to load cloud note file.',
            missing: Boolean(downloadResult.missing)
          };
        }
        content = downloadResult.content;
      }
      return {
        success: true,
        note: {
          id: shared.id,
          title: shared.title,
          content,
          updated_at: shared.updated_at,
          owner_id: shared.owner_id
        }
      };
    }

    return getPersonalNoteFromManifest(client, session, noteId, storageConfig);
  } catch (e) {
    return { success: false, error: readableErrorMessage(e && e.message, 'Failed to load note.') };
  }
});

ipcMain.handle('cloud-list-note-versions', async (_, payload = {}) => {
  try {
    const context = await requireCloudAccessContext();
    if (context.error) return cloudAccessErrorResponse(context);
    const { session, client } = context;

    const noteId = typeof payload.noteId === 'string' ? payload.noteId.trim() : '';
    if (!noteId) return { success: false, error: 'Missing note id.' };
    const storageConfig = resolveCloudStorageConfig();
    const versionCtx = await resolveCloudVersionContext(client, session, noteId, storageConfig);
    if (!versionCtx.success) {
      return {
        success: false,
        error: versionCtx.error || 'Failed to load note versions.',
        missing: Boolean(versionCtx.missing)
      };
    }

    const listed = await listStorageFolderObjects(client, versionCtx.bucket, versionCtx.folder);
    if (!listed.success) return { success: false, error: listed.error || 'Failed to load note versions.' };

    const limit = Math.max(1, Math.min(500, toSafePositiveInt(payload.limit, 50)));
    const currentPath = normalizeStorageObjectPath(versionCtx.currentStoragePath || '');
    const versions = (listed.objects || [])
      .map((item) => {
        const name = String(item && item.name ? item.name : '').trim();
        if (!name || name.endsWith('/')) return null;
        const fullPath = `${versionCtx.folder}/${name}`;
        const ts = storageObjectTimestamp(item, fullPath);
        const sizeBytes = normalizeContentSize(
          item && item.metadata && typeof item.metadata === 'object'
            ? (item.metadata.size ?? item.metadata.contentLength ?? item.size)
            : (item && item.size)
        );
        return {
          id: fullPath,
          storagePath: fullPath,
          uploadedAt: ts > 0 ? new Date(ts).toISOString() : '',
          sizeBytes,
          isCurrent: normalizeStorageObjectPath(fullPath) === currentPath,
          _ts: ts
        };
      })
      .filter(Boolean)
      .sort((a, b) => {
        if (b._ts !== a._ts) return b._ts - a._ts;
        return String(b.storagePath).localeCompare(String(a.storagePath));
      })
      .slice(0, limit)
      .map((entry) => ({
        id: entry.id,
        storagePath: entry.storagePath,
        uploadedAt: entry.uploadedAt,
        sizeBytes: entry.sizeBytes,
        isCurrent: entry.isCurrent
      }));

    return { success: true, versions };
  } catch (e) {
    return { success: false, error: readableErrorMessage(e && e.message, 'Failed to load note versions.') };
  }
});

ipcMain.handle('cloud-get-note-version', async (_, payload = {}) => {
  try {
    const context = await requireCloudAccessContext();
    if (context.error) return cloudAccessErrorResponse(context);
    const { session, client } = context;

    const noteId = typeof payload.noteId === 'string' ? payload.noteId.trim() : '';
    const storagePathRaw = typeof payload.storagePath === 'string' ? payload.storagePath.trim() : '';
    if (!noteId || !storagePathRaw) return { success: false, error: 'Missing version reference.' };
    const storageConfig = resolveCloudStorageConfig();
    const versionCtx = await resolveCloudVersionContext(client, session, noteId, storageConfig);
    if (!versionCtx.success) {
      return {
        success: false,
        error: versionCtx.error || 'Failed to load note version.',
        missing: Boolean(versionCtx.missing)
      };
    }

    const safeStoragePath = normalizeStorageObjectPath(storagePathRaw);
    const safeFolder = normalizeStorageObjectPath(versionCtx.folder);
    if (!safeStoragePath || !safeFolder || !safeStoragePath.startsWith(`${safeFolder}/`)) {
      return { success: false, error: 'Invalid note version path.' };
    }

    const downloadResult = await downloadNoteContentFromStorage(client, versionCtx.bucket, safeStoragePath);
    if (!downloadResult.success) {
      return {
        success: false,
        error: downloadResult.error || 'Failed to load note version.',
        missing: Boolean(downloadResult.missing)
      };
    }

    const ts = parseVersionTimestampFromPath(safeStoragePath);
    return {
      success: true,
      version: {
        storagePath: safeStoragePath,
        uploadedAt: ts > 0 ? new Date(ts).toISOString() : '',
        content: downloadResult.content || ''
      }
    };
  } catch (e) {
    return { success: false, error: readableErrorMessage(e && e.message, 'Failed to load note version.') };
  }
});

ipcMain.handle('cloud-delete-note', async (_, payload = {}) => {
  try {
    const context = await requireCloudAccessContext();
    if (context.error) return cloudAccessErrorResponse(context);
    const { session, client } = context;

    const noteId = typeof payload.noteId === 'string' ? payload.noteId.trim() : '';
    if (!noteId) return { success: false, error: 'Missing note id.' };
    const storageConfig = resolveCloudStorageConfig();

    const sharedRowResult = await getAccessibleSharedNoteRow(client, noteId);
    if (!sharedRowResult.success) return { success: false, error: sharedRowResult.error || 'Failed to delete note.' };
    const existing = sharedRowResult.note;
    if (existing && existing.id) {
      const bucket = String(existing.storage_bucket || storageConfig.bucket || '').trim() || storageConfig.bucket;
      const storagePath = String(existing.storage_path || '').trim();
      if (storagePath) {
        const removeResult = await removeNoteContentFromStorage(client, bucket, storagePath);
        if (!removeResult.success) return { success: false, error: removeResult.error || 'Failed to delete note file.' };
      }
      const versionsFolder = buildCloudNoteVersionsFolder(noteId, storageConfig);
      await removeStorageFolderContents(client, bucket, versionsFolder);

      const { error: deleteError } = await client
        .from('notes')
        .delete()
        .eq('id', noteId);
      if (deleteError) return { success: false, error: readableErrorMessage(deleteError.message, 'Failed to delete note.') };
      if (existing.owner_id && existing.owner_id === session.user.id) {
        const manifestCtx = await loadPersonalManifestContext(client, session.user.id, storageConfig);
        if (manifestCtx.success && manifestCtx.manifest.notes && manifestCtx.manifest.notes[noteId]) {
          delete manifestCtx.manifest.notes[noteId];
          await writeUserNoteManifest(client, session.user.id, manifestCtx.manifest, storageConfig);
        }
      }
      return { success: true };
    }

    return deletePersonalNoteFromManifest(client, session, noteId, storageConfig);
  } catch (e) {
    return { success: false, error: readableErrorMessage(e && e.message, 'Failed to delete note.') };
  }
});

ipcMain.handle('cloud-list-invites', async () => {
  try {
    const context = await requireCloudAccessContext();
    if (context.error) return cloudAccessErrorResponse(context);
    const { session, client } = context;
    const email = (session.user && session.user.email) ? String(session.user.email).toLowerCase() : '';
    if (!email) return { success: false, error: 'Email not available.' };

    let data = null;
    let fetchError = null;

    const rpcResult = await client.rpc('list_my_note_invites');
    if (rpcResult && !rpcResult.error && Array.isArray(rpcResult.data)) {
      data = rpcResult.data;
    } else {
      fetchError = rpcResult && rpcResult.error ? rpcResult.error : null;
      const inviteQuery = client
        .from('note_invites')
        .select('id, note_id, status, role, created_at, invited_email, invited_by, note_title, invited_by_email, invited_by_name, notes(title, owner_id, owner_email)')
        .eq('status', 'pending')
        .eq('invited_email', email)
        .order('created_at', { ascending: false });
      const richResult = await inviteQuery;
      if (richResult && !richResult.error) {
        data = richResult.data || [];
        fetchError = null;
      } else if (isMissingSchemaColumnError(richResult && richResult.error, ['note_title', 'invited_by_email', 'invited_by_name'])) {
        const fallbackResult = await client
          .from('note_invites')
          .select('id, note_id, status, role, created_at, invited_email, invited_by, notes(title, owner_id, owner_email)')
          .eq('status', 'pending')
          .eq('invited_email', email)
          .order('created_at', { ascending: false });
        data = fallbackResult && Array.isArray(fallbackResult.data) ? fallbackResult.data : [];
        fetchError = fallbackResult && fallbackResult.error ? fallbackResult.error : null;
      } else {
        fetchError = richResult && richResult.error ? richResult.error : fetchError;
      }
    }

    if (fetchError) return { success: false, error: readableErrorMessage(fetchError.message, 'Failed to load invites.') };

    const invites = (data || []).map((row) => {
      const noteRef = pickEmbeddedSingle(row && row.notes);
      const noteTitle = firstNonEmptyString(
        row && row.note_title,
        noteRef && noteRef.title
      );
      const senderEmail = firstNonEmptyString(
        row && row.invited_by_email,
        noteRef && noteRef.owner_email
      ).toLowerCase();
      const senderName = firstNonEmptyString(
        row && row.invited_by_name,
        getEmailDisplayName(senderEmail)
      );
      return {
        id: row.id,
        note_id: row.note_id,
        status: row.status,
        role: row.role || 'editor',
        created_at: row.created_at,
        invited_email: row.invited_email,
        invited_by: row.invited_by || '',
        invited_by_email: senderEmail,
        invited_by_name: senderName,
        note_title: noteTitle,
        note: noteTitle || noteRef
          ? {
              title: noteTitle,
              owner_id: noteRef && noteRef.owner_id ? noteRef.owner_id : '',
              owner_email: senderEmail
            }
          : null
      };
    });
    return { success: true, invites };
  } catch (e) {
    return { success: false, error: readableErrorMessage(e && e.message, 'Failed to load invites.') };
  }
});

ipcMain.handle('cloud-delete-invite', async (_, payload = {}) => {
  try {
    const context = await requireCloudAccessContext();
    if (context.error) return cloudAccessErrorResponse(context);
    const { session, client } = context;

    const inviteId = typeof payload.inviteId === 'string' ? payload.inviteId.trim() : '';
    if (!inviteId) return { success: false, error: 'Missing invite id.' };

    const { error: updateError } = await client
      .from('note_invites')
      .update({ status: 'declined', responded_at: new Date().toISOString() })
      .eq('id', inviteId);
    if (updateError) return { success: false, error: readableErrorMessage(updateError.message, 'Failed to update invite.') };
    return { success: true };
  } catch (e) {
    return { success: false, error: readableErrorMessage(e && e.message, 'Failed to update invite.') };
  }
});

ipcMain.handle('cloud-send-invites', async (_, payload = {}) => {
  try {
    const context = await requireCloudAccessContext();
    if (context.error) return cloudAccessErrorResponse(context);
    const { session, client } = context;
    const storageConfig = resolveCloudStorageConfig();

    const noteId = typeof payload.noteId === 'string' ? payload.noteId.trim() : '';
    const emailsRaw = Array.isArray(payload.emails) ? payload.emails : [];
    const roleRaw = typeof payload.role === 'string' ? payload.role.trim().toLowerCase() : 'editor';
    const allowedRoles = new Set(['admin', 'editor', 'viewer']);
    const role = allowedRoles.has(roleRaw) ? roleRaw : 'editor';
    const emails = Array.from(new Set(emailsRaw.map((e) => String(e || '').trim().toLowerCase()).filter(Boolean)));
    if (!noteId) return { success: false, error: 'Missing note id.' };
    if (emails.length === 0) return { success: false, error: 'No invite emails provided.' };

    const sharedReady = await ensureSharedNoteRowForInvites(client, session, noteId, storageConfig);
    if (!sharedReady.success) return { success: false, error: sharedReady.error || 'Failed to prepare note for collaboration.' };

    const inviterEmail = (session.user.email || '').toLowerCase();
    const inviterName = getSessionUserDisplayName(session);
    const noteTitle = firstNonEmptyString(sharedReady.note && sharedReady.note.title, 'Untitled');
    const rows = emails.map((email) => ({
      note_id: noteId,
      invited_email: email,
      invited_by: session.user.id,
      note_title: noteTitle,
      invited_by_email: inviterEmail,
      invited_by_name: inviterName,
      role,
      status: 'pending'
    }));
    let { error: insertError } = await client
      .from('note_invites')
      .upsert(rows, { onConflict: 'note_id,invited_email' });
    if (insertError && isMissingSchemaColumnError(insertError, ['note_title', 'invited_by_email', 'invited_by_name'])) {
      const fallbackRows = rows.map((row) => ({
        note_id: row.note_id,
        invited_email: row.invited_email,
        invited_by: row.invited_by,
        role: row.role,
        status: row.status
      }));
      const fallbackInsert = await client
        .from('note_invites')
        .upsert(fallbackRows, { onConflict: 'note_id,invited_email' });
      insertError = fallbackInsert && fallbackInsert.error ? fallbackInsert.error : null;
    }
    if (insertError) return { success: false, error: readableErrorMessage(insertError.message, 'Failed to send invites.') };
    return { success: true };
  } catch (e) {
    return { success: false, error: readableErrorMessage(e && e.message, 'Failed to send invites.') };
  }
});

ipcMain.handle('cloud-accept-invite', async (_, payload = {}) => {
  try {
    const context = await requireCloudAccessContext();
    if (context.error) return cloudAccessErrorResponse(context);
    const { session, client } = context;

    const inviteId = typeof payload.inviteId === 'string' ? payload.inviteId.trim() : '';
    if (!inviteId) return { success: false, error: 'Missing invite id.' };

    const { data: invite, error: inviteError } = await client
      .from('note_invites')
      .select('id, note_id, status, role')
      .eq('id', inviteId)
      .single();
    if (inviteError || !invite) return { success: false, error: readableErrorMessage(inviteError?.message, 'Invite not found.') };
    if (invite.status !== 'pending') return { success: false, error: 'Invite already handled.' };

    const noteId = invite.note_id;
    if (!noteId) return { success: false, error: 'Invite has no note id.' };

    const inviteRole = (invite && invite.role) ? String(invite.role).toLowerCase() : 'editor';
    const allowedRoles = new Set(['admin', 'editor', 'viewer']);
    const safeRole = allowedRoles.has(inviteRole) ? inviteRole : 'editor';

    await client.from('note_collaborators').upsert({
      note_id: noteId,
      user_id: session.user.id,
      collaborator_email: (session.user.email || '').toLowerCase(),
      role: safeRole
    }, { onConflict: 'note_id,user_id' });

    await client
      .from('note_invites')
      .update({ status: 'accepted', responded_at: new Date().toISOString() })
      .eq('id', inviteId);

    return { success: true, noteId };
  } catch (e) {
    return { success: false, error: readableErrorMessage(e && e.message, 'Failed to accept invite.') };
  }
});

ipcMain.handle('cloud-list-collaborators', async (_, payload = {}) => {
  try {
    const context = await requireCloudAccessContext();
    if (context.error) return cloudAccessErrorResponse(context);
    const { session, client } = context;
    const storageConfig = resolveCloudStorageConfig();

    const noteId = typeof payload.noteId === 'string' ? payload.noteId.trim() : '';
    if (!noteId) return { success: false, error: 'Missing note id.' };

    const { data: note, error: noteError } = await client
      .from('notes')
      .select('id, owner_id, owner_email, title')
      .eq('id', noteId)
      .maybeSingle();
    if (noteError) return { success: false, error: readableErrorMessage(noteError?.message, 'Failed to load collaborators.') };
    if (!note) {
      const manifestCtx = await loadPersonalManifestContext(client, session.user.id, storageConfig);
      if (!manifestCtx.success) {
        if (!manifestCtx.missing) {
          const emailFallback = (session.user.email || '').toLowerCase();
          return {
            success: true,
            collaborators: [{
              user_id: session.user.id,
              email: emailFallback,
              role: 'owner'
            }],
            pending_invites: [],
            note: {
              id: noteId,
              title: 'Untitled',
              owner_id: session.user.id,
              owner_email: emailFallback
            }
          };
        }
        return {
          success: false,
          error: manifestCtx.error || 'Failed to load collaborators.',
          missing: Boolean(manifestCtx.missing)
        };
      }
      const entry = getManifestNoteEntry(manifestCtx.manifest, noteId);
      if (!entry) return { success: false, error: 'Note not found or access denied.', missing: true };
      const email = (session.user.email || '').toLowerCase();
      return {
        success: true,
        collaborators: [{
          user_id: session.user.id,
          email,
          role: 'owner'
        }],
        note: {
          id: noteId,
          title: entry.title || 'Untitled',
          owner_id: session.user.id,
          owner_email: email
        },
        pending_invites: []
      };
    }

    const { data: collaborators, error: collabError } = await client
      .from('note_collaborators')
      .select('user_id, collaborator_email, role')
      .eq('note_id', noteId);
    if (collabError) return { success: false, error: readableErrorMessage(collabError.message, 'Failed to load collaborators.') };

    const list = Array.isArray(collaborators) ? collaborators.map((row) => ({
      user_id: row.user_id,
      email: row.collaborator_email || '',
      role: row.role || 'editor'
    })) : [];

    if (note.owner_id && !list.find((entry) => entry.user_id === note.owner_id)) {
      list.unshift({
        user_id: note.owner_id,
        email: note.owner_email || '',
        role: 'owner'
      });
    }

    let pendingInvites = [];
    const requesterId = session.user.id;
    const requesterEmail = (session.user.email || '').toLowerCase();
    const requesterEntry = list.find((entry) => entry && entry.user_id === requesterId);
    const requesterRole = requesterId === note.owner_id
      ? 'owner'
      : String((requesterEntry && requesterEntry.role) || '').toLowerCase();
    const canManageInvites = requesterRole === 'owner' || requesterRole === 'admin';
    if (canManageInvites) {
      const { data: pendingRows, error: pendingError } = await client
        .from('note_invites')
        .select('invited_email, role, created_at, status')
        .eq('note_id', noteId)
        .eq('status', 'pending')
        .order('created_at', { ascending: true });
      if (!pendingError) {
        pendingInvites = Array.isArray(pendingRows)
          ? pendingRows
              .map((row) => ({
                email: String((row && row.invited_email) || '').toLowerCase(),
                role: String((row && row.role) || 'editor').toLowerCase(),
                created_at: row && row.created_at ? row.created_at : '',
                status: 'pending'
              }))
              .filter((row) => row.email && row.email !== requesterEmail)
          : [];
      }
    }

    return {
      success: true,
      collaborators: list,
      pending_invites: pendingInvites,
      note: {
        id: note.id,
        title: note.title,
        owner_id: note.owner_id,
        owner_email: note.owner_email || ''
      }
    };
  } catch (e) {
    return { success: false, error: readableErrorMessage(e && e.message, 'Failed to load collaborators.') };
  }
});

ipcMain.handle('cloud-update-collaborator-role', async (_, payload = {}) => {
  try {
    const context = await requireCloudAccessContext();
    if (context.error) return cloudAccessErrorResponse(context);
    const { session, client } = context;

    const noteId = typeof payload.noteId === 'string' ? payload.noteId.trim() : '';
    const userId = typeof payload.userId === 'string' ? payload.userId.trim() : '';
    const roleRaw = typeof payload.role === 'string' ? payload.role.trim().toLowerCase() : '';
    const allowedRoles = new Set(['admin', 'editor', 'viewer']);
    if (!noteId || !userId) return { success: false, error: 'Missing note or user.' };
    if (!allowedRoles.has(roleRaw)) return { success: false, error: 'Invalid role.' };

    const { data: note, error: noteError } = await client
      .from('notes')
      .select('owner_id')
      .eq('id', noteId)
      .single();
    if (noteError || !note) return { success: false, error: readableErrorMessage(noteError?.message, 'Note not found.') };
    if (note.owner_id === userId) return { success: false, error: 'Owner role cannot be changed.' };

    const { error: updateError } = await client
      .from('note_collaborators')
      .update({ role: roleRaw })
      .eq('note_id', noteId)
      .eq('user_id', userId);
    if (updateError) return { success: false, error: readableErrorMessage(updateError.message, 'Failed to update role.') };
    return { success: true };
  } catch (e) {
    return { success: false, error: readableErrorMessage(e && e.message, 'Failed to update role.') };
  }
});

ipcMain.handle('cloud-remove-collaborator', async (_, payload = {}) => {
  try {
    const context = await requireCloudAccessContext();
    if (context.error) return cloudAccessErrorResponse(context);
    const { session, client } = context;

    const noteId = typeof payload.noteId === 'string' ? payload.noteId.trim() : '';
    const userId = typeof payload.userId === 'string' ? payload.userId.trim() : '';
    if (!noteId || !userId) return { success: false, error: 'Missing note or user.' };

    const { data: note, error: noteError } = await client
      .from('notes')
      .select('owner_id')
      .eq('id', noteId)
      .single();
    if (noteError || !note) return { success: false, error: readableErrorMessage(noteError?.message, 'Note not found.') };
    if (note.owner_id === userId) return { success: false, error: 'Owner cannot be removed.' };

    const { error: deleteError } = await client
      .from('note_collaborators')
      .delete()
      .eq('note_id', noteId)
      .eq('user_id', userId);
    if (deleteError) return { success: false, error: readableErrorMessage(deleteError.message, 'Failed to remove collaborator.') };
    return { success: true };
  } catch (e) {
    return { success: false, error: readableErrorMessage(e && e.message, 'Failed to remove collaborator.') };
  }
});

ipcMain.handle('cloud-list-collaborations', async () => {
  try {
    const context = await requireCloudAccessContext();
    if (context.error) return cloudAccessErrorResponse(context);
    const { session, client } = context;

    const { data, error: fetchError } = await client
      .from('notes')
      .select('id, title, updated_at, owner_id, owner_email, note_collaborators(user_id)')
      .order('updated_at', { ascending: false });
    if (fetchError) return { success: false, error: readableErrorMessage(fetchError.message, 'Failed to load collaborations.') };

    const userId = session.user.id;
    const collaborations = (data || [])
      .map((row) => {
        const collabs = Array.isArray(row.note_collaborators) ? row.note_collaborators : [];
        const otherCount = collabs.filter((c) => c.user_id && c.user_id !== userId).length;
        const shared = row.owner_id !== userId || otherCount > 0;
        return {
          id: row.id,
          title: row.title,
          updated_at: row.updated_at,
          owner_id: row.owner_id,
          owner_email: row.owner_email || '',
          shared
        };
      })
      .filter((row) => row.shared);

    return { success: true, collaborations };
  } catch (e) {
    return { success: false, error: readableErrorMessage(e && e.message, 'Failed to load collaborations.') };
  }
});

ipcMain.handle('cloud-get-storage-usage', async () => {
  try {
    const { session, error } = await requireAuthSession();
    if (error || !session || !session.user || !session.user.id) {
      return { success: false, error: error || 'Not authenticated.', code: 'not_authenticated' };
    }

    const client = createAuthedSupabaseClient(session.access_token);
    if (!client) return { success: false, error: 'Supabase is not configured.' };

    const usageResult = await getUserOwnedCloudStorageUsageBytes(client, session.user.id, {
      session,
      force: true,
      allowPartial: true
    });
    if (!usageResult.success) {
      return {
        success: false,
        error: readableErrorMessage(usageResult.error, 'Failed to load storage usage.'),
        code: 'storage_usage_failed'
      };
    }

    const config = resolveCloudStorageConfig();
    const usedBytes = usageResult.usageBytes;
    const quotaBytes = config.globalUserQuotaBytes;
    const usageRatio = quotaBytes > 0 ? (usedBytes / quotaBytes) : 0;
    return {
      success: true,
      usedBytes,
      quotaBytes,
      quotaKb: config.globalUserQuotaKb,
      usageRatio,
      bucket: config.bucket
    };
  } catch (e) {
    return { success: false, error: readableErrorMessage(e && e.message, 'Failed to load storage usage.') };
  }
});

ipcMain.handle('cloud-upsert-presence', async (_, payload = {}) => {
  try {
    const context = await requireCloudAccessContext();
    if (context.error) return cloudAccessErrorResponse(context);
    const { session, client } = context;
    const storageConfig = resolveCloudStorageConfig();

    const noteId = typeof payload.noteId === 'string' ? payload.noteId.trim() : '';
    if (!noteId) return { success: false, error: 'Missing note id.' };

    const sharedRowResult = await getAccessibleSharedNoteRow(client, noteId);
    if (!sharedRowResult.success) return { success: false, error: sharedRowResult.error || 'Failed to update presence.' };
    if (!sharedRowResult.note) {
      const manifestCtx = await loadPersonalManifestContext(client, session.user.id, storageConfig);
      if (!manifestCtx.success) {
        if (!manifestCtx.missing) return { success: true };
        return {
          success: false,
          error: manifestCtx.error || 'Failed to update presence.',
          missing: Boolean(manifestCtx.missing)
        };
      }
      const entry = getManifestNoteEntry(manifestCtx.manifest, noteId);
      if (!entry) return { success: false, error: 'Note not found or access denied.', missing: true };
      return { success: true };
    }

    const nowIso = new Date().toISOString();
    const updatePayload = {
      user_email: (session.user.email || '').toLowerCase(),
      last_seen: nowIso
    };
    const { data: updatedRows, error: updateError } = await client
      .from('note_presence')
      .update(updatePayload)
      .eq('note_id', noteId)
      .eq('user_id', session.user.id)
      .select('note_id');
    if (updateError) return { success: false, error: readableErrorMessage(updateError.message, 'Failed to update presence.') };

    if (!Array.isArray(updatedRows) || updatedRows.length === 0) {
      const { error: insertError } = await client
        .from('note_presence')
        .insert({
          note_id: noteId,
          user_id: session.user.id,
          user_email: (session.user.email || '').toLowerCase(),
          last_seen: nowIso
        });
      if (insertError && !isDuplicateConstraintError(insertError)) {
        return { success: false, error: readableErrorMessage(insertError.message, 'Failed to update presence.') };
      }
      if (insertError && isDuplicateConstraintError(insertError)) {
        const { error: retryUpdateError } = await client
          .from('note_presence')
          .update(updatePayload)
          .eq('note_id', noteId)
          .eq('user_id', session.user.id);
        if (retryUpdateError) {
          return { success: false, error: readableErrorMessage(retryUpdateError.message, 'Failed to update presence.') };
        }
      }
    }

    return { success: true };
  } catch (e) {
    return { success: false, error: readableErrorMessage(e && e.message, 'Failed to update presence.') };
  }
});

ipcMain.handle('cloud-clear-presence', async (_, payload = {}) => {
  try {
    const context = await requireCloudAccessContext();
    if (context.error) return cloudAccessErrorResponse(context);
    const { session, client } = context;
    const storageConfig = resolveCloudStorageConfig();

    const noteId = typeof payload.noteId === 'string' ? payload.noteId.trim() : '';
    if (!noteId) return { success: false, error: 'Missing note id.' };

    const sharedRowResult = await getAccessibleSharedNoteRow(client, noteId);
    if (!sharedRowResult.success) return { success: false, error: sharedRowResult.error || 'Failed to clear presence.' };
    if (!sharedRowResult.note) {
      const manifestCtx = await loadPersonalManifestContext(client, session.user.id, storageConfig);
      if (!manifestCtx.success) {
        if (!manifestCtx.missing) return { success: true };
        return {
          success: false,
          error: manifestCtx.error || 'Failed to clear presence.',
          missing: Boolean(manifestCtx.missing)
        };
      }
      const entry = getManifestNoteEntry(manifestCtx.manifest, noteId);
      if (!entry) return { success: false, error: 'Note not found or access denied.', missing: true };
      return { success: true };
    }

    const { error: deleteError } = await client
      .from('note_presence')
      .delete()
      .eq('note_id', noteId)
      .eq('user_id', session.user.id);
    if (deleteError) return { success: false, error: readableErrorMessage(deleteError.message, 'Failed to clear presence.') };
    return { success: true };
  } catch (e) {
    return { success: false, error: readableErrorMessage(e && e.message, 'Failed to clear presence.') };
  }
});

ipcMain.handle('cloud-list-presence', async (_, payload = {}) => {
  try {
    const context = await requireCloudAccessContext();
    if (context.error) return cloudAccessErrorResponse(context);
    const { session, client } = context;
    const storageConfig = resolveCloudStorageConfig();

    const noteId = typeof payload.noteId === 'string' ? payload.noteId.trim() : '';
    if (!noteId) return { success: false, error: 'Missing note id.' };

    const sharedRowResult = await getAccessibleSharedNoteRow(client, noteId);
    if (!sharedRowResult.success) return { success: false, error: sharedRowResult.error || 'Failed to load presence.' };
    if (!sharedRowResult.note) {
      const manifestCtx = await loadPersonalManifestContext(client, session.user.id, storageConfig);
      if (!manifestCtx.success) {
        if (!manifestCtx.missing) {
          return {
            success: true,
            users: [{
              user_id: session.user.id,
              email: (session.user.email || '').toLowerCase(),
              last_seen: new Date().toISOString()
            }]
          };
        }
        return {
          success: false,
          error: manifestCtx.error || 'Failed to load presence.',
          missing: Boolean(manifestCtx.missing)
        };
      }
      const entry = getManifestNoteEntry(manifestCtx.manifest, noteId);
      if (!entry) return { success: false, error: 'Note not found or access denied.', missing: true };
      return {
        success: true,
        users: [{
          user_id: session.user.id,
          email: (session.user.email || '').toLowerCase(),
          last_seen: new Date().toISOString()
        }]
      };
    }

    const cutoff = new Date(Date.now() - 40000).toISOString();
    const { data, error: fetchError } = await client
      .from('note_presence')
      .select('user_id, user_email, last_seen')
      .eq('note_id', noteId)
      .gte('last_seen', cutoff)
      .order('last_seen', { ascending: false });
    if (fetchError) return { success: false, error: readableErrorMessage(fetchError.message, 'Failed to load presence.') };
    const users = (data || []).map((row) => ({
      user_id: row.user_id,
      email: row.user_email || '',
      last_seen: row.last_seen
    }));
    return { success: true, users };
  } catch (e) {
    return { success: false, error: readableErrorMessage(e && e.message, 'Failed to load presence.') };
  }
});

// --- SETTINGS & FILE OPS ---
ipcMain.handle('get-save-location', () => {
  try {
    const s = readSettings();
    return s && s.saveLocation ? s.saveLocation : DEFAULT_BASE;
  } catch (e) { return DEFAULT_BASE; }
});

ipcMain.handle('get-app-behavior-settings', () => {
  const settings = readAppBehaviorSettings();
  const actualOpenOnSystemStart = supportsOpenOnSystemStartSetting()
    ? readOpenOnSystemStartState()
    : settings.openOnSystemStart;
  const nextSettings = writeAppBehaviorSettings({ openOnSystemStart: actualOpenOnSystemStart }) || settings;
  return {
    success: true,
    settings: nextSettings,
    supportsOpenOnSystemStart: supportsOpenOnSystemStartSetting()
  };
});

ipcMain.handle('get-app-release-info', () => {
  const releaseInfo = readAppReleaseInfo();
  return {
    success: true,
    ...releaseInfo
  };
});

ipcMain.handle('set-app-behavior-settings', async (_event, payload = {}) => {
  const updates = (payload && typeof payload === 'object' && !Array.isArray(payload)) ? payload : {};
  try {
    const previous = readAppBehaviorSettings();
    const nextPartial = {};
    if (Object.prototype.hasOwnProperty.call(updates, 'closeAppOnWindowClose')) {
      nextPartial.closeAppOnWindowClose = Boolean(updates.closeAppOnWindowClose);
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'openOnSystemStart')) {
      nextPartial.openOnSystemStart = applyOpenOnSystemStartSetting(updates.openOnSystemStart);
    }
    const settings = writeAppBehaviorSettings(nextPartial);
    if (!settings) {
      return {
        success: false,
        error: 'Failed to save settings.',
        settings: previous,
        supportsOpenOnSystemStart: supportsOpenOnSystemStartSetting()
      };
    }
    return {
      success: true,
      settings,
      supportsOpenOnSystemStart: supportsOpenOnSystemStartSetting()
    };
  } catch (error) {
    return {
      success: false,
      error: error && error.message ? error.message : 'Failed to save settings.',
      settings: readAppBehaviorSettings(),
      supportsOpenOnSystemStart: supportsOpenOnSystemStartSetting()
    };
  }
});

ipcMain.handle('choose-save-location', async () => {
  try {
    const win = BrowserWindow.getFocusedWindow();
    const res = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    if (res.canceled || !res.filePaths || res.filePaths.length === 0) return { canceled: true };
    const chosen = res.filePaths[0];
    const settings = readSettings();
    settings.saveLocation = chosen;
    writeSettings(settings);
    refreshWindowsShellUi({ immediate: true });
    return { canceled: false, path: chosen };
  } catch (e) { return { canceled: true }; }
});

ipcMain.handle('open-import-files', async () => {
  try {
    const win = BrowserWindow.getFocusedWindow() || mainWindow || null;
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Importable Files', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'csv'] },
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] },
        { name: 'CSV Tables', extensions: ['csv'] }
      ]
    });
    if (result.canceled || !Array.isArray(result.filePaths) || result.filePaths.length === 0) {
      return { canceled: true, items: [] };
    }
    const items = [];
    for (const filePath of result.filePaths) {
      const safePath = String(filePath || '').trim();
      if (!safePath || !fs.existsSync(safePath)) continue;
      const mimeType = getImportMimeType(safePath);
      const ext = String(path.extname(safePath).toLowerCase());
      const fileName = path.basename(safePath);
      if (ext === '.csv') {
        const text = fs.readFileSync(safePath, 'utf8');
        items.push({
          kind: 'csv',
          name: fileName,
          text
        });
        continue;
      }
      if (mimeType.startsWith('image/')) {
        const buffer = fs.readFileSync(safePath);
        items.push({
          kind: 'image',
          name: fileName,
          mimeType,
          dataUrl: `data:${mimeType};base64,${buffer.toString('base64')}`
        });
      }
    }
    return { canceled: false, items };
  } catch (error) {
    return {
      canceled: true,
      items: [],
      error: error && error.message ? String(error.message) : 'Failed to open import dialog.'
    };
  }
});

ipcMain.handle('get-files', async (_, relativePath = '') => {
  try {
    const safeRel = normalizeRelativePath(relativePath);
    if (safeRel === TRASH_DIR_NAME || safeRel.startsWith(`${TRASH_DIR_NAME}/`)) return [];
    const target = resolveInsideBase(safeRel);
    if (!fs.existsSync(target)) return [];
    const items = fs
      .readdirSync(target, { withFileTypes: true })
      .filter(it => !(safeRel === '' && it.name === TRASH_DIR_NAME));
    return items.map(it => {
      const absPath = path.join(target, it.name);
      const stat = fs.statSync(absPath);
      let sizeBytes = 0;
      let childFolderCount = 0;
      let childFileCount = 0;
      if (it.isDirectory()) {
        try {
          const children = fs.readdirSync(absPath, { withFileTypes: true });
          childFolderCount = children.filter((child) => child && child.isDirectory && child.isDirectory()).length;
          childFileCount = children.filter((child) => child && child.isFile && child.isFile()).length;
        } catch (error) {}
      } else {
        sizeBytes = Number(stat.size) || 0;
      }
      return {
        name: it.name,
        isDirectory: it.isDirectory(),
        path: path.relative(getBaseDir(), absPath).replace(/\\/g, '/'),
        mtime: Number(stat.mtimeMs) || 0,
        sizeBytes,
        childFolderCount,
        childFileCount
      };
    });
  } catch (e) { return []; }
});

ipcMain.handle('create-folder', async (_, relativePath) => {
  try {
    if (!relativePath) return { success: false, error: 'No name provided' };
    const safeRel = relativePath.replace(/^[/\\]+/, '');
    const target = resolveInsideBase(safeRel);
    if (!fs.existsSync(target)) {
      fs.mkdirSync(target, { recursive: true });
      refreshWindowsShellUi();
      return { success: true, path: path.relative(getBaseDir(), target).replace(/\\/g, '/') };
    } else {
      return { success: false, error: 'Folder already exists', path: path.relative(getBaseDir(), target).replace(/\\/g, '/') };
    }
  } catch (e) { return { success: false, error: e.message || 'Unknown' }; }
});

ipcMain.handle('create-file', async (_, relativePath, content = '') => {
  try {
    if (!relativePath) return { success: false, error: 'No name provided' };
    let safeRel = relativePath.replace(/^[/\\]+/, '');
    if (!safeRel.toLowerCase().endsWith('.md')) safeRel = safeRel + '.md';
    const target = resolveInsideBase(safeRel);
    const dir = path.dirname(target);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(target, content || '', 'utf8');
    refreshWindowsShellUi();
    return { success: true, path: path.relative(getBaseDir(), target).replace(/\\/g, '/') };
  } catch (e) { return { success: false, error: e.message || 'Unknown' }; }
});

ipcMain.handle('read-note', async (_, relativePath) => {
  try {
    if (!relativePath) return '';
    const target = resolveInsideBase(relativePath);
    if (!fs.existsSync(target)) return '';
    return fs.readFileSync(target, 'utf8');
  } catch (e) { return ''; }
});

ipcMain.handle('get-note-stats', async (_, relativePath) => {
  try {
    if (!relativePath) return { success: false, error: 'Missing path.' };
    const target = resolveInsideBase(relativePath);
    if (!fs.existsSync(target)) return { success: false, error: 'Note not found.' };
    const stat = fs.statSync(target);
    return {
      success: true,
      createdAt: Number.isFinite(stat.birthtimeMs) ? stat.birthtimeMs : 0,
      modifiedAt: Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : 0
    };
  } catch (e) {
    return { success: false, error: e.message || 'Unknown error.' };
  }
});

ipcMain.handle('save-note', async (_, relativePath, content) => {
  try {
    if (!relativePath) return { success: false };
    const target = resolveInsideBase(relativePath);
    const dir = path.dirname(target);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(target, content || '', 'utf8');
    const stat = fs.statSync(target);
    refreshWindowsShellUi();
    return {
      success: true,
      createdAt: Number.isFinite(stat.birthtimeMs) ? stat.birthtimeMs : 0,
      modifiedAt: Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : 0
    };
  } catch (e) { return { success: false }; }
});

ipcMain.handle('rename-path', async (_, sourceRelativePath, nextName) => {
  try {
    const srcRel = normalizeRelativePath(sourceRelativePath);
    if (!srcRel) return { success: false, error: 'Source path is required.' };
    if (srcRel === TRASH_DIR_NAME || srcRel.startsWith(`${TRASH_DIR_NAME}/`)) {
      return { success: false, error: 'Cannot rename trash internals from sidebar.' };
    }

    const sourceAbs = resolveInsideBase(srcRel);
    if (!fs.existsSync(sourceAbs)) return { success: false, error: 'Item not found.' };
    const sourceStat = fs.statSync(sourceAbs);

    const rawName = String(nextName || '').trim();
    const safeName = rawName.replace(/[\\/]+/g, '').trim();
    if (!safeName || safeName === '.' || safeName === '..') {
      return { success: false, error: 'Name is required.' };
    }

    const parentRel = normalizeRelativePath(path.posix.dirname(srcRel)) || '';
    const targetRel = normalizeRelativePath(parentRel ? `${parentRel}/${safeName}` : safeName);
    if (!targetRel) return { success: false, error: 'Invalid destination path.' };
    if (targetRel === TRASH_DIR_NAME || targetRel.startsWith(`${TRASH_DIR_NAME}/`)) {
      return { success: false, error: 'Cannot rename item into trash.' };
    }
    if (targetRel === srcRel) {
      return { success: true, path: srcRel, oldPath: srcRel, unchanged: true, isDirectory: sourceStat.isDirectory() };
    }

    const targetAbs = resolveInsideBase(targetRel);
    if (fs.existsSync(targetAbs)) {
      return { success: false, error: 'A file or folder with that name already exists.' };
    }

    movePathWithFallback(sourceAbs, targetAbs);
    refreshWindowsShellUi();
    return {
      success: true,
      oldPath: srcRel,
      path: targetRel,
      name: safeName,
      isDirectory: sourceStat.isDirectory()
    };
  } catch (e) {
    return { success: false, error: e.message || 'Failed to rename item.' };
  }
});

ipcMain.handle('delete-path', async (_, relativePath) => {
  try {
    const safeRel = normalizeRelativePath(relativePath);
    if (!safeRel) return { success: false, error: 'Cannot delete root folder.' };
    if (safeRel === TRASH_DIR_NAME || safeRel.startsWith(`${TRASH_DIR_NAME}/`)) {
      return { success: false, error: 'Cannot delete trash internals from sidebar.' };
    }

    const target = resolveInsideBase(safeRel);
    if (!fs.existsSync(target)) return { success: false, error: 'Item not found.' };

    const stat = fs.statSync(target);
    const trashItemsDir = getTrashItemsDir();
    const id = `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const trashFileName = `${id}__${path.basename(target)}`;
    const trashTargetAbs = path.join(trashItemsDir, trashFileName);
    movePathWithFallback(target, trashTargetAbs);

    const nextMeta = readTrashMeta();
    nextMeta.unshift({
      id,
      name: path.basename(target),
      originalPath: safeRel,
      trashPath: path.relative(getTrashRootDir(), trashTargetAbs).replace(/\\/g, '/'),
      isDirectory: stat.isDirectory(),
      deletedAt: new Date().toISOString()
    });
    writeTrashMeta(nextMeta);
    refreshWindowsShellUi();

    return {
      success: true,
      path: safeRel,
      isDirectory: stat.isDirectory(),
      movedToTrash: true
    };
  } catch (e) {
    return { success: false, error: e.message || 'Failed to move item to bin.' };
  }
});

ipcMain.handle('move-path', async (_, sourceRelativePath, destinationFolderPath = '') => {
  try {
    const srcRel = normalizeRelativePath(sourceRelativePath);
    const destParentRel = normalizeRelativePath(destinationFolderPath);

    if (!srcRel) return { success: false, error: 'Source path is required.' };
    if (srcRel === TRASH_DIR_NAME || srcRel.startsWith(`${TRASH_DIR_NAME}/`)) {
      return { success: false, error: 'Cannot move trash internals from sidebar.' };
    }
    if (destParentRel === TRASH_DIR_NAME || destParentRel.startsWith(`${TRASH_DIR_NAME}/`)) {
      return { success: false, error: 'Cannot move items into trash directly.' };
    }

    const sourceAbs = resolveInsideBase(srcRel);
    if (!fs.existsSync(sourceAbs)) return { success: false, error: 'Item not found.' };
    const sourceStat = fs.statSync(sourceAbs);

    const destinationParentAbs = resolveInsideBase(destParentRel);
    if (!fs.existsSync(destinationParentAbs)) return { success: false, error: 'Destination folder not found.' };
    if (!fs.statSync(destinationParentAbs).isDirectory()) return { success: false, error: 'Destination must be a folder.' };

    const destinationAbs = path.join(destinationParentAbs, path.basename(sourceAbs));
    const sourceResolved = path.resolve(sourceAbs);
    const destinationResolved = path.resolve(destinationAbs);

    if (sourceResolved === destinationResolved) {
      return { success: true, path: srcRel, isDirectory: sourceStat.isDirectory(), unchanged: true };
    }

    if (sourceStat.isDirectory() && destinationResolved.startsWith(sourceResolved + path.sep)) {
      return { success: false, error: 'Cannot move a folder inside itself.' };
    }

    if (fs.existsSync(destinationResolved)) {
      return { success: false, error: 'A file or folder with that name already exists in destination.' };
    }

    movePathWithFallback(sourceResolved, destinationResolved);
    refreshWindowsShellUi();

    return {
      success: true,
      oldPath: srcRel,
      path: path.relative(getBaseDir(), destinationResolved).replace(/\\/g, '/'),
      isDirectory: sourceStat.isDirectory()
    };
  } catch (e) {
    return { success: false, error: e.message || 'Failed to move item.' };
  }
});

ipcMain.handle('get-trash-items', async () => {
  try {
    const meta = readTrashMeta();
    const liveMeta = [];
    const items = [];

    for (const entry of meta) {
      const trashPath = normalizeRelativePath(entry && entry.trashPath);
      if (!trashPath) continue;
      let absPath;
      try {
        absPath = resolveInsideTrash(trashPath);
      } catch (e) {
        continue;
      }
      if (!fs.existsSync(absPath)) continue;

      const tree = buildTrashTreeNode(absPath, entry.deletedAt || null);
      tree.id = entry.id || trashPath;
      tree.originalPath = typeof entry.originalPath === 'string' ? entry.originalPath : '';
      tree.deletedAt = entry.deletedAt || null;
      tree.name = typeof entry.name === 'string' && entry.name ? entry.name : tree.name;
      items.push(tree);
      liveMeta.push({
        ...entry,
        trashPath
      });
    }

    if (liveMeta.length !== meta.length) writeTrashMeta(liveMeta);

    items.sort((a, b) => {
      const da = Date.parse(a.deletedAt || 0);
      const db = Date.parse(b.deletedAt || 0);
      return (Number.isFinite(db) ? db : 0) - (Number.isFinite(da) ? da : 0);
    });

    return { success: true, items };
  } catch (e) {
    return { success: false, error: e.message || 'Failed to load bin.' };
  }
});

ipcMain.handle('delete-trash-items', async (_, trashPaths = []) => {
  try {
    if (!Array.isArray(trashPaths) || trashPaths.length === 0) {
      return { success: false, error: 'No items selected.' };
    }

    const normalized = Array.from(
      new Set(
        trashPaths
          .map(p => normalizeRelativePath(p))
          .filter(Boolean)
      )
    )
      .filter(p => p !== TRASH_META_FILE_NAME)
      .sort((a, b) => a.length - b.length);

    if (normalized.length === 0) return { success: false, error: 'No valid items selected.' };

    const effective = [];
    normalized.forEach((candidate) => {
      const covered = effective.some(parent => candidate === parent || candidate.startsWith(`${parent}/`));
      if (!covered) effective.push(candidate);
    });

    let deletedCount = 0;
    for (const relPath of effective) {
      const absPath = resolveInsideTrash(relPath);
      if (!fs.existsSync(absPath)) continue;
      const stat = fs.statSync(absPath);
      if (stat.isDirectory()) fs.rmSync(absPath, { recursive: true, force: false });
      else fs.unlinkSync(absPath);
      deletedCount += 1;
    }

    const oldMeta = readTrashMeta();
    const nextMeta = oldMeta.filter((entry) => {
      const entryPath = normalizeRelativePath(entry && entry.trashPath);
      if (!entryPath) return false;
      const removedBySelection = effective.some(sel => entryPath === sel || entryPath.startsWith(`${sel}/`));
      if (removedBySelection) return false;
      try {
        return fs.existsSync(resolveInsideTrash(entryPath));
      } catch (e) {
        return false;
      }
    });
    writeTrashMeta(nextMeta);
    refreshWindowsShellUi();

    return { success: true, deletedCount };
  } catch (e) {
    return { success: false, error: e.message || 'Failed to permanently delete selected items.' };
  }
});

ipcMain.handle('restore-trash-items', async (_, trashPaths = []) => {
  try {
    if (!Array.isArray(trashPaths) || trashPaths.length === 0) {
      return { success: false, error: 'No items selected.' };
    }

    const normalized = Array.from(
      new Set(
        trashPaths
          .map(p => normalizeRelativePath(p))
          .filter(Boolean)
      )
    )
      .filter(p => p !== TRASH_META_FILE_NAME)
      .sort((a, b) => a.length - b.length);

    if (normalized.length === 0) return { success: false, error: 'No valid items selected.' };

    const effective = [];
    normalized.forEach((candidate) => {
      const covered = effective.some(parent => candidate === parent || candidate.startsWith(`${parent}/`));
      if (!covered) effective.push(candidate);
    });

    const metaEntries = readTrashMeta()
      .map((entry) => ({
        ...entry,
        normalizedTrashPath: normalizeRelativePath(entry && entry.trashPath),
        normalizedOriginalPath: normalizeRelativePath(entry && entry.originalPath)
      }))
      .filter(entry => entry.normalizedTrashPath && entry.normalizedOriginalPath);

    function findMetaOwner(trashPath) {
      let bestMatch = null;
      for (const entry of metaEntries) {
        const ownerPath = entry.normalizedTrashPath;
        if (trashPath === ownerPath || trashPath.startsWith(`${ownerPath}/`)) {
          if (!bestMatch || ownerPath.length > bestMatch.normalizedTrashPath.length) {
            bestMatch = entry;
          }
        }
      }
      return bestMatch;
    }

    const restoredItems = [];
    const conflicts = [];
    const unresolved = [];

    for (const relPath of effective) {
      const owner = findMetaOwner(relPath);
      if (!owner) {
        unresolved.push({ trashPath: relPath, reason: 'Missing original location metadata.' });
        continue;
      }

      let sourceAbs;
      try {
        sourceAbs = resolveInsideTrash(relPath);
      } catch (e) {
        unresolved.push({ trashPath: relPath, reason: 'Invalid trash path.' });
        continue;
      }
      if (!fs.existsSync(sourceAbs)) continue;

      const suffix = relPath === owner.normalizedTrashPath
        ? ''
        : relPath.slice(owner.normalizedTrashPath.length + 1);

      const restoreTargetRel = normalizeRelativePath(
        suffix
          ? path.posix.join(owner.normalizedOriginalPath, suffix)
          : owner.normalizedOriginalPath
      );

      if (
        !restoreTargetRel ||
        restoreTargetRel === TRASH_DIR_NAME ||
        restoreTargetRel.startsWith(`${TRASH_DIR_NAME}/`)
      ) {
        unresolved.push({ trashPath: relPath, reason: 'Invalid restore target.' });
        continue;
      }

      const targetAbs = resolveInsideBase(restoreTargetRel);
      const targetParent = path.dirname(targetAbs);
      if (!fs.existsSync(targetParent)) fs.mkdirSync(targetParent, { recursive: true });
      if (fs.existsSync(targetAbs)) {
        conflicts.push({ trashPath: relPath, path: restoreTargetRel });
        continue;
      }

      movePathWithFallback(sourceAbs, targetAbs);
      restoredItems.push({
        trashPath: relPath,
        path: restoreTargetRel,
        name: path.basename(restoreTargetRel)
      });
    }

    const oldMeta = readTrashMeta();
    const nextMeta = oldMeta.filter((entry) => {
      const entryPath = normalizeRelativePath(entry && entry.trashPath);
      if (!entryPath) return false;
      try {
        return fs.existsSync(resolveInsideTrash(entryPath));
      } catch (e) {
        return false;
      }
    });
    writeTrashMeta(nextMeta);

    const restoredCount = restoredItems.length;
    if (restoredCount === 0) {
      const skippedCount = conflicts.length + unresolved.length;
      return {
        success: false,
        error: skippedCount > 0
          ? 'Selected items could not be restored. They may already exist at the original location.'
          : 'No selected items could be restored.',
        restoredCount,
        restoredItems,
        conflicts,
        unresolved
      };
    }

    refreshWindowsShellUi();
    return {
      success: true,
      restoredCount,
      restoredItems,
      conflicts,
      unresolved
    };
  } catch (e) {
    return { success: false, error: e.message || 'Failed to restore selected items.' };
  }
});

function normalizePinnedStateEntries(rawEntries) {
  const list = Array.isArray(rawEntries) ? rawEntries : [];
  const seen = new Set();
  const normalized = [];
  list.forEach((entry) => {
    const source = (entry && typeof entry === 'object')
      ? entry
      : { path: entry };
    const safePath = normalizeRelativePath(source.path);
    if (!safePath || seen.has(safePath)) return;
    seen.add(safePath);
    normalized.push({
      path: safePath,
      isDirectory: Boolean(source.isDirectory),
      pinnedAt: Number.isFinite(Number(source.pinnedAt)) ? Number(source.pinnedAt) : 0
    });
  });
  return normalized;
}

function normalizeStorageSectionCollapsedState(rawState) {
  const source = (rawState && typeof rawState === 'object' && !Array.isArray(rawState)) ? rawState : {};
  return {
    pinned: Object.prototype.hasOwnProperty.call(source, 'pinned') ? Boolean(source.pinned) : true,
    folders: Boolean(source.folders),
    files: Boolean(source.files)
  };
}

function normalizeRecentNotePaths(rawPaths, limit = JUMP_LIST_RECENT_LIMIT) {
  const list = Array.isArray(rawPaths) ? rawPaths : [];
  const safeLimit = Math.max(1, Number(limit) || JUMP_LIST_RECENT_LIMIT);
  const notes = [];
  const seen = new Set();
  list.forEach((entry) => {
    const safePath = normalizeRelativePath(entry);
    if (!safePath || seen.has(safePath)) return;
    if (!safePath.toLowerCase().endsWith('.md')) return;
    if (safePath === TRASH_DIR_NAME || safePath.startsWith(`${TRASH_DIR_NAME}/`)) return;
    seen.add(safePath);
    notes.push(safePath);
  });
  return notes.slice(0, safeLimit);
}

function getRecentNoteEntriesFromAppState(state, limit = JUMP_LIST_RECENT_LIMIT) {
  const notes = [];
  const recentPaths = normalizeRecentNotePaths(state && state.recentNotePaths, limit);
  recentPaths.forEach((safePath) => {
    let absPath = '';
    try {
      absPath = resolveInsideBase(safePath);
    } catch (error) {
      return;
    }
    if (!fs.existsSync(absPath)) return;
    let stat = null;
    try {
      stat = fs.statSync(absPath);
    } catch (error) {
      return;
    }
    if (!stat.isFile()) return;
    notes.push({
      path: safePath,
      title: getJumpEntryDisplayTitle(safePath, false),
      isDirectory: false,
      modifiedAt: Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : 0
    });
  });
  notes.sort((left, right) => {
    const byModified = (Number(right.modifiedAt) || 0) - (Number(left.modifiedAt) || 0);
    if (byModified !== 0) return byModified;
    return String(left.title || left.path || "").localeCompare(String(right.title || right.path || ""));
  });
  return notes.slice(0, Math.max(1, Number(limit) || JUMP_LIST_RECENT_LIMIT));
}

function collectRecentWorkspaceFolders(limit = JUMP_LIST_RECENT_LIMIT) {
  const safeLimit = Math.max(1, Number(limit) || JUMP_LIST_RECENT_LIMIT);
  const folders = [];
  const stack = [''];

  while (stack.length > 0) {
    const relDir = stack.pop();
    let absDir = '';
    try {
      absDir = resolveInsideBase(relDir);
    } catch (error) {
      continue;
    }

    let entries = [];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch (error) {
      continue;
    }

    entries.forEach((entry) => {
      if (!entry || !entry.name) return;
      const nextRel = normalizeRelativePath(relDir ? `${relDir}/${entry.name}` : entry.name);
      if (!nextRel) return;
      if (nextRel === TRASH_DIR_NAME || nextRel.startsWith(`${TRASH_DIR_NAME}/`)) return;
      const absPath = path.join(absDir, entry.name);
      let stat = null;
      try {
        stat = fs.statSync(absPath);
      } catch (error) {
        return;
      }
      const mtime = Number(stat.mtimeMs) || 0;
      if (stat.isDirectory()) {
        folders.push({
          path: nextRel,
          title: getJumpEntryDisplayTitle(nextRel, true),
          mtime,
          isDirectory: true
        });
        stack.push(nextRel);
        return;
      }
      if (stat.isFile()) {
        notes.push({
          path: nextRel,
          title: getJumpEntryDisplayTitle(nextRel, false),
          mtime,
          isDirectory: false
        });
      }
    });
  }

  folders.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));
  return folders.slice(0, safeLimit);
}

function buildJumpListTask(entry) {
  if (!entry || !entry.path) return null;
  const safePath = normalizeRelativePath(entry.path);
  if (!safePath) return null;
  const isDirectory = Boolean(entry.isDirectory);
  const argPrefix = isDirectory ? JUMP_OPEN_FOLDER_ARG_PREFIX : JUMP_OPEN_NOTE_ARG_PREFIX;
  const iconPath = getAppIconPath();
  return {
    type: 'task',
    title: String(entry.title || getJumpEntryDisplayTitle(safePath, isDirectory) || 'Open'),
    description: safePath,
    program: process.execPath,
    args: buildLaunchArgs(`${argPrefix}${encodeURIComponent(safePath)}`),
    iconPath,
    iconIndex: 0
  };
}

function refreshWindowsJumpListNow() {
  if (process.platform !== 'win32') return;
  try {
    const state = readAppState();
    const pinnedState = normalizePinnedStateEntries(state && state.storagePinnedItems);
    const pinned = [];
    pinnedState.forEach((entry) => {
      const safePath = normalizeRelativePath(entry.path);
      if (!safePath) return;
      let absPath = '';
      try {
        absPath = resolveInsideBase(safePath);
      } catch (error) {
        return;
      }
      if (!fs.existsSync(absPath)) return;
      let stat = null;
      try {
        stat = fs.statSync(absPath);
      } catch (error) {
        return;
      }
      pinned.push({
        path: safePath,
        title: getJumpEntryDisplayTitle(safePath, stat.isDirectory()),
        isDirectory: stat.isDirectory()
      });
    });

    const recentNotes = getRecentNoteEntriesFromAppState(state, JUMP_LIST_RECENT_LIMIT);
    const recentFolders = collectRecentWorkspaceFolders(JUMP_LIST_RECENT_LIMIT);
    const pinnedItems = pinned.map(buildJumpListTask).filter(Boolean);
    const recentNoteItems = recentNotes.map(buildJumpListTask).filter(Boolean);
    const recentFolderItems = recentFolders.map(buildJumpListTask).filter(Boolean);

    const jumpList = [];
    if (pinnedItems.length) {
      jumpList.push({
        type: 'custom',
        name: 'Pinned',
        items: pinnedItems
      });
    }
    if (recentNoteItems.length) {
      jumpList.push({
        type: 'custom',
        name: 'Recent Notes',
        items: recentNoteItems
      });
    }
    if (recentFolderItems.length) {
      jumpList.push({
        type: 'custom',
        name: 'Recent Folders',
        items: recentFolderItems
      });
    }
    jumpList.push({
      type: 'tasks',
      items: [{
        type: 'task',
        title: 'Open Noto',
        description: 'Open the workspace',
        program: process.execPath,
        args: buildLaunchArgs(''),
        iconPath: getAppIconPath(),
        iconIndex: 0
      }]
    });
    app.setJumpList(jumpList);
  } catch (error) {
    console.error('Failed to refresh Windows jump list:', error);
  }
}

function createWindowsTrayIconImage() {
  const iconPath = getAppIconPath();
  const iconImage = nativeImage.createFromPath(iconPath);
  if (!iconImage || iconImage.isEmpty()) return iconPath;
  return iconImage.resize({ width: 16, height: 16 });
}

function canUseWindowsTrayPersistence() {
  return process.platform === 'win32' && Boolean(trayIcon);
}

function showMainWindow() {
  if ((!mainWindow || mainWindow.isDestroyed()) && app.isReady()) {
    createWindow();
  }
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  try {
    mainWindow.setSkipTaskbar(false);
  } catch (error) {}
  mainWindow.show();
  mainWindow.focus();
}

function hideMainWindowToTray() {
  if (!canUseWindowsTrayPersistence() || !mainWindow || mainWindow.isDestroyed()) return false;
  try {
    mainWindow.setSkipTaskbar(true);
  } catch (error) {}
  mainWindow.hide();
  return true;
}

function flushPendingRendererLaunchSignals() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const pageUrl = String(mainWindow.webContents && mainWindow.webContents.getURL ? mainWindow.webContents.getURL() : '').toLowerCase();
  const isAppPage = pageUrl.includes('index.html');
  const isLoading = Boolean(mainWindow.webContents && mainWindow.webContents.isLoadingMainFrame && mainWindow.webContents.isLoadingMainFrame());
  if (!isAppPage || isLoading) return;

  if (pendingJumpOpenRequest) {
    try {
      mainWindow.webContents.send('jump-open', pendingJumpOpenRequest);
      pendingJumpOpenRequest = null;
    } catch (error) {}
  }
  if (pendingTrayCreateNoteRequest) {
    try {
      mainWindow.webContents.send('tray-create-note');
      pendingTrayCreateNoteRequest = false;
    } catch (error) {}
  }
}

function queueTrayCreateNoteRequest() {
  pendingTrayCreateNoteRequest = true;
  showMainWindow();
  flushPendingRendererLaunchSignals();
}

function requestMainWindowQuit() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    app.quit();
    return;
  }
  isExplicitQuitRequested = true;
  showMainWindow();

  const pageUrl = String(mainWindow.webContents && mainWindow.webContents.getURL ? mainWindow.webContents.getURL() : '').toLowerCase();
  const isAppPage = pageUrl.includes('index.html');
  const isLoading = Boolean(mainWindow.webContents && mainWindow.webContents.isLoadingMainFrame && mainWindow.webContents.isLoadingMainFrame());
  if (!isAppPage || isLoading) {
    mainWindow.__allowGuardedClose = true;
    mainWindow.close();
    return;
  }
  if (quitGuardRequestInFlight) return;
  quitGuardRequestInFlight = true;
  try {
    mainWindow.webContents.send('app-close-requested');
  } catch (error) {
    quitGuardRequestInFlight = false;
    mainWindow.__allowGuardedClose = true;
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
    }, 0);
  }
}

function rebuildTrayMenu() {
  if (process.platform !== 'win32' || !trayIcon) return;
  const state = readAppState();
  const recentNotes = getRecentNoteEntriesFromAppState(state, JUMP_LIST_RECENT_LIMIT);
  const recentSection = recentNotes.length
    ? recentNotes.map((entry) => ({
        label: String(entry.title || getJumpEntryDisplayTitle(entry.path, false) || 'Recent note'),
        click: () => dispatchJumpOpenRequest({ kind: 'note', path: entry.path })
      }))
    : [{
        label: 'No recent notes',
        enabled: false
      }];
  const menuTemplate = [
    {
      label: 'Recent notes',
      enabled: false
    },
    ...recentSection,
    {
      type: 'separator'
    },
    {
      label: 'New note',
      click: () => queueTrayCreateNoteRequest()
    },
    {
      label: 'Open',
      click: () => showMainWindow()
    },
    {
      label: 'Quit',
      click: () => requestMainWindowQuit()
    }
  ];
  trayIcon.setContextMenu(Menu.buildFromTemplate(menuTemplate));
}

function createWindowsTrayIfNeeded() {
  if (process.platform !== 'win32' || trayIcon) return;
  trayIcon = new Tray(createWindowsTrayIconImage());
  trayIcon.setToolTip('Noto');
  trayIcon.on('click', () => showMainWindow());
  trayIcon.on('double-click', () => showMainWindow());
  rebuildTrayMenu();
}

function scheduleWindowsJumpListRefresh(options = {}) {
  if (process.platform !== 'win32') return;
  const immediate = Boolean(options && options.immediate);
  const delayMs = immediate ? 0 : Math.max(100, Number(options && options.delayMs) || 800);
  if (jumpListRefreshTimer) clearTimeout(jumpListRefreshTimer);
  jumpListRefreshTimer = setTimeout(() => {
    jumpListRefreshTimer = null;
    refreshWindowsJumpListNow();
  }, delayMs);
}

function refreshWindowsShellUi(options = {}) {
  if (process.platform !== 'win32') return;
  rebuildTrayMenu();
  scheduleWindowsJumpListRefresh(options);
}

function dispatchJumpOpenRequest(request) {
  if (!request || typeof request !== 'object') return;
  const kind = request.kind === 'folder' ? 'folder' : 'note';
  const safePath = normalizeRelativePath(request.path);
  if (!safePath) return;

  pendingJumpOpenRequest = { kind, path: safePath };
  showMainWindow();
  flushPendingRendererLaunchSignals();
}

function buildImportedRootNoteRelativePath(sourceFilePath = '') {
  const sourceBaseName = String(path.basename(String(sourceFilePath || ''), path.extname(String(sourceFilePath || ''))) || '')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const baseName = sourceBaseName || 'Imported note';
  let candidateName = `${baseName}.md`;
  let counter = 1;
  while (true) {
    const candidateRel = normalizeRelativePath(candidateName);
    if (!candidateRel) {
      candidateName = `Imported note-${counter}.md`;
      counter += 1;
      continue;
    }
    let candidateAbs = '';
    try {
      candidateAbs = resolveInsideBase(candidateRel);
    } catch (error) {
      candidateName = `${baseName}-${counter}.md`;
      counter += 1;
      continue;
    }
    if (!fs.existsSync(candidateAbs)) return candidateRel;
    candidateName = `${baseName}-${counter}.md`;
    counter += 1;
  }
}

function showExternalImportError(message) {
  dialog.showErrorBox('Open with Noto', String(message || 'Failed to import that file into Noto.'));
}

function importExternalFileToRootNote(sourceFilePath = '') {
  const sourceAbs = path.resolve(String(sourceFilePath || '').trim());
  if (!sourceAbs || !fs.existsSync(sourceAbs)) {
    throw new Error('That file could not be found.');
  }
  if (!supportsExternalNoteImport(sourceAbs)) {
    throw new Error('Noto can only import Markdown or text files (.md, .markdown, .txt).');
  }
  const content = fs.readFileSync(sourceAbs, 'utf8');
  const targetRel = buildImportedRootNoteRelativePath(sourceAbs);
  const targetAbs = resolveInsideBase(targetRel);
  const targetDir = path.dirname(targetAbs);
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(targetAbs, content, 'utf8');
  refreshWindowsShellUi();
  return targetRel;
}

function handleExternalFileLaunchRequest(request) {
  const sourceAbs = String(request && request.path ? request.path : '').trim();
  if (!sourceAbs) return;
  if (!fs.existsSync(sourceAbs)) {
    showExternalImportError('That file could not be found.');
    return;
  }
  if (!supportsExternalNoteImport(sourceAbs)) {
    showExternalImportError('Noto can only import Markdown or text files (.md, .markdown, .txt).');
    return;
  }

  const resolvedSource = path.resolve(sourceAbs);
  const sourceExt = String(path.extname(resolvedSource).toLowerCase());
  const baseDir = getBaseDir();
  if (sourceExt === '.md' && isPathInside(baseDir, resolvedSource)) {
    const relPath = normalizeRelativePath(path.relative(baseDir, resolvedSource));
    if (relPath && relPath !== TRASH_DIR_NAME && !relPath.startsWith(`${TRASH_DIR_NAME}/`)) {
      dispatchJumpOpenRequest({ kind: 'note', path: relPath });
      return;
    }
  }

  try {
    const importedRel = importExternalFileToRootNote(resolvedSource);
    dispatchJumpOpenRequest({ kind: 'note', path: importedRel });
  } catch (error) {
    showExternalImportError(error && error.message ? error.message : 'Failed to import that file into Noto.');
  }
}

function dispatchLaunchRequest(request) {
  if (!request || typeof request !== 'object') return;
  if (request.kind === 'external-file') {
    handleExternalFileLaunchRequest(request);
    return;
  }
  dispatchJumpOpenRequest(request);
}

const APP_STATE_FILE = path.join(app.getPath('userData'), 'app-state.json');
const DEFAULT_APP_STATE = {
  currentFolder: '',
  folderStates: {},
  expandedPaths: [],
  sidebarWidth: 250,
  sidebarCollapsed: false,
  sortMode: 'name-asc',
  folderSortMode: 'name-asc',
  fileSortMode: 'name-asc',
  sidebarSectionCollapsed: { folders: false, files: false },
  storageSectionCollapsed: { pinned: true, folders: false, files: false },
  storagePinnedItems: [],
  recentNotePaths: []
};

function readAppState() {
  try {
    if (fs.existsSync(APP_STATE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(APP_STATE_FILE, 'utf8') || '{}');
      return {
        ...DEFAULT_APP_STATE,
        ...raw,
        folderStates: (raw && typeof raw.folderStates === 'object' && !Array.isArray(raw.folderStates)) ? raw.folderStates : {},
        expandedPaths: Array.isArray(raw?.expandedPaths) ? raw.expandedPaths : [],
        storageSectionCollapsed: normalizeStorageSectionCollapsedState(raw && raw.storageSectionCollapsed),
        storagePinnedItems: normalizePinnedStateEntries(raw && raw.storagePinnedItems),
        recentNotePaths: normalizeRecentNotePaths(raw && raw.recentNotePaths)
      };
    }
  } catch (e) {}
  return { ...DEFAULT_APP_STATE };
}

function notifyMainWindowPresentationState(isOpen) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('presentation-state-changed', { isOpen: Boolean(isOpen) });
  }
}

function writeAppState(obj) {
  try { fs.writeFileSync(APP_STATE_FILE, JSON.stringify(obj, null, 2), 'utf8'); return true; } catch (e) { return false; }
}

ipcMain.handle('save-app-state', async (_, state) => {
  try {
    const existing = readAppState();
    const incoming = (state && typeof state === 'object') ? state : {};
    const mergedFolderStates = { ...(existing.folderStates || {}) };
    if (incoming.folderStates && typeof incoming.folderStates === 'object' && !Array.isArray(incoming.folderStates)) {
      Object.entries(incoming.folderStates).forEach(([key, val]) => {
        mergedFolderStates[key] = val;
      });
    }

    const merged = {
      ...existing,
      ...incoming,
      currentFolder: typeof incoming.currentFolder === 'string' ? incoming.currentFolder : existing.currentFolder,
      folderStates: mergedFolderStates,
      expandedPaths: Array.isArray(incoming.expandedPaths) ? incoming.expandedPaths : existing.expandedPaths,
      sidebarWidth: typeof incoming.sidebarWidth === 'number' ? incoming.sidebarWidth : existing.sidebarWidth,
      sidebarCollapsed: typeof incoming.sidebarCollapsed === 'boolean' ? incoming.sidebarCollapsed : existing.sidebarCollapsed,
      sortMode: typeof incoming.sortMode === 'string' ? incoming.sortMode : existing.sortMode,
      storageSectionCollapsed: incoming && typeof incoming.storageSectionCollapsed === 'object' && !Array.isArray(incoming.storageSectionCollapsed)
        ? normalizeStorageSectionCollapsedState(incoming.storageSectionCollapsed)
        : normalizeStorageSectionCollapsedState(existing.storageSectionCollapsed),
      storagePinnedItems: Array.isArray(incoming.storagePinnedItems)
        ? normalizePinnedStateEntries(incoming.storagePinnedItems)
        : normalizePinnedStateEntries(existing.storagePinnedItems),
      recentNotePaths: Array.isArray(incoming.recentNotePaths)
        ? normalizeRecentNotePaths(incoming.recentNotePaths)
        : normalizeRecentNotePaths(existing.recentNotePaths)
    };

    writeAppState(merged);
    refreshWindowsShellUi();
    return { success: true };
  } catch (e) { return { success: false }; }
});

ipcMain.handle('load-app-state', async () => {
  try { return readAppState(); } catch (e) { return { ...DEFAULT_APP_STATE }; }
});

ipcMain.handle('consume-pending-jump-open', async () => {
  const payload = pendingJumpOpenRequest && typeof pendingJumpOpenRequest === 'object'
    ? { ...pendingJumpOpenRequest }
    : null;
  pendingJumpOpenRequest = null;
  return payload;
});

ipcMain.handle('consume-pending-tray-create-note', async () => {
  const shouldCreate = Boolean(pendingTrayCreateNoteRequest);
  pendingTrayCreateNoteRequest = false;
  return { pending: shouldCreate };
});

ipcMain.handle('open-external', async (_, url) => {
  try {
    if (!url || typeof url !== 'string' || !/^(https?:\/\/|mailto:)/.test(url)) return { success: false };
    await shell.openExternal(url);
    return { success: true };
  } catch (e) { return { success: false }; }
});

// --- PRESENTATION MODE LOGIC ---

ipcMain.handle('get-displays', () => {
  return screen.getAllDisplays().map((d, index) => ({
    id: d.id,
    label: d.label || `Display ${index + 1}`,
    bounds: d.bounds
  }));
});

ipcMain.handle('open-presentation', async (_, { displayId, content }) => {
  // Close existing presentation if open
  if (presentationWin) {
    presentationWin.close();
    presentationWin = null;
  }

  const displays = screen.getAllDisplays();
  const targetDisplay = displays.find(d => d.id === displayId) || displays[0];
  cachedPresentationContent = content; // Store content to send when ready
  cachedPresentationFrozen = false;

  presentationWin = new BrowserWindow({
    x: targetDisplay.bounds.x,
    y: targetDisplay.bounds.y,
    width: targetDisplay.bounds.width,
    height: targetDisplay.bounds.height,
    fullscreen: true,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      devTools: false
    }
  });

  const indexPath = path.join(__dirname, 'src', 'index.html');
  const loadPath = fs.existsSync(indexPath) ? indexPath : path.join(__dirname, 'index.html');
  
  await presentationWin.loadURL(`file://${loadPath}?mode=presentation`);
  notifyMainWindowPresentationState(true);
  
  presentationWin.on('closed', () => {
    presentationWin = null;
    cachedPresentationFrozen = false;
    notifyMainWindowPresentationState(false);
  });
});

ipcMain.on('close-presentation', () => {
  if (presentationWin && !presentationWin.isDestroyed()) {
    presentationWin.close();
  } else {
    cachedPresentationFrozen = false;
    notifyMainWindowPresentationState(false);
  }
});

ipcMain.handle('close-presentation', async () => {
  if (presentationWin && !presentationWin.isDestroyed()) {
    presentationWin.close();
    return { success: true };
  }
  cachedPresentationFrozen = false;
  notifyMainWindowPresentationState(false);
  return { success: true };
});

// Signal from Presentation Window saying "I have loaded HTML, send me content"
ipcMain.on('presentation-ready', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    if (typeof cachedPresentationContent === 'string') {
      win.webContents.send('set-presentation-content', cachedPresentationContent);
    }
    win.webContents.send('set-presentation-scroll', cachedPresentationScroll);
    win.webContents.send('set-presentation-frozen', { frozen: cachedPresentationFrozen });
  }
});

// Real-time update from Main Window -> Presentation Window
ipcMain.on('update-presentation', (event, content) => {
  cachedPresentationContent = content; // Update cache
  if (presentationWin) {
    presentationWin.webContents.send('set-presentation-content', content);
  }
});

ipcMain.on('update-presentation-scroll', (event, payload) => {
  const ratioRaw = payload && typeof payload.ratio === 'number' ? payload.ratio : 0;
  const ratio = Math.max(0, Math.min(1, ratioRaw));
  cachedPresentationScroll = { ratio };
  if (presentationWin) {
    presentationWin.webContents.send('set-presentation-scroll', cachedPresentationScroll);
  }
});

ipcMain.on('set-presentation-frozen', (_event, payload) => {
  cachedPresentationFrozen = Boolean(payload && payload.frozen);
  if (presentationWin) {
    presentationWin.webContents.send('set-presentation-frozen', { frozen: cachedPresentationFrozen });
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

