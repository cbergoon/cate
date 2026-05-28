import { useEffect } from 'react'
import { useStatusStore } from '../stores/statusStore'
import { useAppStore } from '../stores/appStore'
import { terminalRegistry } from '../lib/terminalRegistry'
import type { TerminalActivity } from '../../shared/types'

/** Last agent name we observed per terminal — module-level so we only push a
 *  panel-title fallback on the rising edge (null → "Codex") instead of every
 *  activity tick. Cleared when the renderer unregisters the terminal so the
 *  map stays bounded across long dev sessions. */
const lastAgentName: Map<string, string | null> = new Map()

/** Drop tracking state for a terminal. Wired into `statusStore.unregisterTerminal`
 *  so the module-level map can't grow without bound. */
export function forgetTerminalForProcessMonitor(terminalId: string): void {
  lastAgentName.delete(terminalId)
}

export function useProcessMonitor(workspaceId: string): void {
  useEffect(() => {
    const api = window.electronAPI
    if (!api?.onShellActivityUpdate) return

    const store = useStatusStore.getState

    const unsubscribe = api.onShellActivityUpdate(
      (
        terminalId: string,
        activityRaw: unknown,
        agentNameRaw: unknown,
        subprocessActiveRaw: unknown,
        agentPresentRaw: unknown,
        isStreamingRaw: unknown,
      ) => {
        const terminalActivity = activityRaw as TerminalActivity
        const agentName = (agentNameRaw as string | null) ?? null
        const subprocessActive = subprocessActiveRaw === true
        const agentPresent = agentPresentRaw === true
        const isStreaming = isStreamingRaw === true

        const actualWorkspaceId =
          useStatusStore.getState().terminalWorkspaceMap[terminalId] ?? workspaceId

        store().setTerminalActivity(actualWorkspaceId, terminalId, terminalActivity)
        store().setSubprocessActive(actualWorkspaceId, terminalId, subprocessActive)
        store().setAgentPresent(actualWorkspaceId, terminalId, agentPresent)
        store().setAgentName(actualWorkspaceId, terminalId, agentName)
        store().setAgentStreaming(actualWorkspaceId, terminalId, isStreaming)

        // Fallback title: agents that don't emit OSC 0/1/2 (e.g. Codex) leave
        // the default "Terminal N" string in the tab. Push the agent name as
        // a starter title on the rising edge so the user at least sees which
        // agent is running. Agents that DO emit OSC will immediately overwrite
        // this with the live status. `updatePanelTitleFromAgent` skips when
        // the user has manually renamed the tab.
        const prevAgent = lastAgentName.get(terminalId) ?? null
        if (agentName && agentName !== prevAgent) {
          const panelId = terminalRegistry.panelIdForPty(terminalId) ?? terminalId
          useAppStore.getState().updatePanelTitleFromAgent(actualWorkspaceId, panelId, agentName)
        }
        lastAgentName.set(terminalId, agentName)
      },
    )

    return () => { unsubscribe() }
  }, [workspaceId])

  useEffect(() => {
    const api = window.electronAPI
    if (!api?.onShellPortsUpdate) return
    const unsubscribe = api.onShellPortsUpdate((terminalId: string, ports: number[]) => {
      useStatusStore.getState().setTerminalPorts(terminalId, ports)
    })
    return () => { unsubscribe() }
  }, [])

  useEffect(() => {
    const api = window.electronAPI
    if (!api?.onShellCwdUpdate) return
    const unsubscribe = api.onShellCwdUpdate((terminalId: string, cwd: string) => {
      useStatusStore.getState().setTerminalCwd(terminalId, cwd)
    })
    return () => { unsubscribe() }
  }, [])

  useEffect(() => {
    const api = window.electronAPI
    if (!api?.onGitBranchUpdate) return
    const unsubscribe = api.onGitBranchUpdate(
      (workspaceId: string, branch: string, isDirty: boolean) => {
        useStatusStore.getState().setGitInfo(workspaceId, branch, isDirty)
      },
    )
    return () => { unsubscribe() }
  }, [])

  useEffect(() => {
    const api = window.electronAPI
    if (!api?.gitMonitorStart) return
    const ws = useAppStore.getState().getWorkspace(workspaceId)
    if (ws?.rootPath) {
      api.gitMonitorStart(workspaceId, ws.rootPath)
    }
    return () => { api.gitMonitorStop?.(workspaceId) }
  }, [workspaceId])
}
