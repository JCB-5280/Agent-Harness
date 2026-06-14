import { useState, useCallback } from 'react';
import './theme.css';
import { api, isMock, getMockState, setMockState, type MockKey } from './api/client';
import { useDashboard } from './hooks';
import { Masthead, SetupBanner, NeedsHuman } from './features/Masthead';
import { SeedForm, QueuePanel, JiraPanel, CostsPanel } from './features/Panels';
import { RunsPanel, EventFeed } from './features/Feeds';
import { DagView } from './features/DagView';
import { ContinuityPanel } from './features/Continuity';
import { TranscriptDialog, SetupWizard } from './features/Dialogs';
import type { Run, LostSession, WriteBackMode } from './api/types';

export default function App() {
  const { data, error, refresh } = useDashboard(5000);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [transcript, setTranscript] = useState<{ open: boolean; title: string; url: string | null }>({ open: false, title: '', url: null });
  const [toast, setToast] = useState<string | null>(null);
  const [mockKey, setMockKey] = useState<MockKey>(getMockState());

  const flash = useCallback((m: string) => { setToast(m); window.setTimeout(() => setToast(null), 1600); }, []);
  const act = useCallback(async (fn: () => Promise<unknown>, msg: string) => {
    try { await fn(); flash(msg); await refresh(); } catch (e) { flash(e instanceof Error ? e.message : String(e)); }
  }, [flash, refresh]);

  const openRunTranscript = (r: Run) => setTranscript({ open: true, title: `#${r.task_id} ${r.role}`, url: api.transcriptUrl(r.id) });
  const openLostTranscript = (s: LostSession) => setTranscript({ open: true, title: `lost #${s.taskId} ${s.role}`, url: s.transcriptUrl });

  const s = data?.status ?? null;

  return (
    <>
      {isMock() && (
        <div className="preview-bar">
          <b>Mock mode</b><span className="preview-note">no backend · scenario switcher</span>
          <span style={{ flex: 1 }} />
          <span>state:</span>
          <div className="seg">
            {(['alive', 'mixed', 'firstrun'] as MockKey[]).map((k) => (
              <button key={k} className={`seg-btn ${k === mockKey ? 'on' : ''}`}
                onClick={() => { setMockState(k); setMockKey(k); void refresh(); }}>
                {k === 'alive' ? 'Alive / running' : k === 'mixed' ? 'Mixed' : 'First run'}
              </button>
            ))}
          </div>
        </div>
      )}

      <Masthead status={s}
        onPause={() => act(() => (s?.paused ? api.resume() : api.pause()), s?.paused ? 'Resumed' : 'Paused')}
        onCheckpoint={() => act(() => api.checkpoint(), 'Checkpointed')} />

      <SetupBanner show={!!data && !data.setup.jiraConfigured} onOpen={() => setWizardOpen(true)} />
      <NeedsHuman tasks={data?.tasks ?? []} setup={data?.setup ?? null} />

      <main>
        <section className="col">
          <SeedForm onSeed={(title, project) => act(() => api.seedObjective(title, project), 'Objective sent to PM')} />
          <QueuePanel tasks={data?.tasks ?? []}
            onRetry={(id) => act(() => api.retryTask(id), `Retrying #${id}`)}
            onCancel={(id) => act(() => api.cancelTask(id), `Cancelled #${id}`)} />
          <JiraPanel setup={data?.setup ?? null}
            onModeChange={(m: WriteBackMode) => act(() => api.setWriteBackMode(m), `Write-back → ${m}`)}
            onSync={() => act(() => api.jiraSync(), 'Syncing Jira issues')}
            onReconfigure={() => setWizardOpen(true)} />
          <CostsPanel costs={data?.status.costs ?? []} />
        </section>

        <section className="col">
          <DagView dags={data?.dags ?? []} onNodeClick={(label) => flash(`Task: ${label}`)} />
          <ContinuityPanel continuity={data?.continuity ?? null}
            onThresholdChange={(ms) => act(() => api.setGapThreshold(ms), 'Gap threshold updated')}
            onOpenTranscript={openLostTranscript} />
          <RunsPanel runs={data?.runs ?? []} onOpenTranscript={openRunTranscript} />
          <EventFeed events={data?.events ?? []} />
        </section>
      </main>

      <TranscriptDialog open={transcript.open} title={transcript.title} streamUrl={transcript.url}
        onClose={() => setTranscript((t) => ({ ...t, open: false }))} />
      <SetupWizard open={wizardOpen} secretStoreAvailable={!!data?.setup.secretStoreAvailable}
        onClose={() => setWizardOpen(false)} onSaved={() => void refresh()} />

      <footer>
        <span>{error ? `API unreachable: ${error}` : data ? `heartbeat ${s?.persistence === 'state-repo' ? 'durable' : 'ephemeral'}` : 'loading…'}</span>
        <span>refreshes every 5s · transcripts stream live</span>
      </footer>

      {toast && <div className="toast show">{toast}</div>}
    </>
  );
}
