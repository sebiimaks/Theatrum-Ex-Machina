import { PrivateHubOpenCoordinator } from './private-hub-open';
import { PrivateHubSession } from './private-hub-session';
import { PrivateHubBrowser, isPrivateBrowserDisposedFailure } from './private-hub-browser';
import { PrivateHubWorkspace, type PrivateHubWorkspaceOptions } from './private-hub-workspace';
import { convertCatalogueToPrivateHub, reviewCatalogueForPrivateConversion, isPrivateHubConversionCleanupFailure } from './private-hub-conversion';
import { createPrivateTouchIdProvider } from './private-touch-id';
import { isPrivateHubPassword } from '../interfaces/private-hub-credentials';

const disposedFailures = new WeakSet<Error>();
function disposedFailure(): Error {
  const error = new Error('The private copy could not be prepared.');
  disposedFailures.add(error);
  return error;
}

/**
 * Main-only composition. open().directory is the captured ordinary catalogue,
 * never a renderer path. The caller holds its saved-document/pause proof until
 * this entire workspace settles, including conversion, activation and gallery.
 */
export function createPrivateConversionWorkspace(options: PrivateHubWorkspaceOptions): PrivateHubWorkspace {
  const { appDirectory, lifecycle } = options;
  const visible = options.promptVisible !== false;
  const touchId = createPrivateTouchIdProvider();
  return new PrivateHubWorkspace(new PrivateHubOpenCoordinator({
    createSession: () => new PrivateHubSession({ touchId }),
    // Preparation supplies a creation password; an ordinary unlock prompt is
    // deliberately unavailable in this workspace.
    requestPassword: async () => { throw new Error('Private copy preparation is required.'); },
    prepareHub: async (cataloguePath, lifetime) => {
      const controller = new AbortController();
      const signal = AbortSignal.any([lifetime.signal, controller.signal]);
      // These exact references bind the issued review to this exclusion lifetime.
      const assertSourceQuiescent = (): void => {
        signal.throwIfAborted();
        if (lifetime.isCurrent() !== true) { throw new Error('Private copy authority is unavailable.'); }
        signal.throwIfAborted();
      };
      try {
        let review: Awaited<ReturnType<typeof reviewCatalogueForPrivateConversion>>;
        try {
          review = await reviewCatalogueForPrivateConversion({ cataloguePath, assertSourceQuiescent, signal });
          assertSourceQuiescent();
        } catch (error) {
          // Review owns only bounded source reads. Its cleanup brand is the
          // distinction between a safe refusal and uncertain descriptor closure.
          if (isPrivateHubConversionCleanupFailure(error)) { throw error; }
          throw disposedFailure();
        }
        return await PrivateHubBrowser.requestConversion({
          ...lifetime, visible, lifecycle, review,
          onRetire: () => controller.abort(),
          start: async (password, allowMissingPreviews, onProgress, chooseDestination) => {
            if (!isPrivateHubPassword(password)) { throw new Error('The private copy password is unavailable.'); }
            const credential = Buffer.from(password, 'utf8');
            password = '';
            const wipe = (): void => { credential.fill(0); };
            signal.addEventListener('abort', wipe, { once: true });
            try {
              assertSourceQuiescent();
              const destinationDirectory = await chooseDestination();
              assertSourceQuiescent();
              if (destinationDirectory === undefined) { return undefined; }
              await convertCatalogueToPrivateHub({ cataloguePath, destinationDirectory,
                password: credential.toString('utf8'), assertSourceQuiescent, signal,
                review, allowMissingPreviews, onProgress,
              });
              assertSourceQuiescent();
              // Session.unlock reopens and verifies the completed receipt before
              // publishing activation. Conversion itself never activates a hub.
              return { directory: destinationDirectory, password: credential.toString('utf8') };
            } finally { signal.removeEventListener('abort', wipe); wipe(); }
          },
        });
      } finally { controller.abort(); cataloguePath = ''; }
    },
    createBrowser: ({ hub, generation, signal, isCurrent }) => PrivateHubBrowser.create({
      hub, generation, signal, isAuthorized: isCurrent, appDirectory, lifecycle,
    }),
    isDisposedFailure: error => isPrivateBrowserDisposedFailure(error)
      || (error instanceof Error && disposedFailures.has(error)),
  }), { lifecycle });
}
