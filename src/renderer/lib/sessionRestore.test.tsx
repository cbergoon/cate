// =============================================================================
// Regression: switching to a DEFERRED workspace must not blank its canvas.
//
// restoreMultiWorkspaceSession fully restores only the selected (index-0)
// workspace; the others are deferred and rebuilt on first switch via
// selectWorkspace -> restoreDeferredWorkspace -> restoreSession, which populates
// the canvas STORE directly (workspace.canvasNodes stays empty until the next
// autosave syncs it). Before the fix, selectWorkspace's "re-resolve" block then
// reloaded the still-empty canvasNodes over that store, WIPING the just-restored
// nodes — the canvas came up blank while the panels still showed in the sidebar,
// and the next save persisted the empty canvas (corrupting .cate/workspace.json).
//
// This test drives the real restore + switch path and asserts the rendered
// canvas store (what CanvasPanel reads) actually contains the restored nodes.
// =============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest'

// The real terminalRegistry starts an idle-scan timer at import time, which
// keeps the test worker alive; logger routes through electron-log. Stub both.
vi.mock('./terminalRegistry', () => ({
  terminalRegistry: {
    entries: () => [],
    panelIdForPty: () => null,
    getEntry: () => undefined,
    dispose: () => {},
  },
}))
vi.mock('./logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

// prefetchPanelChunks() dynamically imports panel components during restore.
// Stub them so we don't pull xterm/Monaco into the test environment.
vi.mock('../panels/TerminalPanel', () => ({ default: () => null }))
vi.mock('../panels/EditorPanel', () => ({ default: () => null }))
vi.mock('../panels/BrowserPanel', () => ({ default: () => null }))
vi.mock('../panels/GitPanel', () => ({ default: () => null }))
vi.mock('../panels/FileExplorerPanel', () => ({ default: () => null }))
vi.mock('../panels/ProjectListPanel', () => ({ default: () => null }))
vi.mock('../panels/CanvasPanel', () => ({ default: () => null }))

import { useAppStore, setCanvasOperations, getWorkspaceCanvasStore } from '../stores/appStore'
import { createCanvasOps } from './canvasBridge'
import { useCanvasStore } from '../stores/canvasStore'
import { useDockStore } from '../stores/dockStore'
import { DragSession, __setDefaultSessionForTests } from '../drag/session'
import { restoreMultiWorkspaceSession } from './session'
import type {
  DockStateSnapshot,
  MultiWorkspaceSession,
  SessionSnapshot,
} from '../../shared/types'

function cleanDockSnapshot(): DockStateSnapshot {
  return {
    zones: {
      left: { position: 'left', visible: false, size: 260, layout: null },
      right: { position: 'right', visible: false, size: 260, layout: null },
      bottom: { position: 'bottom', visible: false, size: 240, layout: null },
      center: { position: 'center', visible: true, size: 0, layout: null },
    },
    locations: {},
  }
}

// Build a workspace snapshot with a center canvas panel hosting N terminal nodes,
// mirroring what loadFromProjectFiles produces from .cate/workspace.json.
function makeWorkspaceSnapshot(name: string, terminalTitles: string[]): SessionSnapshot {
  const canvasPanelId = crypto.randomUUID()
  const stackId = crypto.randomUUID()
  const nodes = terminalTitles.map((title, i) => ({
    panelId: crypto.randomUUID(),
    panelType: 'terminal',
    title,
    origin: { x: 100, y: 100 + i * 440 },
    size: { width: 640, height: 400 },
  }))
  const dockState: DockStateSnapshot = {
    zones: {
      left: { position: 'left', visible: false, size: 260, layout: null },
      right: { position: 'right', visible: false, size: 260, layout: null },
      bottom: { position: 'bottom', visible: false, size: 240, layout: null },
      center: {
        position: 'center',
        visible: true,
        size: 0,
        layout: { type: 'tabs', id: stackId, panelIds: [canvasPanelId], activeIndex: 0 },
      },
    },
    locations: { [canvasPanelId]: { type: 'dock', zone: 'center', stackId } },
  }
  return {
    workspaceId: crypto.randomUUID(),
    workspaceName: name,
    rootPath: `/tmp/cate-test/${name}`,
    zoomLevel: 1,
    viewportOffset: { x: 0, y: 0 },
    nodes,
    dockState,
    dockPanels: {
      [canvasPanelId]: { id: canvasPanelId, type: 'canvas', title: 'Canvas', isDirty: false },
    },
  }
}

describe('session restore — deferred workspace switch', () => {
  beforeEach(() => {
    // Fresh drag session so the "first canvas inherits the singleton" rule
    // starts clean each test.
    __setDefaultSessionForTests(new DragSession())
    useAppStore.setState({ workspaces: [], selectedWorkspaceId: '' })
    useCanvasStore.getState().loadWorkspaceCanvas({}, { x: 0, y: 0 }, 1, null, {})
    useDockStore.getState().restoreSnapshot(cleanDockSnapshot())
    setCanvasOperations(createCanvasOps(useCanvasStore))

    // Minimal main-process IPC the workspace mutations fire-and-forget into.
    window.electronAPI = {
      ...window.electronAPI,
      workspaceCreate: vi.fn(async (a: { id: string; name: string; rootPath?: string }) => ({
        ok: true,
        workspace: { id: a.id, name: a.name, color: '', rootPath: a.rootPath ?? '' },
      })),
      workspaceUpdate: vi.fn(async () => ({ ok: true })),
      workspaceRemove: vi.fn(),
    } as unknown as Window['electronAPI']
  })

  it('keeps the restored nodes on the canvas after switching to the deferred workspace', async () => {
    const wsA = makeWorkspaceSnapshot('A', ['Terminal 1'])
    const wsB = makeWorkspaceSnapshot('B', ['Terminal 1', 'Terminal 2', 'Terminal 3'])
    const session: MultiWorkspaceSession = {
      version: 2,
      selectedWorkspaceIndex: 0,
      workspaces: [wsA, wsB],
    }

    await restoreMultiWorkspaceSession(session, useCanvasStore)

    const [a, b] = useAppStore.getState().workspaces
    expect(useAppStore.getState().workspaces).toHaveLength(2)
    expect(useAppStore.getState().selectedWorkspaceId).toBe(a.id)

    // The selected workspace A is fully restored — its rendered canvas store
    // holds its single terminal node.
    const aStore = getWorkspaceCanvasStore(a.id)!
    expect(Object.keys(aStore.getState().nodes)).toHaveLength(1)

    // Switch to the deferred workspace B (triggers restoreDeferredWorkspace).
    await useAppStore.getState().selectWorkspace(b.id)

    // The store CanvasPanel renders for B must contain all 3 terminals.
    // Pre-fix this came back empty (the re-resolve block wiped it).
    const bStore = getWorkspaceCanvasStore(b.id)!
    expect(Object.keys(bStore.getState().nodes)).toHaveLength(3)

    // The panels exist regardless (sidebar source) — so an empty store would be
    // the panels-without-nodes divergence. Assert node count matches panel count.
    const bRecord = useAppStore.getState().workspaces.find((w) => w.id === b.id)!
    const bTerminals = Object.values(bRecord.panels).filter((p) => p.type === 'terminal')
    expect(bTerminals).toHaveLength(3)

    // canvasNodes record is synced back too, so the next save persists the
    // real layout instead of an empty canvas.
    expect(Object.keys(bRecord.canvasNodes)).toHaveLength(3)
  })
})
