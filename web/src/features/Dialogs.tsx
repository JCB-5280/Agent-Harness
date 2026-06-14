import { useEffect, useState } from 'react';
import { Dialog, Button, TextInput } from '../ui/primitives';
import { api, isMock } from '../api/client';

// Live transcript viewer. Streams the session log over SSE (or shows a mock blob).
export function TranscriptDialog(props: { open: boolean; title: string; streamUrl: string | null; onClose: () => void }) {
  const [text, setText] = useState('');
  useEffect(() => {
    if (!props.open) return;
    if (isMock() || !props.streamUrl || props.streamUrl === '#') {
      setText('$ git status\nOn branch feat/task-117-csv-export\n[dev] reading registry: active_member.md (canonical)\n[dev] tests: 142 passed\n[dev] reconciliation vs membership-monthly: 0.3% (tol 0.5%) — PASS\n[dev] gh pr create → PR #42\nRESULT_JSON: {"status":"done",...}\n\n(mock transcript)');
      return;
    }
    setText('');
    const es = new EventSource(props.streamUrl);
    es.onmessage = (m) => setText((t) => t + m.data + '\n');
    return () => es.close();
  }, [props.open, props.streamUrl]);

  return (
    <Dialog open={props.open} title={`Transcript — ${props.title}`} onClose={props.onClose}>
      <pre id="log-body">{text || '(waiting for output…)'}</pre>
    </Dialog>
  );
}

type Step = 1 | 2 | 3;
export function SetupWizard(props: { open: boolean; secretStoreAvailable: boolean; onClose: () => void; onSaved: () => void }) {
  const [step, setStep] = useState<Step>(1);
  const [baseUrl, setBaseUrl] = useState('');
  const [email, setEmail] = useState('');
  const [token, setToken] = useState('');
  const [project, setProject] = useState('');
  const [jql, setJql] = useState('');
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  async function save() {
    if (!baseUrl.trim()) { setResult({ ok: false, msg: 'Base URL is required.' }); return; }
    try {
      await api.saveJira({ baseUrl: baseUrl.trim(), email: email.trim(), apiToken: token, projectKey: project.trim(), jql: jql.trim() });
      setResult({ ok: true, msg: 'Saved. You can now test the connection.' });
      setToken('');
      props.onSaved();
    } catch (e) { setResult({ ok: false, msg: e instanceof Error ? e.message : String(e) }); }
  }
  async function test() {
    setResult({ ok: true, msg: 'Testing…' });
    try {
      const r = await api.testJira() as { displayName?: string };
      setResult({ ok: true, msg: `Connected as ${r.displayName ?? 'user'}.` });
    } catch (e) { setResult({ ok: false, msg: e instanceof Error ? e.message : String(e) }); }
  }

  return (
    <Dialog open={props.open} title="Setup — connect Jira" onClose={props.onClose} bodyClassName="wizard-body">
      <ol className="wizard-steps">
        {(['Connection', 'Credentials', 'Scope & test'] as const).map((label, i) => (
          <li key={label} className={step === i + 1 ? 'active' : ''}>{label}</li>
        ))}
      </ol>

      {step === 1 && (
        <section className="wizard-step">
          <label>Jira base URL<TextInput value={baseUrl} placeholder="https://yourorg.atlassian.net" onChange={setBaseUrl} /></label>
          <p className="hint">Your Jira Cloud site URL. (Data Center differs — see the README.)</p>
          <div className="wizard-nav"><Button variant="primary" onClick={() => setStep(2)}>Next</Button></div>
        </section>
      )}
      {step === 2 && (
        <section className="wizard-step">
          {!props.secretStoreAvailable && (
            <div className="warn-inline">No master key (HARNESS_SECRET_KEY) is set, so the token can't be stored safely. Set it from your secret manager, or leave the token blank and provide it via the JIRA_API_TOKEN environment variable.</div>
          )}
          <label>Account email<TextInput value={email} placeholder="you@yourcorp.com" onChange={setEmail} /></label>
          <label>API token<TextInput type="password" value={token} placeholder="paste your Jira API token" onChange={setToken} /></label>
          <p className="hint">The token is encrypted before storage — only the ciphertext is kept, and only your environment's master key can decrypt it.</p>
          <div className="wizard-nav"><Button variant="ghost" onClick={() => setStep(1)}>Back</Button><Button variant="primary" onClick={() => setStep(3)}>Next</Button></div>
        </section>
      )}
      {step === 3 && (
        <section className="wizard-step">
          <label>Project key<TextInput value={project} placeholder="BI" onChange={setProject} /></label>
          <label>Issue filter (JQL) — optional<TextInput value={jql} placeholder='project = BI AND status = "Ready for Dev"' onChange={setJql} /></label>
          <div className="wizard-nav">
            <Button variant="ghost" onClick={() => setStep(2)}>Back</Button>
            <Button variant="primary" onClick={save}>Save</Button>
            <Button variant="ghost" onClick={test}>Test connection</Button>
          </div>
          {result && <div className={`wizard-result ${result.ok ? 'ok' : 'err'}`}>{result.msg}</div>}
        </section>
      )}
    </Dialog>
  );
}
