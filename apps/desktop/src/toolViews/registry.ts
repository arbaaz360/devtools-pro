import type { ToolManifest } from '../bridge';
import type { RegisteredToolView, ToolView } from './types';

export class ToolViewRegistry {
  private readonly views = new Map<string, ToolView>();

  register(view: ToolView): this {
    for (const id of view.ids) {
      if (this.views.has(id)) throw new Error(`A tool view is already registered for ${id}.`);
      this.views.set(id, view);
    }
    return this;
  }

  resolve(manifest: ToolManifest): RegisteredToolView {
    return { manifest, view: this.views.get(manifest.id) ?? null, renderer: manifest.renderer };
  }

  has(manifestId: string): boolean {
    return this.views.has(manifestId);
  }
}
