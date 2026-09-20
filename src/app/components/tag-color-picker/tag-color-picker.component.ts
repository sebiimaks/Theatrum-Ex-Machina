import { Component, AfterViewInit, ElementRef, ChangeDetectorRef, HostListener, input, output, viewChild } from '@angular/core';

import { ContextMenuCoordinate } from '../../../../interfaces/shared-interfaces';

@Component({
  standalone: false,
  selector: 'app-tag-color-picker',
  templateUrl: './tag-color-picker.component.html',
  styleUrls: ['./tag-color-picker.component.scss']
})
export class TagColorPickerComponent implements AfterViewInit {

  readonly picker = viewChild<ElementRef<HTMLElement>>('picker');

  readonly position = input<ContextMenuCoordinate>();
  readonly currentColor = input<string>('');
  readonly darkMode = input<boolean>();

  readonly colorSelected = output<string | null>();
  readonly close = output<void>();

  // 3x3 grid of distinct colors plus default option
  colors: string[] = [
    '#FFADAD',
    '#FFD6A5',
    '#FDFFB6',
    '#CAFFBF',
    '#9BF6FF',
    '#A0C4FF',
    '#BDB2FF',
    '#FFC6FF',
    '#FFFFFF',
  ];

  constructor(private cd: ChangeDetectorRef) { }

  ngAfterViewInit(): void {
    this.keepOnScreen();
    this.cd.detectChanges();
  }

  @HostListener('window:resize')
  keepOnScreen(): void {
    const bounds = this.picker()?.nativeElement.getBoundingClientRect();
    const position = this.position();
    if (bounds && position) {
      position.x = Math.max(10, Math.min(position.x, window.innerWidth - bounds.width - 10));
      position.y = Math.max(10, Math.min(position.y, window.innerHeight - bounds.height - 10));
    }
  }

  selectColor(color: string): void {
    this.colorSelected.emit(color);
  }

  clearColor(): void {
    this.colorSelected.emit(null);
  }

  onClose(): void {
    // TODO: The 'emit' function requires a mandatory void argument
    this.close.emit();
  }
}
