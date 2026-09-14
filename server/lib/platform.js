/* What differs between Linux, macOS and Windows for the programs this app starts.

   The app runs on the learner's own computer, whichever that is, and starts a few
   programs by name: poppler for PDFs, LibreOffice for office files, Claude Code for a
   Claude plan, the browser. Three things change from one system to the next, and they
   live here so no other module guesses:
     - the environment a program needs to start, and nothing else from this process,
       so a key in the app's own environment never reaches a child
     - where installers put programs that PATH often misses (Homebrew on Apple silicon,
       the LibreOffice app bundle, Program Files, ~/.local/bin)
     - how to open a web page */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const IS_WINDOWS = process.platform === 'win32';
export const IS_MAC = process.platform === 'darwin';

/* A Windows program cannot even load without SystemRoot, and keeps its settings under
   the user profile; macOS gives every user their own TMPDIR. */
const POSIX_VARS = ['HOME', 'USER', 'LOGNAME', 'LANG', 'PATH', 'TMPDIR'];
const WINDOWS_VARS = ['PATH', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'windir', 'TEMP', 'TMP',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'USERNAME', 'HOME'];

export function minimalEnv(extra = {}) {
  const env = {};
  for (const name of IS_WINDOWS ? WINDOWS_VARS : POSIX_VARS) {
    // process.env ignores case on Windows, so PATH also finds "Path".
    if (process.env[name]) env[name] = process.env[name];
  }
  if (IS_WINDOWS) {
    env.USERPROFILE ||= os.homedir();
  } else {
    env.HOME ||= os.homedir();
    env.PATH ||= '/usr/local/bin:/usr/bin:/bin';
  }
  return { ...env, ...extra };
}

function runnable(file) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (IS_WINDOWS) return true;             // Windows has no execute bit to check
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/* A program's full path, or '' when it is not there.
     envVar    a variable that, when set, is the only place looked at: a wrong setting
               is reported as missing, not quietly replaced by another copy
     only      folders that, when given, are the only ones searched
     prefer    folders searched before PATH
     fallback  folders searched after PATH
   On Windows the name gets `.exe`: a .cmd or .bat cannot be started without a shell,
   and nothing in this app uses one. */
export function findProgram(name, { envVar = '', only = null, prefer = [], fallback = [] } = {}) {
  const forced = envVar ? String(process.env[envVar] || '').trim() : '';
  if (forced) return runnable(forced) ? forced : '';
  const file = IS_WINDOWS && !path.extname(name) ? `${name}.exe` : name;
  const pathDirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const dirs = only ? only.filter(Boolean) : [...prefer, ...pathDirs, ...fallback];
  for (const dir of dirs) {
    const candidate = path.join(dir, file);
    if (runnable(candidate)) return candidate;
  }
  return '';
}

/* One sentence on installing a missing tool, for the reasons the Notes screen shows. */
export function installHint(tool) {
  if (tool === 'poppler') {
    if (IS_MAC) return 'Install it with Homebrew: brew install poppler.';
    if (IS_WINDOWS) return 'Install it with Scoop (scoop install poppler) or Chocolatey (choco install poppler), or set MEMOLANG_POPPLER_PATH to the folder that holds pdftoppm.exe.';
    return 'Install the poppler-utils package, for example with: sudo apt install poppler-utils.';
  }
  if (tool === 'libreoffice') {
    if (IS_MAC) return 'Install LibreOffice from libreoffice.org, or with: brew install --cask libreoffice.';
    if (IS_WINDOWS) return 'Install LibreOffice from libreoffice.org, or with: winget install TheDocumentFoundation.LibreOffice.';
    return 'Install LibreOffice, for example with: sudo apt install libreoffice.';
  }
  return '';
}

/* Opens a page whose address this app built itself (never one a request supplied) in
   the default browser. When nothing opens, the address is printed in the terminal. */
export function openInBrowser(url) {
  const [command, args] = IS_WINDOWS ? ['explorer.exe', [url]] : IS_MAC ? ['open', [url]] : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => { /* no browser to open */ });
    child.unref();
  } catch { /* no browser to open */ }
}
