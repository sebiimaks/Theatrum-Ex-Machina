import { Injectable } from '@angular/core';
import { RendererMutationLifetime } from '../common/renderer-mutation-lifetime';

/** One shared mutation lifetime for the ordinary renderer and all its editors. */
@Injectable({ providedIn: 'root' })
export class RendererMutationService extends RendererMutationLifetime {}
