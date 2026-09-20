import type { PipeTransform } from '@angular/core';
import { Pipe } from '@angular/core';

@Pipe({
  standalone: false,
  name: 'sidebarHeightPipe'
})
export class SidebarHeightPipe implements PipeTransform {

  /**
   * Return the shared CSS offset. Short windows overlay trays instead of
   * subtracting their height from the gallery and sidebars.
   * @param menuHidden     - whether to hide the menu bar
   * @param hideTop        - whether to hide the top bar
   * @param showBottomTray - whether the bottom tray is showing
   */
  transform(
    menuHidden: boolean,
    hideTop: boolean,
    showBottomTray: boolean
  ): string {

    const topOffset = (
        (menuHidden     ? -40 :   0)
      // Includes the 28px title bar, 96px workspace toolbar (56px header + 40px pinned ribbon), optional 45px top panel,
      // and the existing 1px boundary allowance.
      + (hideTop        ? 125 : 170)
      );
    return showBottomTray
      ? `calc(${topOffset}px + var(--app-bottom-tray-reserve, 170px))`
      : `${topOffset}px`;

  }

}
