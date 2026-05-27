import { describe, expect, it } from 'vitest';

import { CanvasWriter, type CanvasFs } from './canvas-writer.js';
import type { RoomState } from '../core/reporting/room-state.js';

function state(): RoomState {
  return {
    project_id: 'forgeroom',
    generated_at: '2026-05-26T12:00:00.000Z',
    configured: true,
    default_workflow: 'full',
    allowed_workflows: ['full'],
    active_tasks: [],
    recent_tasks: [],
    sessions: [],
  };
}

describe('CanvasWriter (Phase 2D)', () => {
  it('writes room-state.json + index.html under <root>/<project> and returns the html path', async () => {
    const writes = new Map<string, string>();
    const mkdirs: string[] = [];
    const fs: CanvasFs = {
      mkdir: async (dir) => {
        mkdirs.push(dir);
      },
      writeFile: async (file, content) => {
        writes.set(file, content);
      },
    };
    const writer = new CanvasWriter('/canvas', fs);

    const htmlPath = await writer.write(state());

    expect(mkdirs).toContain('/canvas/forgeroom');
    expect(htmlPath).toBe('/canvas/forgeroom/index.html');
    const json = writes.get('/canvas/forgeroom/room-state.json');
    expect(json).toBeDefined();
    expect(JSON.parse(json!)).toMatchObject({ project_id: 'forgeroom' });
    expect(writes.get('/canvas/forgeroom/index.html')).toContain('ForgeRoom');
  });
});
