/**
 * Unit tests for lib/contacts.js
 * Tests: CONTACTS-LOAD-001..003, CONTACTS-ADD-001..003, CONTACTS-REMOVE-001..002,
 *        CONTACTS-LIST-001..002, CONTACTS-GET-001..002
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadContacts, saveContacts, addContact,
  removeContact, getContact, listContacts
} from '../../lib/contacts.js';

const TEST_DIR = join(import.meta.dirname, '..', '..', '.test-contacts-' + process.pid);

before(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

after(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('loadContacts', () => {
  it('CONTACTS-LOAD-001: returns empty object when file missing', () => {
    const contacts = loadContacts(TEST_DIR + '-nonexistent');
    assert.deepStrictEqual(contacts, {});
  });

  it('CONTACTS-LOAD-002: returns empty object for invalid JSON', () => {
    const dir = TEST_DIR + '-badjson';
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'contacts.json'), 'not json');
    const contacts = loadContacts(dir);
    assert.deepStrictEqual(contacts, {});
    rmSync(dir, { recursive: true, force: true });
  });

  it('CONTACTS-LOAD-003: loads valid contacts', () => {
    saveContacts(TEST_DIR, { alice: { label: 'Alice', notes: '' } });
    const contacts = loadContacts(TEST_DIR);
    assert.equal(contacts.alice.label, 'Alice');
  });
});

describe('addContact', () => {
  it('CONTACTS-ADD-001: adds new contact', () => {
    const result = addContact(TEST_DIR, 'bob', 'Bob');
    assert.equal(result.label, 'Bob');
    assert.equal(result.notes, '');
    const loaded = loadContacts(TEST_DIR);
    assert.equal(loaded.bob.label, 'Bob');
  });

  it('CONTACTS-ADD-002: updates existing contact', () => {
    addContact(TEST_DIR, 'bob', 'Bobby', 'updated');
    const loaded = loadContacts(TEST_DIR);
    assert.equal(loaded.bob.label, 'Bobby');
    assert.equal(loaded.bob.notes, 'updated');
  });

  it('CONTACTS-ADD-003: preserves other contacts', () => {
    addContact(TEST_DIR, 'charlie', 'Charlie');
    const loaded = loadContacts(TEST_DIR);
    assert.ok(loaded.bob);
    assert.ok(loaded.charlie);
    assert.ok(loaded.alice);
  });
});

describe('removeContact', () => {
  it('CONTACTS-REMOVE-001: removes existing contact', () => {
    const existed = removeContact(TEST_DIR, 'charlie');
    assert.equal(existed, true);
    const loaded = loadContacts(TEST_DIR);
    assert.equal(loaded.charlie, undefined);
  });

  it('CONTACTS-REMOVE-002: returns false for non-existent contact', () => {
    const existed = removeContact(TEST_DIR, 'nobody');
    assert.equal(existed, false);
  });
});

describe('getContact', () => {
  it('CONTACTS-GET-001: returns contact data', () => {
    const contact = getContact(TEST_DIR, 'bob');
    assert.equal(contact.label, 'Bobby');
  });

  it('CONTACTS-GET-002: returns null for unknown handle', () => {
    const contact = getContact(TEST_DIR, 'unknown');
    assert.equal(contact, null);
  });
});

describe('listContacts', () => {
  it('CONTACTS-LIST-001: returns all contacts with handle field', () => {
    const list = listContacts(TEST_DIR);
    assert.ok(Array.isArray(list));
    assert.ok(list.length >= 2);
    const handles = list.map(c => c.handle);
    assert.ok(handles.includes('bob'));
    assert.ok(handles.includes('alice'));
  });

  it('CONTACTS-LIST-002: empty dir returns empty array', () => {
    const emptyDir = TEST_DIR + '-empty-list';
    mkdirSync(emptyDir, { recursive: true });
    const list = listContacts(emptyDir);
    assert.deepStrictEqual(list, []);
    rmSync(emptyDir, { recursive: true, force: true });
  });
});
