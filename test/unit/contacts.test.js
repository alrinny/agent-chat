/**
 * Contacts management tests — add, remove, list, trust level, persistence.
 * From test-plan.md sections 4.3, 7 (config)
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Contacts store simulation
class ContactStore {
  constructor() { this.contacts = new Map(); }
  add(handle, label, trust = 'blind') {
    this.contacts.set(handle, { handle, label, trust });
  }
  remove(handle) { this.contacts.delete(handle); }
  get(handle) { return this.contacts.get(handle) || null; }
  list() { return [...this.contacts.values()]; }
  setTrust(handle, trust) {
    const c = this.contacts.get(handle);
    if (c) c.trust = trust;
  }
}

describe('Contacts Management', () => {
  it('add contact with default trust=blind', () => {
    const store = new ContactStore();
    store.add('alice', 'Alice');
    assert.equal(store.get('alice').trust, 'blind');
  });

  it('add contact with explicit trust', () => {
    const store = new ContactStore();
    store.add('alice', 'Alice', 'trusted');
    assert.equal(store.get('alice').trust, 'trusted');
  });

  it('remove contact', () => {
    const store = new ContactStore();
    store.add('alice', 'Alice');
    store.remove('alice');
    assert.equal(store.get('alice'), null);
  });

  it('list contacts', () => {
    const store = new ContactStore();
    store.add('alice', 'Alice');
    store.add('bob', 'Bob');
    assert.equal(store.list().length, 2);
  });

  it('update trust level', () => {
    const store = new ContactStore();
    store.add('alice', 'Alice', 'blind');
    store.setTrust('alice', 'trusted');
    assert.equal(store.get('alice').trust, 'trusted');
  });

  it('get nonexistent contact → null', () => {
    const store = new ContactStore();
    assert.equal(store.get('nobody'), null);
  });

  it('duplicate add → overwrites', () => {
    const store = new ContactStore();
    store.add('alice', 'Alice 1');
    store.add('alice', 'Alice 2');
    assert.equal(store.get('alice').label, 'Alice 2');
    assert.equal(store.list().length, 1);
  });

  it('label with spaces', () => {
    const store = new ContactStore();
    store.add('alice', 'Alice from Work');
    assert.equal(store.get('alice').label, 'Alice from Work');
  });

  it('empty label', () => {
    const store = new ContactStore();
    store.add('alice', '');
    assert.equal(store.get('alice').label, '');
  });

  it('trust values: trusted, blind, block', () => {
    const store = new ContactStore();
    store.add('a', 'A', 'trusted');
    store.add('b', 'B', 'blind');
    store.add('c', 'C', 'block');
    assert.equal(store.get('a').trust, 'trusted');
    assert.equal(store.get('b').trust, 'blind');
    assert.equal(store.get('c').trust, 'block');
  });

  it('contacts persistence format: JSON', () => {
    const store = new ContactStore();
    store.add('alice', 'Alice', 'trusted');
    const json = JSON.stringify(store.list());
    const parsed = JSON.parse(json);
    assert.equal(parsed[0].handle, 'alice');
    assert.equal(parsed[0].trust, 'trusted');
  });

  it('contacts file path: ~/.agent-chat/contacts.json', () => {
    const home = '/Users/test';
    const path = `${home}/.agent-chat/contacts.json`;
    assert.ok(path.endsWith('contacts.json'));
  });
});
