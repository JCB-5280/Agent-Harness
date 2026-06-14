// primitives.tsx — THE ENTERPRISE SEAM.
//
// Every feature imports its visual building blocks from here and never touches raw
// HTML/styling directly. To adopt your internal enterprise component library, you
// reimplement these primitives against it (keeping the same prop signatures) and
// the entire dashboard inherits your design system — no feature code changes.
//
// Today they're plain elements styled by theme.css. The prop interfaces are the
// contract; honor them and the swap is a bounded, mechanical task.

import type { ReactNode, CSSProperties } from 'react';

/* Panel: a titled card with an optional info tooltip in the header. */
export function Panel(props: { title?: ReactNode; tip?: string; id?: string; children: ReactNode }) {
  return (
    <section className="panel" id={props.id}>
      {props.title && <h2>{props.title}{props.tip && <Info tip={props.tip} />}</h2>}
      {props.children}
    </section>
  );
}

/* Info: the "ⓘ" tooltip marker. */
export function Info({ tip }: { tip: string }) {
  return <span className="info" tabIndex={0} data-tip={tip} aria-label={tip}>ⓘ</span>;
}

/* Button: variants map to enterprise button kinds. */
export function Button(props: {
  children: ReactNode; onClick?: () => void; variant?: 'ghost' | 'primary' | 'link';
  disabled?: boolean; title?: string;
}) {
  const cls = props.variant === 'primary' ? 'btn-primary' : props.variant === 'link' ? 'rowbtn' : 'ghost';
  return <button className={cls} onClick={props.onClick} disabled={props.disabled} title={props.title}>{props.children}</button>;
}

/* Chip: status pill. The `tone` is derived from common status strings. */
const TONE: Record<string, string> = {
  done: 'done', success: 'done', failed: 'failed', failure: 'failed',
  blocked: 'blocked', timeout: 'blocked', queued: 'queued', in_progress: 'in_progress', running: 'running',
};
export function Chip({ label }: { label: string }) {
  return <span className={`chip ${TONE[label] ?? 'queued'}`}>{label}</span>;
}

/* Lamp: status indicator (loop heartbeat, persistence). */
export function Lamp({ state, label }: { state: 'on' | 'warn' | 'off'; label: string }) {
  return <span className={`lamp ${state}`}><i />{' '}{label}</span>;
}

/* SegmentedControl: the write-back toggle and similar. */
export function SegmentedControl<T extends string>(props: {
  value: T; options: { value: T; label: string }[]; onChange: (v: T) => void;
}) {
  return (
    <div className="seg" role="tablist">
      {props.options.map((o) => (
        <button key={o.value} role="tab" aria-selected={o.value === props.value}
          className={`seg-btn ${o.value === props.value ? 'on' : ''}`} onClick={() => props.onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* TextInput */
export function TextInput(props: {
  value?: string; placeholder?: string; type?: string; onChange?: (v: string) => void;
  onInput?: (v: string) => void; style?: CSSProperties; ariaLabel?: string;
}) {
  return (
    <input
      className="text-input" type={props.type ?? 'text'} value={props.value} placeholder={props.placeholder}
      style={props.style} aria-label={props.ariaLabel} autoComplete="off"
      onChange={(e) => { props.onChange?.(e.target.value); props.onInput?.(e.target.value); }}
    />
  );
}

/* Table: thin wrapper; columns + rows keep features declarative. */
export interface Column<R> { header: string; cell: (row: R) => ReactNode; mono?: boolean }
export function Table<R>(props: { columns: Column<R>[]; rows: R[]; rowKey: (r: R) => string | number; roleOf?: (r: R) => string; empty?: string }) {
  if (props.rows.length === 0) {
    return <table><tbody><tr><td className="mono" style={{ color: 'var(--muted)' }}>{props.empty ?? 'nothing yet'}</td></tr></tbody></table>;
  }
  return (
    <table>
      <thead><tr>{props.columns.map((c, i) => <th key={i}>{c.header}</th>)}</tr></thead>
      <tbody>
        {props.rows.map((r) => (
          <tr key={props.rowKey(r)} data-role={props.roleOf?.(r)}>
            {props.columns.map((c, i) => <td key={i} className={c.mono ? 'mono' : undefined}>{c.cell(r)}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* Dialog: modal. Controlled via `open`. */
export function Dialog(props: { open: boolean; title: ReactNode; onClose: () => void; children: ReactNode; bodyClassName?: string }) {
  if (!props.open) return null;
  return (
    <div className="dialog-backdrop" onClick={props.onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-bar"><strong>{props.title}</strong><Button variant="ghost" onClick={props.onClose}>Close</Button></div>
        <div className={props.bodyClassName}>{props.children}</div>
      </div>
    </div>
  );
}

/* Banner: callout strip (setup, needs-human). */
export function Banner(props: { tone: 'info' | 'warn'; children: ReactNode }) {
  return <section className={`banner banner-${props.tone}`}>{props.children}</section>;
}
