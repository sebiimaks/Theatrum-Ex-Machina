import { Directive, HostListener, output } from '@angular/core';
import { handleDialogKeydown } from '../common/dialog-keyboard';

@Directive({
  selector: '[appDialogKeyboard]',
  standalone: false,
})
export class DialogKeyboardDirective {
  readonly dialogEscape = output<void>();

  @HostListener('keydown', ['$event'])
  handleKeydown(event: KeyboardEvent): void {
    handleDialogKeydown(event, () => this.dialogEscape.emit());
  }
}
