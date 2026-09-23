import type { MenuItemConstructorOptions } from 'electron';
import type { PrivateHubOpenOutcome } from './private-hub-open';

export type PrivateHubMenuProblem = 'no-catalogue' | 'busy' | 'unavailable';
interface PrivateHubMenuOptions {
  readonly open: () => Promise<PrivateHubOpenOutcome>;
  readonly create: () => Promise<PrivateHubOpenOutcome>;
  readonly canCreate: () => boolean;
  readonly report: (problem: PrivateHubMenuProblem, operation: 'open' | 'create') => Promise<void>;
}

/** Native actions only: no paths, credentials or renderer messages enter here. */
export function createPrivateHubMenu(options: PrivateHubMenuOptions): MenuItemConstructorOptions {
  const { open, create, canCreate, report } = options;
  let pending = false;
  const invoke = async (operation: 'open' | 'create'): Promise<void> => {
    if (pending) { return; }
    pending = true;
    try {
      let problem: PrivateHubMenuProblem | undefined;
      try {
        if (operation === 'create' && !canCreate()) { problem = 'no-catalogue'; }
        else {
          const result = await (operation === 'open' ? open() : create());
          if (result === 'busy' || result === 'unavailable') { problem = result; }
        }
      } catch { problem = 'unavailable'; }
      if (problem) { await report(problem, operation); }
    } catch { /* Native dialog failure must not expose private errors or reject an event callback. */ }
    finally { pending = false; }
  };
  return {
    label: 'File', submenu: [
      { id: 'private-hub-open', label: 'Open private hub…', click: () => { void invoke('open'); } },
      { id: 'private-hub-create', label: 'Create private copy…', click: () => { void invoke('create'); } },
    ],
  };
}
