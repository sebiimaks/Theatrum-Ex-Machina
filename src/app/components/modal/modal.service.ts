import { Injectable } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { map } from 'rxjs/operators';

import { ModalComponent } from './modal.component';
import { WelcomeComponent } from './welcome.component';

export interface DialogFact {
  label: string;
  value: number | string;
}

export interface DialogTransition {
  from: string;
  fromLabel?: string;
  to: string;
  toLabel?: string;
}

export type DialogTone = 'primary' | 'warning' | 'destructive';

export interface ConfirmationDialogOptions {
  cancelLabel: string;
  confirmLabel: string;
  detailsLabel?: string;
  facts?: DialogFact[];
  summary: string;
  supportingText?: string;
  title: string;
  tone?: DialogTone;
  transition?: DialogTransition;
}

export interface DialogData extends Partial<ConfirmationDialogOptions> {
  cancelLabel?: string;
  confirmLabel?: string;
  kind: 'confirmation' | 'message';
  summary: string;
  title: string;
  details?: string;
}

@Injectable()
export class ModalService {

  constructor(
    public dialog: MatDialog,
    public snack: MatSnackBar,
  ) { }

  /**
   * Opens a modal popup which can be exited via `Esc` key or clicking outside of it
   * returns a promise you can `.subscribe(() => { ... }` to
   * @param title
   * @param content
   * @param details
   */
  openDialog(title: string, content: string, details: string) {

    const dialogRef = this.dialog.open(
      ModalComponent,
      {
        ariaLabel: title,
        data: {
          kind: 'message',
          details: details,
          summary: content,
          title: title,
        },
        maxHeight: 'calc(100vh - 32px)',
        maxWidth: 'calc(100vw - 32px)',
        panelClass: ['app-modal-panel', 'app-message-dialog'],
        restoreFocus: true,
        width: '560px',
      }
    );

    return dialogRef.afterClosed();
  }

  /**
   * Opens a confirmation dialog and emits `true` only when the user confirms.
   */
  openConfirmationDialog(options: ConfirmationDialogOptions) {
    const dialogRef = this.dialog.open(
      ModalComponent,
      {
        ariaLabel: options.title,
        autoFocus: 'first-tabbable',
        data: {
          ...options,
          kind: 'confirmation',
          tone: options.tone || 'primary',
        },
        maxHeight: 'calc(100vh - 32px)',
        maxWidth: 'calc(100vw - 32px)',
        panelClass: ['app-modal-panel', 'app-confirmation-dialog'],
        restoreFocus: true,
        role: options.tone === 'destructive' ? 'alertdialog' : 'dialog',
        width: '620px',
      }
    );

    return dialogRef.afterClosed().pipe(map((result: unknown) => result === true));
  }

  /**
   * Open the welcome message that tells users how to use the app
   */
  openWelcomeMessage() {
    this.dialog.open(WelcomeComponent);
  }

  /**
   * Show "snack bar" / "toaster" at the bottom center with error message for 1.5 seconds
   * @param errorMessage
   */
  openSnackbar(errorMessage: string) {
    this.snack.open(errorMessage, '', {
      duration: 1500,
      panelClass: ['custom-snackbar']
    });
  }

}
