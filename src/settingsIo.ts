import * as fs from 'fs';
import * as path from 'path';
import * as jsonc from 'jsonc-parser';
import { CONFIG_DIR_VAR, SIDEBAR_ENV_PATH, TERMINAL_ENV_PATH, parseJsonc } from './accountReader';

/**
 * Writes to a project's `.vscode/settings.json`.
 *
 * Every edit is surgical: `jsonc-parser` splices the exact range, so comments,
 * key order, and unrelated settings survive. Re-serializing a parsed object
 * would silently destroy all three.
 */

export interface WriteResult {
  file: string;
  created: boolean;
}

/**
 * Resolve a dotted setting path to a concrete JSON path, following whichever
 * form the file already uses.
 *
 * `"terminal.integrated.env.osx"` as one flat key and a nested `terminal`
 * object are both valid, and a file may mix them. We follow the existing shape
 * so we never end up with the same setting written two different ways — which
 * VS Code would treat as two settings, one of them silently ignored.
 */
export function resolveWritePath(parsed: unknown, segments: string[]): jsonc.JSONPath {
  const out: jsonc.JSONPath = [];
  let node: unknown = parsed;
  let rest = [...segments];

  while (rest.length > 0 && node && typeof node === 'object' && !Array.isArray(node)) {
    const record = node as Record<string, unknown>;
    let matched = false;
    for (let i = rest.length; i > 0; i--) {
      const key = rest.slice(0, i).join('.');
      if (Object.prototype.hasOwnProperty.call(record, key)) {
        out.push(key);
        node = record[key];
        rest = rest.slice(i);
        matched = true;
        break;
      }
    }
    if (!matched) {
      break;
    }
  }

  // Nothing existing covers the remainder: write it as a single flattened key,
  // which is the conventional form in a VS Code settings file.
  if (rest.length > 0) {
    out.push(rest.join('.'));
  }
  return out;
}

function valueAt(parsed: unknown, jsonPath: jsonc.JSONPath): unknown {
  let node: unknown = parsed;
  for (const segment of jsonPath) {
    if (node === null || typeof node !== 'object') {
      return undefined;
    }
    node = (node as Record<string | number, unknown>)[segment as never];
  }
  return node;
}

/** Apply one modification and return the updated text. */
function apply(
  text: string,
  jsonPath: jsonc.JSONPath,
  value: unknown,
  formatting: jsonc.FormattingOptions
): string {
  return jsonc.applyEdits(text, jsonc.modify(text, jsonPath, value, { formattingOptions: formatting }));
}

export interface ProjectAccountSettings {
  /** Absolute config dir to pin, or undefined to write no env keys. */
  configDir?: string;
  /** Expected account to pin, or undefined to leave it alone. */
  expectedAccount?: string;
}

/**
 * Write the per-project account settings into `<folder>/.vscode/settings.json`.
 *
 * Throws if the file exists but cannot be parsed — callers must surface that
 * rather than clobber a file the user hand-edited.
 */
export function writeProjectAccountSettings(
  workspaceRoot: string,
  settings: ProjectAccountSettings,
  formatting: jsonc.FormattingOptions = { tabSize: 2, insertSpaces: true, eol: '\n' }
): WriteResult {
  const dir = path.join(workspaceRoot, '.vscode');
  const file = path.join(dir, 'settings.json');

  let text = '';
  let created = false;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch {
    created = true;
    text = '{}\n';
  }

  if (!created) {
    const { error } = parseJsonc(text);
    if (error) {
      throw new Error(`${file} is not valid JSON (${error}). Fix it and run this again.`);
    }
  }
  if (text.trim() === '') {
    text = '{}\n';
  }

  if (settings.configDir) {
    // Terminal: an object map. Set only our key so sibling variables survive.
    const terminalPath = resolveWritePath(parseJsonc(text).value, TERMINAL_ENV_PATH);
    text = apply(text, [...terminalPath, CONFIG_DIR_VAR], settings.configDir, formatting);

    // Sidebar: an array of {name, value}. Replace our entry or append one.
    const sidebarPath = resolveWritePath(parseJsonc(text).value, SIDEBAR_ENV_PATH);
    const existing = valueAt(parseJsonc(text).value, sidebarPath);
    if (Array.isArray(existing)) {
      const index = existing.findIndex(
        entry => entry && typeof entry === 'object' && (entry as Record<string, unknown>).name === CONFIG_DIR_VAR
      );
      text =
        index >= 0
          ? apply(text, [...sidebarPath, index, 'value'], settings.configDir, formatting)
          : apply(text, [...sidebarPath, existing.length], { name: CONFIG_DIR_VAR, value: settings.configDir }, formatting);
    } else {
      text = apply(text, sidebarPath, [{ name: CONFIG_DIR_VAR, value: settings.configDir }], formatting);
    }
  }

  if (settings.expectedAccount !== undefined) {
    // Written as a file edit rather than through config().update(), so all three
    // keys land in one consistent write instead of racing VS Code's in-memory
    // settings model against our own.
    text = apply(text, ['claudeAccount.expectedAccount'], settings.expectedAccount, formatting);
  }

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, text, 'utf-8');
  return { file, created };
}
