import type { PipeTransform } from '@angular/core';
import { Pipe } from '@angular/core';

@Pipe({
  standalone: false,
  name: 'sidebarHeightPipe'
})
export class SidebarHeightPipe implements PipeTransform {

  /**
   * Return number of pixels to offset the sidebar (as a string)
   * @param menuHidden     - whether to hide the menu bar
   * @param hideTop        - whether to hide the top bar
   * @param showBottomTray - whether the bottom tray is showing
   */
  transform(
    menuHidden: boolean,
    hideTop: boolean,
    showBottomTray: boolean
  ): string {

    return (
        (menuHidden     ? -40 :   0)
      // Includes the 28px title bar, 40px ribbon, optional 45px top panel,
      // and the existing 1px boundary allowance.
      + (hideTop        ?  69 : 114)
      + (showBottomTray ? 170 :  0)
      ).toString();

  }

}
