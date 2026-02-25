/**
 * Agent Chat v2 — Contacts module
 * Contacts stored in <AGENT_CHAT_DIR>/contacts.json (workspace, shared by all handles).
 * Maps handles to { label, owner, trust, topics, autoForward, style, lastTopic, lastDate, notes }.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { resolveDataDir } from './config.js';

/**
 * Resolve contacts file path.
 * AGENT_CHAT_CONTACTS → or <dataDir>/contacts.json
 */
function resolveContactsPath() {
  if (process.env.AGENT_CHAT_CONTACTS) return process.env.AGENT_CHAT_CONTACTS;
  return join(resolveDataDir(), 'contacts.json');
}

/**
 * Load contacts from the workspace contacts.json.
 * Returns an object: { handle: { label, ...metadata } }
 */
export function loadContacts(contactsPathOrDir) {
  // Backward compat: if a directory is passed, check for contacts.json in it
  // New behavior: use resolveContactsPath() when no argument
  let filePath;
  if (!contactsPathOrDir) {
    filePath = resolveContactsPath();
  } else if (contactsPathOrDir.endsWith('.json')) {
    filePath = contactsPathOrDir;
  } else {
    filePath = join(contactsPathOrDir, 'contacts.json');
  }

  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Save contacts to the workspace contacts.json.
 */
export function saveContacts(contactsPathOrDir, contacts) {
  let filePath;
  if (!contactsPathOrDir) {
    filePath = resolveContactsPath();
  } else if (contactsPathOrDir.endsWith('.json')) {
    filePath = contactsPathOrDir;
  } else {
    filePath = join(contactsPathOrDir, 'contacts.json');
  }

  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(contacts, null, 2));
}

/**
 * Add or update a contact.
 */
export function addContact(dir, handle, label, notes = '') {
  const contacts = loadContacts(dir);
  contacts[handle] = { ...contacts[handle], label, notes };
  saveContacts(dir, contacts);
  return contacts[handle];
}

/**
 * Remove a contact.
 */
export function removeContact(dir, handle) {
  const contacts = loadContacts(dir);
  const existed = !!contacts[handle];
  delete contacts[handle];
  saveContacts(dir, contacts);
  return existed;
}

/**
 * Get a single contact by handle.
 */
export function getContact(dir, handle) {
  const contacts = loadContacts(dir);
  return contacts[handle] || null;
}

/**
 * List all contacts.
 */
export function listContacts(dir) {
  const contacts = loadContacts(dir);
  return Object.entries(contacts).map(([handle, data]) => ({ handle, ...data }));
}
