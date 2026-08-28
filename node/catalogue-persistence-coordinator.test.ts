import { strict as assert } from 'assert';
import { readFileSync } from 'fs';
import { join } from 'path';
import { test } from 'node:test';

import type { FinalObject } from '../interfaces/final-object.interface';
import type { SettingsObject } from '../interfaces/settings-object.interface';
import {
  CataloguePersistenceCoordinator,
  CataloguePersistenceHooks,
  CataloguePersistenceTransport,
} from '../src/app/common/catalogue-persistence-coordinator';

type MessageListener = (message?: string) => void;

class FakePersistenceTransport implements CataloguePersistenceTransport {

  readonly allCloseRequested: (() => void)[] = [];
  readonly allSaveSucceeded: (() => void)[] = [];
  readonly closeCancelled = new Set<() => void>();
  readonly closeRequested = new Set<() => void>();
  readonly closeSaveFailed = new Set<MessageListener>();
  readonly closeRequests: { document: FinalObject | null; settings: SettingsObject }[] = [];
  readonly saveFailed = new Set<MessageListener>();
  readonly saveRequests: FinalObject[] = [];
  readonly saveSucceeded = new Set<() => void>();
  disposerAttempts = 0;
  disposerCalls = 0;
  registrationCalls = 0;
  throwOnDisposerAttempt = 0;
  throwOnRegistration = 0;

  onCloseCancelled(listener: () => void): () => void {
    return this.register(this.closeCancelled, listener);
  }

  onCloseRequested(listener: () => void): () => void {
    this.allCloseRequested.push(listener);
    return this.register(this.closeRequested, listener);
  }

  onCloseSaveFailed(listener: MessageListener): () => void {
    return this.register(this.closeSaveFailed, listener);
  }

  onSaveFailed(listener: MessageListener): () => void {
    return this.register(this.saveFailed, listener);
  }

  onSaveSucceeded(listener: () => void): () => void {
    this.allSaveSucceeded.push(listener);
    return this.register(this.saveSucceeded, listener);
  }

  requestClose(settings: SettingsObject, document: FinalObject | null): void {
    this.closeRequests.push({ document, settings });
  }

  saveCatalogue(document: FinalObject): void {
    this.saveRequests.push(document);
  }

  private register<T extends (...args: any[]) => void>(listeners: Set<T>, listener: T): () => void {
    this.registrationCalls += 1;
    if (this.registrationCalls === this.throwOnRegistration) {
      throw new Error('Listener registration failed.');
    }
    listeners.add(listener);
    let active = true;
    return () => {
      if (!active) {
        return;
      }
      active = false;
      listeners.delete(listener);
      this.disposerAttempts += 1;
      if (this.disposerAttempts === this.throwOnDisposerAttempt) {
        throw new Error('Listener disposal failed.');
      }
      this.disposerCalls += 1;
    };
  }
}

function createHooks(events: string[]): CataloguePersistenceHooks {
  return {
    closeCancelled: () => events.push('close-cancelled'),
    closeRequested: () => events.push('close-requested'),
    closeSaveFailed: (message?: string) => events.push(`close-save-failed:${message || ''}`),
    saveFailed: (message?: string) => events.push(`save-failed:${message || ''}`),
    saveSucceeded: () => events.push('save-succeeded'),
  };
}

test('maps every persistence notification to its typed hook without reordering', () => {
  const transport = new FakePersistenceTransport();
  const coordinator = new CataloguePersistenceCoordinator(transport);
  const events: string[] = [];
  coordinator.connect(createHooks(events));

  Array.from(transport.closeRequested).forEach((listener) => listener());
  Array.from(transport.saveSucceeded).forEach((listener) => listener());
  Array.from(transport.saveFailed).forEach((listener) => listener('disk full'));
  Array.from(transport.closeSaveFailed).forEach((listener) => listener('invalid name'));
  Array.from(transport.closeCancelled).forEach((listener) => listener());

  assert.deepEqual(events, [
    'close-requested',
    'save-succeeded',
    'save-failed:disk full',
    'close-save-failed:invalid name',
    'close-cancelled',
  ]);
});

test('reconnect disposes old listeners and ignores late callbacks from stale generations', () => {
  const transport = new FakePersistenceTransport();
  const coordinator = new CataloguePersistenceCoordinator(transport);
  const firstEvents: string[] = [];
  const secondEvents: string[] = [];
  coordinator.connect(createHooks(firstEvents));
  const staleCloseRequested = transport.allCloseRequested[0];
  const staleSaveSucceeded = transport.allSaveSucceeded[0];

  coordinator.connect(createHooks(secondEvents));
  assert.equal(transport.disposerCalls, 5);
  staleCloseRequested();
  staleSaveSucceeded();
  Array.from(transport.closeRequested).forEach((listener) => listener());

  assert.deepEqual(firstEvents, []);
  assert.deepEqual(secondEvents, ['close-requested']);
});

test('disconnect is idempotent and makes retained late callbacks inert', () => {
  const transport = new FakePersistenceTransport();
  const coordinator = new CataloguePersistenceCoordinator(transport);
  const events: string[] = [];
  coordinator.connect(createHooks(events));
  const lateSaveSucceeded = transport.allSaveSucceeded[0];

  coordinator.disconnect();
  coordinator.disconnect();
  lateSaveSucceeded();

  assert.equal(transport.disposerCalls, 5);
  assert.deepEqual(events, []);
  assert.equal(transport.closeRequested.size, 0);
  assert.equal(transport.saveSucceeded.size, 0);
});

