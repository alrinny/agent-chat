/**
 * Agent Chat v2 — Contacts module
 * Local contacts.json management. Maps handles to labels.
 * File-based persistence in the config directory.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Load contacts from a JSON file.
 * Returns an object: { handle: { label, notes } }
 */
export function loadContacts(configDir) {
  const filePath = join(configDir, 'contacts.json');
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Save contacts to a JSON file.
 */
export function saveContacts(configDir, contacts) {
  const filePath = join(configDir, 'contacts.json');
  writeFileSync(filePath, JSON.stringify(contacts, null, 2));
}

/**
 * Add or update a contact.
 */
export function addContact(configDir, handle, label, notes = '') {
  const contacts = loadContacts(configDir);
  contacts[handle] = { label, notes };
  saveContacts(configDir, contacts);
  return contacts[handle];
}

/**
 * Remove a contact.
 */
export function removeContact(configDir, handle) {
  const contacts = loadContacts(configDir);
  const existed = !!contacts[handle];
  delete contacts[handle];
  saveContacts(configDir, contacts);
  return existed;
}

/**
 * Get a single contact by handle.
 */
export function getContact(configDir, handle) {
  const contacts = loadContacts(configDir);
  return contacts[handle] || null;
}

/**
 * List all contacts.
 */
export function listContacts(configDir) {
  const contacts = loadContacts(configDir);
  return Object.entries(contacts).map(([handle, data]) => ({ handle, ...data }));
}
