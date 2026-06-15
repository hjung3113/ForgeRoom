/**
 * Canvas dashboard writer (Phase 2D, roadmap-v3).
 *
 * Writes a Project Room read-model ({@link RoomState}) to
 * `<canvasRoot>/<project>/room-state.json` and drops a static `index.html` that
 * polls it. The Canvas is a NON-AUTHORITATIVE mirror (ADR-028 §5) — it only
 * reflects TaskStore/ProjectRegistry state and never feeds task control flow.
 *
 * fs IO lives here (app/), never in core. The fs surface is injected so the
 * writer unit-tests without touching disk.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { RoomState } from '../core/reporting/room-state.js';

export interface CanvasFs {
  mkdir(dir: string): Promise<void>;
  writeFile(file: string, content: string): Promise<void>;
}

const NODE_FS: CanvasFs = {
  mkdir: async (dir) => {
    await mkdir(dir, { recursive: true });
  },
  writeFile: async (file, content) => {
    await writeFile(file, content, 'utf8');
  },
};

export class CanvasWriter {
  constructor(
    private readonly canvasRoot: string,
    private readonly fs: CanvasFs = NODE_FS,
  ) {}

  /** Write the room-state JSON + dashboard HTML; returns the index.html path. */
  async write(state: RoomState): Promise<string> {
    const dir = path.join(this.canvasRoot, state.project_id);
    await this.fs.mkdir(dir);
    await this.fs.writeFile(path.join(dir, 'room-state.json'), JSON.stringify(state, null, 2));
    const htmlPath = path.join(dir, 'index.html');
    await this.fs.writeFile(htmlPath, DASHBOARD_HTML);
    return htmlPath;
  }
}

/** Static dashboard: polls room-state.json every 3s and renders the cards. */
const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>ForgeRoom — Project Room</title>
<style>
  body { font: 14px system-ui, sans-serif; margin: 1.5rem; color: #1d1d1f; }
  h1 { font-size: 1.2rem; } h2 { font-size: 1rem; margin-top: 1.5rem; }
  .card { border: 1px solid #ddd; border-radius: 8px; padding: .6rem .8rem; margin: .4rem 0; }
  .status { font-weight: 600; } .muted { color: #888; }
  code { background: #f4f4f5; padding: 0 .3rem; border-radius: 4px; }
</style>
</head>
<body>
<h1>ForgeRoom — <span id="project"></span> <span class="muted" id="ts"></span></h1>
<div id="config" class="muted"></div>
<h2>Active tasks</h2><div id="active"></div>
<h2>Recent tasks</h2><div id="recent"></div>
<h2>OpenClaw session handles <span class="muted">(last observed, resume hint per ADR-017)</span></h2><div id="sessions"></div>
<script>
function taskCard(t) {
  const step = t.active_step ? ' · step <code>' + t.active_step + '</code>' : '';
  const pr = t.pr_number ? ' · PR #' + t.pr_number : '';
  return '<div class="card"><span class="status">' + t.status + '</span> ' + t.title +
    ' <span class="muted">(' + t.id + ', ' + t.workflow_id + ')</span>' + step + pr + '</div>';
}
function sessionCard(s) {
  return '<div class="card">' + s.task_id + '/' + s.step_id +
    ' [' + (s.role || '-') + '] agent=<code>' + (s.agent_key || '-') +
    '</code> session=<code>' + (s.session_id || '-') + '</code></div>';
}
async function refresh() {
  try {
    const r = await fetch('room-state.json?t=' + Date.now());
    const s = await r.json();
    document.getElementById('project').textContent = s.project_id;
    document.getElementById('ts').textContent = 'updated ' + s.generated_at;
    document.getElementById('config').textContent = s.configured
      ? 'default workflow: ' + s.default_workflow + ' · allowed: ' + s.allowed_workflows.join(', ')
      : 'no Project Room config';
    document.getElementById('active').innerHTML = s.active_tasks.map(taskCard).join('') || '<p class="muted">none</p>';
    document.getElementById('recent').innerHTML = s.recent_tasks.map(taskCard).join('') || '<p class="muted">none</p>';
    document.getElementById('sessions').innerHTML = s.sessions.map(sessionCard).join('') || '<p class="muted">none</p>';
  } catch (e) { /* room-state.json not written yet */ }
}
refresh();
setInterval(refresh, 3000);
</script>
</body>
</html>
`;