test('a partial connection failure disposes every listener registered so far', () => {
  const transport = new FakePersistenceTransport();
  transport.throwOnRegistration = 3;
  const coordinator = new CataloguePersistenceCoordinator(transport);

  assert.throws(
    () => coordinator.connect(createHooks([])),
    /Listener registration failed/,
  );
  assert.equal(transport.disposerCalls, 2);
  assert.equal(transport.closeRequested.size, 0);
  assert.equal(transport.saveSucceeded.size, 0);
});

test('a disposer failure does not prevent best-effort cleanup of remaining listeners', () => {
  const transport = new FakePersistenceTransport();
  transport.throwOnDisposerAttempt = 2;
  const coordinator = new CataloguePersistenceCoordinator(transport);
  const events: string[] = [];
  coordinator.connect(createHooks(events));
  const lateSaveSucceeded = transport.allSaveSucceeded[0];

  assert.throws(() => coordinator.disconnect(), /Listener disposal failed/);
  lateSaveSucceeded();

  assert.equal(transport.disposerAttempts, 5);
  assert.equal(transport.disposerCalls, 4);
  assert.equal(transport.closeRequested.size, 0);
  assert.equal(transport.saveSucceeded.size, 0);
  assert.deepEqual(events, []);
});

test('a first-listener registration failure leaves no active listener', () => {
  const transport = new FakePersistenceTransport();
  transport.throwOnRegistration = 1;
  const coordinator = new CataloguePersistenceCoordinator(transport);

  assert.throws(
    () => coordinator.connect(createHooks([])),
    /Listener registration failed/,
  );
  assert.equal(transport.disposerAttempts, 0);
  assert.equal(transport.closeRequested.size, 0);
});

test('registration failure remains primary when its best-effort cleanup also fails', () => {
  const transport = new FakePersistenceTransport();
  transport.throwOnRegistration = 3;
  transport.throwOnDisposerAttempt = 2;
  const coordinator = new CataloguePersistenceCoordinator(transport);

  assert.throws(
    () => coordinator.connect(createHooks([])),
    /Listener registration failed/,
  );
  assert.equal(transport.disposerAttempts, 2);
  assert.equal(transport.closeRequested.size, 0);
  assert.equal(transport.saveSucceeded.size, 0);
});

test('outbound save and close requests preserve object identity and argument order', () => {
  const transport = new FakePersistenceTransport();
  const coordinator = new CataloguePersistenceCoordinator(transport);
  const document = { hubName: 'Photography' } as FinalObject;
  const settings = { appState: { hubName: 'Photography' } } as SettingsObject;

  coordinator.saveCatalogue(document);
  coordinator.requestClose(settings, document);
  coordinator.requestClose(settings, null);

  assert.equal(transport.saveRequests[0], document);
  assert.equal(transport.closeRequests[0].settings, settings);
  assert.equal(transport.closeRequests[0].document, document);
  assert.equal(transport.closeRequests[1].document, null);
});

test('the Angular adapter owns exact Electron channels and Home owns state transitions', () => {
  const adapter = readFileSync(
    join(__dirname, '../src/app/services/catalogue-persistence-ipc.service.ts'),
    'utf8',
  );
  const component = readFileSync(
    join(__dirname, '../src/app/components/home.component.ts'),
    'utf8',
  );

  for (const channel of [
    'please-shut-down-ASAP',
    'current-vha-file-saved',
    'current-vha-file-save-failed',
    'close-window-save-failed',
    'close-window-cancelled',
    'save-current-vha-file',
    'close-window',
  ]) {
    assert.ok(adapter.includes(`'${channel}'`), `Missing adapter channel ${channel}`);
  }

  assert.match(component, /this\.cataloguePersistenceIpc\.connect\(\{/);
  assert.match(component, /closeRequested: \(\): void => \{\s*if \(!this\.isClosing\)/);
  assert.match(
    component,
    /closeSaveFailed: \(errorMessage\?: string\): void => \{[\s\S]*this\.isClosing = false;[\s\S]*this\.catalogueEditorSaving = false;[\s\S]*errorMessage \? 'Save failed: ' \+ errorMessage : 'Save failed'/,
  );
  assert.match(component, /saveSucceeded: \(\): void => \{[\s\S]*finalArrayNeedsSaving = false[\s\S]*restoreSavedTags/);
  assert.match(component, /saveFailed: \(errorMessage\?: string\): void => \{[\s\S]*catalogueOpenCoordinator\.finishOpen\(\)/);
  assert.match(component, /closeCancelled: \(\): void => \{[\s\S]*this\.isClosing = false/);
  assert.match(component, /this\.cataloguePersistenceIpc\.disconnect\(\)/);
  assert.match(component, /this\.cataloguePersistenceIpc\.saveCatalogue\(finalObjectToSave\)/);
  assert.match(component, /this\.cataloguePersistenceIpc\.requestClose\(/);
  assert.match(
    adapter,
    /'current-vha-file-save-failed',\s*\(_event, message\?: string\) => listener\(message\)/,
  );
  assert.match(
    adapter,
    /'close-window-save-failed',\s*\(_event, message\?: string\) => listener\(message\)/,
  );

  for (const incomingChannel of [
    'please-shut-down-ASAP',
    'current-vha-file-saved',
    'current-vha-file-save-failed',
    'close-window-save-failed',
    'close-window-cancelled',
  ]) {
    assert.equal(component.includes(`ipcRenderer.on('${incomingChannel}'`), false);
  }
});
