// ClearPathFBA — printable document view. One component renders all four
// assessment documents by docType:
//   report    -> GET /api/assessments/:id/report      (FBA report)
//   bip       -> GET /api/assessments/:id/bip         (Behavior Intervention Plan)
//   crisis    -> GET /api/assessments/:id/crisis-plan (Crisis Procedure)
//   dataSheet -> GET /api/assessments/:id/data-sheet  (blank observation sheets)
// All render with the same section/table/badge/signature styling and print via
// window.print() with the @media print CSS in styles.css. Charts are hand-rolled
// SVG (no chart library).
import React, { useEffect, useState, useCallback } from 'react';
import { api } from './api.js';
import ProgressReport from './ProgressReport.jsx';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDate = (v) => { if (!v) return '—'; const [y, m, d] = String(v).slice(0, 10).split('-').map(Number); return `${MONTHS[m - 1]} ${d}, ${y}`; };
const fmtDateTime = (v) => { if (!v) return '—'; const t = String(v).slice(11, 16); return fmtDate(v) + (t && /T\d\d:\d\d/.test(v) ? ` at ${t}` : ''); };
const r2 = (n) => (typeof n === 'number' ? (Math.round(n * 100) / 100).toString() : '—');
const num = (n) => (typeof n === 'number' ? n.toString() : '—');
const hasStats = (stats) => Object.keys(stats || {}).length > 0;
const pct = (n) => Math.round((n || 0) * 100);

const DOC_TYPES = [
 { key: 'report', label: 'FBA Report' },
 { key: 'bip', label: 'BIP' },
 { key: 'crisis', label: 'Crisis Plan' },
 { key: 'dataSheet', label: 'Data Sheet' },
 { key: 'progress', label: 'Progress Report' },
];
const DOC_META = {
 report: { eyebrow: 'FUNCTIONAL BEHAVIOR ASSESSMENT', fallback: 'FBA Report' },
 bip: { eyebrow: 'BEHAVIOR INTERVENTION PLAN', fallback: 'Behavior Intervention Plan' },
 crisis: { eyebrow: 'CRISIS PROCEDURE', fallback: 'Crisis Procedure' },
 dataSheet: { eyebrow: 'OBSERVATION DATA SHEET', fallback: 'Blank Data Collection Sheet' },
 progress: { eyebrow: 'PROGRESS REPORT', fallback: 'Progress Report' },
};

const SERIES_COLORS = ['#197d6b', '#2563eb', '#d97706', '#7c3aed', '#16a34a', '#b45309', '#64748b'];

// --- Frequency per day per behavior: SVG grouped bar chart ---
function FrequencyChart({ dates, series }) {
 if (!dates || !dates.length) return <p className="report-empty">No frequency-measured data points were recorded, so no frequency chart can be shown.</p>;
 const W = 720, H = 235, ML = 46, MR = 8, MT = 14, MB = 42;
 const plotW = W - ML - MR, plotH = H - MT - MB;
 const allVals = series.flatMap((s) => s.values);
 const yMax = Math.max(1, ...allVals.map((v) => Math.ceil(v / 5) * 5));
 const active = series.filter((s) => s.values.some((v) => v > 0));
 const m = Math.max(1, active.length);
 const groupW = plotW / dates.length;
 const barW = Math.min(30, (groupW / m) * 0.62);
 const y = (v) => MT + plotH - (v / yMax) * plotH;
 const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => ({ v: Math.round(yMax * f), y: y(yMax * f) }));
 return (
  <div className="chart">
   <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Frequency per day per behavior">
    {grid.map((g) => <g key={g.v}>
     <line x1={ML} x2={W - MR} y1={g.y} y2={g.y} className="chart-grid" />
     <text x={ML - 6} y={g.y + 3} className="chart-ylabel" textAnchor="end">{g.v}</text>
    </g>)}
    {dates.map((d, i) => {
     const cx = ML + groupW * i + groupW / 2;
     return <g key={d}>
      {active.map((s, j) => {
       const v = s.values[i];
       if (!v) return null;
       const bw = Math.max(2, barW);
       return <rect key={s.target_behavior_id} x={cx - (barW * m) / 2 + j * barW + (barW - bw) / 2} y={y(v)} width={bw} height={MT + plotH - y(v)} fill={SERIES_COLORS[j % SERIES_COLORS.length]} rx="1.5">
        <title>{`${s.target_behavior_name}: ${v} on ${fmtDate(d)}`}</title>
       </rect>;
      })}
      <text x={cx} y={H - 18} className="chart-xlabel" textAnchor="middle">{MONTHS[Number(d.slice(5, 7)) - 1]} {Number(d.slice(8, 10))}</text>
     </g>;
    })}
   </svg>
   <div className="chart-legend">
    {series.map((s, j) => <span key={s.target_behavior_id}><i style={{ background: SERIES_COLORS[j % SERIES_COLORS.length] }} />{s.target_behavior_name}</span>)}
   </div>
   <p className="chart-note">Frequency = sum of recorded frequency values per calendar day.</p>
  </div>
 );
}

// --- Horizontal bar list (top antecedents / consequences) ---
function HBars({ items, maxCount }) {
 if (!items || !items.length) return <span className="muted">none recorded</span>;
 const max = maxCount || Math.max(1, ...items.map((i) => i.count));
 return <div className="hbars">{items.map((it) => (
  <div className="hbar" key={it.code}>
   <span className="hbar-label">{it.label || it.code}</span>
   <span className="hbar-track"><span className="hbar-fill" style={{ width: `${Math.round((it.count / max) * 100)}%` }} /></span>
   <span className="hbar-count">{it.count}</span>
  </div>
 ))}</div>;
}

function Section({ n, title, children }) {
 return <section className="report-section"><h2><span className="sec-num">{n}</span>{title}</h2>{children}</section>;
}

function StatCell({ label, value }) {
 return <td><span className="stat-label">{label}</span><b>{value}</b></td>;
}

// --- Paper-ready signature lines. When a matching sign_offs row is signed, the
// line is filled with the in-app signature (typed name) + date; pending rows
// stay blank for wet ink. E-signature (cryptographic) is a later phase.
const DEFAULT_SIG_LINES = [
 { role: 'BCBA / Behavior Analyst', fields: ['Signature', 'Printed name & credentials', 'Date'] },
 { role: 'Parent / Guardian', fields: ['Signature', 'Printed name', 'Date'] },
];
function SignatureLines({ lines, signOffs }) {
 // Start from the document's standard lines (keyed by role_code), then overlay
 // any recorded sign-off rows — signed rows fill the line, pending rows keep a
 // blank line labelled with the awaited signatory, extra roles append a block.
 const std = lines && lines.length ? [...lines] : DEFAULT_SIG_LINES;
 const rows = [];
 const matched = new Set();
 for (const l of std) {
  const s = (signOffs || []).find((x) => x.signatory_role === l.role_code);
  if (s) { matched.add(s.id); rows.push({ ...s, role: s.signatory_role_label, fields: l.fields }); }
  else rows.push(l);
 }
 for (const s of signOffs || []) if (!matched.has(s.id)) rows.push({ ...s, role: s.signatory_role_label, fields: ['Signature', 'Printed name', 'Date'] });
 return (
  <div className="report-section signatures">
   <h2>Signatures</h2>
   <p className="sig-note">Signatures recorded in ClearPathFBA as an in-app sign-off record (typed name + date + role). Formal, legally-binding e-signature integration is pending — treat these as workflow sign-offs.</p>
   <div className="sig-grid">
    {rows.map((r, i) => (
     <div className="sig-block" key={r.id != null ? r.id : i}>
      <div className="sig-role">{r.role}</div>
      {r.status === 'signed' ? (
       <>
        <div className="sig-line filled">{r.signature || r.signatory_name}</div>
        <div className="sig-meta"><span>Signed in app by {r.signatory_name}</span><span>Date: {fmtDateTime(r.signed_at)}</span></div>
       </>
      ) : r.signatory_name ? (
       <>
        <div className="sig-line" />
        <div className="sig-meta"><span className="muted">Awaiting signature — {r.signatory_name} ({r.signatory_role_label})</span></div>
       </>
      ) : (
       <>
        <div className="sig-line" />
        <div className="sig-meta">{(r.fields || ['Signature', 'Printed name', 'Date']).map((f, j) => <span key={j}>{f}</span>)}</div>
       </>
      )}
     </div>
    ))}
   </div>
  </div>
 );
}

// --- In-app sign-off management panel (screen only, hidden when printing) ---
// Honest labelling: this is a signature RECORD, not a cryptographic e-signature.
const SIGN_OFF_DOC_TYPES = { report: 'fba_report', bip: 'bip', crisis: 'crisis_plan' };
const ROLE_OPTIONS = [
 { value: 'bcba', label: 'BCBA' },
 { value: 'guardian', label: 'Guardian' },
 { value: 'supervisor', label: 'Supervisor' },
 { value: 'other', label: 'Other' },
];
function SignOffPanel({ assessmentId, docType, docLabel, onChanged }) {
 const code = SIGN_OFF_DOC_TYPES[docType];
 const [rows, setRows] = useState(null);
 const [error, setError] = useState('');
 const [addRole, setAddRole] = useState('bcba');
 const [addName, setAddName] = useState('');
 const [busy, setBusy] = useState(false);
 const [signId, setSignId] = useState(null);
 const [signText, setSignText] = useState('');
 const load = useCallback(async () => {
  try {
   const r = await api(`/api/assessments/${assessmentId}/sign-offs?document_type=${code}`);
   setRows(r); setError('');
  } catch (e) { setError(e.message); }
 }, [assessmentId, code]);
 useEffect(() => { load(); }, [load]);
 const refresh = async () => { await load(); if (onChanged) onChanged(); };
 const add = async (e) => {
  e.preventDefault(); setError('');
  if (!addName.trim()) return setError('Signatory name is required.');
  setBusy(true);
  try {
   await api(`/api/assessments/${assessmentId}/sign-offs`, { method: 'POST', body: JSON.stringify({ document_type: code, signatory_role: addRole, signatory_name: addName.trim() }) });
   setAddName(''); await refresh();
  } catch (x) { setError(x.message); } finally { setBusy(false); }
 };
 const sign = async (row) => {
  setError('');
  if (!signText.trim()) return setError('Type the signatory name to sign.');
  setBusy(true);
  try {
   await api(`/api/sign-offs/${row.id}/sign`, { method: 'POST', body: JSON.stringify({ signature: signText.trim() }) });
   setSignId(null); setSignText(''); await refresh();
  } catch (x) { setError(x.message); } finally { setBusy(false); }
 };
 const revoke = async (row) => {
  if (!confirm(`Revoke the ${row.signatory_role_label} sign-off for ${row.signatory_name} on the ${docLabel}? The signature record is removed and the action is recorded in the audit trail.`)) return;
  setBusy(true);
  try { await api(`/api/sign-offs/${row.id}`, { method: 'DELETE' }); await refresh(); } catch (x) { setError(x.message); } finally { setBusy(false); }
 };
 const signedCount = (rows || []).filter((r) => r.status === 'signed').length;
 const allSigned = rows && rows.length > 0 && signedCount === rows.length;
 const usedRoles = new Set((rows || []).map((r) => r.signatory_role));
 return (
  <div className="signoff-panel no-print">
   <div className="signoff-head">
    <h3>Sign-offs — {docLabel}</h3>
    <span className="signoff-count">{signedCount}/{rows ? rows.length : '…'} signed</span>
   </div>
   <p className="card-hint">In-app signature record (typed name + date + role) tracked for this document. This is a workflow sign-off record, not a legally-binding electronic signature — formal e-signature integration is pending.</p>
   {error ? <div className="error">{error}</div> : null}
   {!rows ? <p className="muted">Loading signatories…</p> : rows.length === 0 ? <p className="empty card-hint">No signatories added yet for this document. Add one below.</p> : (
    <div className="signoff-list">
     {rows.map((r) => (
      <div className={'signoff-row ' + r.status} key={r.id}>
       <div className="signoff-info"><b>{r.signatory_role_label}</b><span>{r.signatory_name}</span></div>
       {r.status === 'signed' ? (
        <div className="signoff-state signed">
         <span className="signed-line">✓ Signed — {r.signatory_name}, {r.signatory_role_label}, {fmtDateTime(r.signed_at)}</span>
         <button className="small danger" onClick={() => revoke(r)}>Revoke</button>
        </div>
       ) : signId === r.id ? (
        <form className="signoff-form" onSubmit={(e) => { e.preventDefault(); sign(r); }}>
         <input autoFocus value={signText} onChange={(e) => setSignText(e.target.value)} placeholder="Type name to sign…" />
         <span className="signoff-date">Signed {fmtDate(new Date().toISOString())}</span>
         <button className="small primary" disabled={busy}>Sign &amp; date</button>
         <button type="button" className="small" onClick={() => { setSignId(null); setSignText(''); }}>Cancel</button>
        </form>
       ) : (
        <div className="signoff-state">
         <button className="small primary" onClick={() => { setSignId(r.id); setSignText(r.signatory_name); }}>Sign</button>
         <button className="small danger" onClick={() => revoke(r)}>Revoke</button>
        </div>
       )}
      </div>
     ))}
    </div>
   )}
   {allSigned ? <div className="signoff-all">✓ All signatures collected for this document.</div> : null}
   <form className="signoff-add" onSubmit={add}>
    <select value={addRole} onChange={(e) => setAddRole(e.target.value)} aria-label="Signatory role">
     {ROLE_OPTIONS.map((o) => <option key={o.value} value={o.value} disabled={usedRoles.has(o.value)}>{o.label}{usedRoles.has(o.value) ? ' (added)' : ''}</option>)}
    </select>
    <input value={addName} onChange={(e) => setAddName(e.target.value)} placeholder="Signatory name" aria-label="Signatory name" />
    <button className="small primary" disabled={busy}>＋ Add signatory</button>
   </form>
  </div>
 );
}

// ===========================================================================
// FBA REPORT sections
// ===========================================================================
function ReportSections({ doc }) {
 const { behaviors, data_summary, abc, hypotheses, data_quality, charts } = doc;
 const c = doc.client || {};
 const fullName = `${c.first_name || ''} ${c.last_name || ''}`.trim() || '—';
 const showStats = behaviors.some((b) => hasStats((data_summary.per_behavior_stats || []).find((s) => s.target_behavior_id === b.id)?.stats));

 return <>
  <Section n="1" title="Client & Assessment Information">
   <table className="report-table">
    <tbody>
     <tr><th>Client</th><td>{fullName}</td><th>Date of birth</th><td>{fmtDate(c.date_of_birth)}</td></tr>
     <tr><th>Gender</th><td>{c.gender || 'Not recorded'}</td><th>Consent status</th><td>{c.consent_status_label || c.consent_status || '—'}</td></tr>
     <tr><th>Assessment date</th><td>{fmtDate(doc.assessment.assessment_date)}</td><th>Status</th><td>{doc.assessment.status_label || doc.assessment.status}</td></tr>
     <tr><th>Assessor</th><td colSpan="3">{doc.assessment.assessor || 'Not recorded'}</td></tr>
    </tbody>
   </table>
   {doc.assessment.notes ? <div className="report-notes"><h3>Assessment notes</h3><p>{doc.assessment.notes}</p></div> : null}
  </Section>

  <Section n="2" title="Target Behaviors">
   {behaviors.length === 0
    ? <p className="report-empty">No target behaviors have been defined for this assessment.</p>
    : <table className="report-table">
     <thead><tr><th>Behavior</th><th>Safety classification</th><th>Baseline measurement</th><th>Operational definition</th></tr></thead>
     <tbody>{behaviors.map((b) => (
      <tr key={b.id}>
       <td><b>{b.name}</b></td>
       <td>{b.is_safety_concern ? <span className="safety-badge">⚠ {b.safety_classification_label || b.safety_classification}</span> : <span className="muted">None</span>}</td>
       <td>{b.baseline_measurement_type_label || <span className="muted">Not set</span>}</td>
       <td className="def-cell">{b.operational_definition}</td>
      </tr>
     ))}</tbody>
    </table>}
  </Section>

  <Section n="3" title="Data Collection Summary">
   {data_summary.total_points === 0
    ? <p className="report-empty">No data points have been recorded for this assessment.</p>
    : <>
     <div className="report-kpis">
      <div className="kpi"><b>{data_summary.total_points}</b><span>data points</span></div>
      <div className="kpi"><b>{fmtDate(data_summary.observation_start)}</b><span>observation start</span></div>
      <div className="kpi"><b>{fmtDate(data_summary.observation_end)}</b><span>observation end</span></div>
     </div>
     <h3>Counts by behavior</h3>
     <div className="summary-chips">{data_summary.per_behavior.map((x) => <span key={x.target_behavior_id}>{x.target_behavior_name}: <b>{x.count}</b></span>)}</div>
     <h3>Counts by measurement type</h3>
     <div className="summary-chips">{data_summary.per_measurement_type.map((x) => <span key={x.measurement_type}>{x.label}: <b>{x.count}</b></span>)}</div>
     {showStats && <>
      <h3>Descriptive statistics</h3>
      <table className="report-table stats-table">
       <thead><tr><th>Behavior</th><th>Measurement</th><th>n</th><th>Mean</th><th>Min</th><th>Max</th><th>Total</th></tr></thead>
       <tbody>{data_summary.per_behavior_stats.map((s) => Object.entries(s.stats).map(([type, st]) => (
        <tr key={`${s.target_behavior_id}-${type}`}>
         <td>{s.target_behavior_name}</td>
         <td>{type.charAt(0).toUpperCase() + type.slice(1)}</td>
         <td>{num(st.count)}</td>
         <td>{r2(st.mean)}</td>
         <td>{r2(st.min)}</td>
         <td>{r2(st.max)}</td>
         <td>{type === 'frequency' ? r2(st.total) : '—'}</td>
        </tr>
       )))}</tbody>
      </table>
     </>}
    </>}
  </Section>

  <Section n="4" title="Frequency per Day">
   <FrequencyChart dates={charts?.frequency_per_day?.dates} series={charts?.frequency_per_day?.series} />
  </Section>

  <Section n="5" title="ABC Analysis">
   {abc.length === 0
    ? <p className="report-empty">No target behaviors defined — nothing to analyze.</p>
    : abc.map((a) => (
     <div className="abc-block" key={a.target_behavior_id}>
      <h3>{a.target_behavior_name}</h3>
      <div className="abc-cols">
       <div className="abc-col"><h4>Top antecedents</h4><HBars items={a.top_antecedents} maxCount={a.top_antecedents[0]?.count} /></div>
       <div className="abc-col"><h4>Top consequences</h4><HBars items={a.top_consequences} maxCount={a.top_consequences[0]?.count} /></div>
      </div>
     </div>
    ))}
  </Section>

  <Section n="6" title="Function Hypotheses">
   {hypotheses.length === 0
    ? <p className="report-empty">No function hypotheses have been recorded for this assessment. Collect ABC data and run “Generate analysis” to produce rule-based hypotheses.</p>
    : hypotheses.map((h) => (
     <div className="report-hyp" key={h.target_behavior_id}>
      <div className="hyp-top">
       <div className="hyp-title"><b>{h.target_behavior_name}</b><div className="badges">
        <span className={'fn-badge ' + h.function}>{h.function_label || h.function}</span>
        {h.status === 'reviewed' ? <span className="reviewed-badge">✓ Reviewed</span> : <span className="draft-badge">Draft</span>}
       </div></div>
       <div className="conf"><small>Confidence</small>
        <div className="conf-bar"><div className="conf-fill" style={{ width: `${Math.round((h.confidence || 0) * 100)}%` }} /></div>
        <b>{Math.round((h.confidence || 0) * 100)}%</b>
       </div>
      </div>
      {h.interpretation ? <p className="hyp-interpretation">{h.interpretation}</p> : null}
      {h.rationale ? <div className="report-rationale"><span>Analysis rationale</span><p>{h.rationale}</p></div> : null}
      <div className="hyp-chips">
       <div><span className="chip-label">Top antecedents</span>{(h.top_antecedents || []).length ? h.top_antecedents.map((t) => <span className="chip" key={t.code}>{t.label || t.code} <b>{t.count}</b></span>) : <span className="muted">none recorded</span>}</div>
       <div><span className="chip-label">Top consequences</span>{(h.top_consequences || []).length ? h.top_consequences.map((t) => <span className="chip" key={t.code}>{t.label || t.code} <b>{t.count}</b></span>) : <span className="muted">none recorded</span>}</div>
      </div>
      <div className="hyp-meta"><span>Points analyzed: <b>{h.point_count || 0}</b></span><span>Full ABC context: <b>{Math.round((h.data_completeness || 0) * 100)}%</b></span></div>
      {(h.notes || []).map((n, i) => <p className="hyp-note" key={i}>⚠ {n}</p>)}
     </div>
    ))}
  </Section>

  <Section n="7" title="Data Quality Notes">
   <div className="report-dq">
    <p>Data completeness: <b>{Math.round((data_quality.data_completeness || 0) * 100)}%</b> of recorded data points include full ABC context.</p>
    {data_quality.notes && data_quality.notes.length
     ? <ul>{(data_quality.notes || []).map((n, i) => <li key={i}>{n}</li>)}</ul>
     : <p className="muted">No data quality concerns noted.</p>}
   </div>
  </Section>
 </>;
}

// ===========================================================================
// BIP sections
// ===========================================================================
function StrategyList({ items }) {
 return <ul className="strat-list">{(items || []).map((s, i) => (
  <li key={i}>{s.text} <span className="sugg-tag">{s.note}</span></li>
 ))}</ul>;
}

function BipSections({ doc }) {
 const behaviors = doc.behaviors || [];
 return <>
  <Section n="1" title="Target Behaviors & Hypothesized Functions">
   {behaviors.length === 0
    ? <p className="report-empty">No target behaviors have been defined for this assessment, so no intervention strategies can be generated. Define at least one target behavior (with an operational definition) to build this BIP.</p>
    : <table className="report-table">
     <thead><tr><th>Behavior</th><th>Safety</th><th>Hypothesized function</th><th>Operational definition</th></tr></thead>
     <tbody>{behaviors.map((b) => (
      <tr key={b.id}>
       <td><b>{b.name}</b></td>
       <td>{b.is_safety_concern ? <span className="safety-badge">⚠ {b.safety_classification_label}</span> : <span className="muted">None</span>}</td>
       <td>{b.hypothesized_function
        ? <span><span className={'fn-badge ' + b.hypothesized_function.function}>{b.hypothesized_function.function_label}</span> <span className="muted">({pct(b.hypothesized_function.confidence)}% · {b.hypothesized_function.status_label})</span></span>
        : <span className="muted">No hypothesis yet</span>}</td>
       <td className="def-cell">{b.operational_definition}</td>
      </tr>
     ))}</tbody>
    </table>}
  </Section>

  <Section n="2" title="Behavior Intervention Strategies">
   {behaviors.length === 0
    ? <p className="report-empty">Add target behaviors and run “Generate analysis” to produce function-based strategies.</p>
    : behaviors.map((b) => (
     <div className="report-hyp bip-block" key={b.id}>
      <div className="hyp-top">
       <div className="hyp-title"><b>{b.name}</b><div className="badges">
        {b.is_safety_concern ? <span className="safety-badge">⚠ {b.safety_classification_label}</span> : null}
        {b.hypothesized_function
         ? <span className={'fn-badge ' + b.hypothesized_function.function}>{b.hypothesized_function.function_label}</span>
         : <span className="draft-badge">No hypothesis</span>}
        {b.hypothesized_function ? (b.hypothesized_function.status === 'reviewed' ? <span className="reviewed-badge">✓ Reviewed</span> : <span className="draft-badge">Draft</span>) : null}
       </div></div>
       <div className="conf"><small>Hypothesis confidence</small>
        <div className="conf-bar"><div className="conf-fill" style={{ width: `${pct(b.hypothesized_function?.confidence)}%` }} /></div>
        <b>{pct(b.hypothesized_function?.confidence)}%</b>
       </div>
      </div>
      <p className="definition">{b.operational_definition}</p>
      {b.hypothesized_function
       ? <p className="hyp-interpretation">Strategies below are based on the hypothesized function <b>{b.hypothesized_function.function_label}</b> for this behavior.</p>
       : <p className="hyp-note">⚠ {b.hypothesis_status_note || 'No hypothesis yet — run “Generate analysis” once baseline data is collected.'}</p>}

      <h4>Antecedent (prevention) strategies</h4>
      <StrategyList items={b.antecedent_strategies} />

      <h4>Replacement skill</h4>
      <p className="strat-text">{b.replacement_skills.description}</p>
      <p className="muted strat-note">{b.replacement_skills.prompting_note}</p>
      <div className="rs-grid">
       <div className="rs-field"><span>Mastery criteria (BCBA to define)</span><div className="rs-line" /></div>
       <div className="rs-field"><span>Review interval (BCBA to define)</span><div className="rs-line" /></div>
      </div>

      <h4>Consequence strategies</h4>
      <StrategyList items={b.consequence_strategies} />

      <h4>Data collection plan</h4>
      <p className="strat-text">Measurement type: <b>{b.data_collection_plan.measurement_type_label || 'Not set'}</b></p>
      <p className="muted strat-note">{b.data_collection_plan.data_sheet_reference}</p>
     </div>
    ))}
  </Section>
 </>;
}

// ===========================================================================
// CRISIS PLAN sections
// ===========================================================================
function CrisisSections({ doc }) {
 const triggers = doc.trigger_behaviors || [];
 const roles = doc.roles || [];
 return <>
  <Section n="1" title="Trigger Behaviors & Crisis Guidance">
   {doc.has_triggers ? <>
    <table className="report-table">
     <thead><tr><th>Behavior</th><th>Safety classification</th><th>Hypothesized function</th><th>Operational definition</th></tr></thead>
     <tbody>{triggers.map((t) => (
      <tr key={t.id}>
       <td><b>{t.name}</b></td>
       <td><span className="safety-badge">⚠ {t.safety_classification_label}</span></td>
       <td>{t.hypothesized_function
        ? <span><span className={'fn-badge ' + t.hypothesized_function.function}>{t.hypothesized_function.function_label}</span> <span className="muted">({pct(t.hypothesized_function.confidence)}%)</span></span>
        : <span className="muted">No hypothesis yet</span>}</td>
       <td className="def-cell">{t.operational_definition}</td>
      </tr>
     ))}</tbody>
    </table>
    <h3>Behavior-specific guidance</h3>
    {triggers.map((t) => (
     <div className="abc-block" key={t.id}>
      <h3>{t.name} — {t.safety_classification_label}</h3>
      <p className="strat-text">{t.guidance}</p>
     </div>
    ))}
   </> : <p className="report-empty">{doc.empty_state_note}</p>}
  </Section>

  <Section n="2" title="Response Steps">
   <ol className="crisis-steps">{(doc.response_steps || []).map((s, i) => <li key={i}>{s}</li>)}</ol>
  </Section>

  <Section n="3" title="Crisis Response Roles">
   <p className="card-hint">Assign a role, named staff member, and duty for each team member involved in crisis response.</p>
   <table className="report-table">
    <thead><tr><th>Role</th><th>Name</th><th>Duty</th></tr></thead>
    <tbody>{roles.map((r, i) => (
     <tr key={i}><td className="blank-cell">{r.role}</td><td className="blank-cell">{r.name}</td><td className="blank-cell">{r.duty}</td></tr>
    ))}</tbody>
   </table>
  </Section>

  <Section n="4" title="Debrief">
   <ul className="crisis-steps">{(doc.debrief?.steps || []).map((s, i) => <li key={i}>{s}</li>)}</ul>
   <div className="rs-grid">
    <div className="rs-field"><span>Debrief date</span><div className="rs-line" /></div>
    <div className="rs-field"><span>Participants</span><div className="rs-line" /></div>
    <div className="rs-field wide"><span>Review notes</span><div className="rs-line tall" /></div>
   </div>
  </Section>

  <Section n="5" title="Escalation / Emergency Contacts">
   <p className="card-hint">Complete before the plan is finalized and keep current.</p>
   <div className="rs-grid">
    <div className="rs-field"><span>Primary contact (name / phone)</span><div className="rs-line" /></div>
    <div className="rs-field"><span>Secondary contact (name / phone)</span><div className="rs-line" /></div>
    <div className="rs-field"><span>Local emergency number</span><div className="rs-line" /></div>
   </div>
  </Section>
 </>;
}

// ===========================================================================
// DATA SHEET sections
// ===========================================================================
function DataSheetSections({ doc }) {
 const sheets = doc.sheets || [];
 return <>
  <p className="strat-text">{doc.observation_instructions}</p>
  {sheets.length === 0
   ? <p className="report-empty">No target behaviors have been defined for this assessment, so no data sheets can be printed. Define at least one target behavior and set a baseline measurement type (frequency, duration, or latency) to generate blank observation sheets.</p>
   : sheets.map((s, i) => (
    <div className={'ds-block' + (i === 0 ? ' first' : '')} key={s.behavior_id}>
     <h3>{s.behavior_name}</h3>
     <p className="strat-text"><b>Operational definition:</b> {s.operational_definition}</p>
     <p className="strat-text"><b>Measurement type:</b> {s.measurement_type_label} · <b>Record in:</b> {s.value_column_label}</p>
     <table className="report-table ds-table">
      <thead><tr><th>Date / Time</th><th>Setting</th><th>Antecedent</th><th>Consequence</th><th>{s.value_column_label}</th></tr></thead>
      <tbody>{s.rows.map((r, j) => (
       <tr key={j}><td className="ds-cell">{r.date_time}</td><td className="ds-cell">{r.setting}</td><td className="ds-cell">{r.antecedent}</td><td className="ds-cell">{r.consequence}</td><td className="ds-cell">{r.value}</td></tr>
      ))}</tbody>
     </table>
     <p className="chart-note">Observer: ________________________&nbsp;&nbsp;Date range: ____________________</p>
    </div>
   ))}
 </>;
}

// ===========================================================================
// Main document view
// ===========================================================================
export default function ReportView({ doc, docType, onBack, onSwitch, onRefreshDoc }) {
 if (!doc) return null;
 const { client, assessment, generated_at, is_preliminary } = doc;
 const c = client || {};
 const fullName = `${c.first_name || ''} ${c.last_name || ''}`.trim() || '—';
 const meta = DOC_META[docType] || DOC_META.report;
 const docTitle = docType === 'report' ? (assessment.title || meta.fallback) : `${assessment.title ? `${assessment.title} — ` : ''}${meta.fallback}`;
 const signable = docType !== 'dataSheet';
 const [downloading, setDownloading] = useState(false);
 // De-identified mode: refetch this document with ?deidentified=true and render
 // the PHI-stripped payload. Per-document toggle: resets when switching tabs,
 // persists nothing.
 const [deid, setDeid] = useState(false);
 const switchDoc = (t) => { setDeid(false); onSwitch(t); };
 const toggleDeid = async (checked) => { setDeid(checked); try { await onSwitch(docType, checked); } catch (e) { setDeid(!checked); alert(e.message); } };
 const downloadWord = async () => {
  setDownloading(true);
  try {
   const token = localStorage.getItem('clearpath_token');
   const path = (docType === 'progress' ? `/api/progress-reports/${doc.id}.docx` : `/api/assessments/${assessment.id}/${docType === 'report' ? 'report' : docType === 'dataSheet' ? 'data-sheet' : docType === 'crisis' ? 'crisis-plan' : 'bip'}.docx`) + (deid ? '?deidentified=true' : '');
   const r = await fetch(path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
   if (!r.ok) throw new Error('Unable to download Word document.');
   const b = await r.blob();
   const u = URL.createObjectURL(b);
   const a = document.createElement('a');
   a.href = u;
   const cd = r.headers.get('Content-Disposition') || '';
   const m = cd.match(/filename="?([^";]+)"?/i);
   a.download = m ? m[1] : 'ClearPathFBA.docx';
   document.body.appendChild(a); a.click(); a.remove();
   URL.revokeObjectURL(u);
  } catch (e) { alert(e.message); } finally { setDownloading(false); }
 };

 return (
  <div className="card report">
   <div className="report-toolbar no-print">
    <button className="link-back" onClick={onBack}>← Back to assessment</button>
    <button className="primary" onClick={() => window.print()}>🖨 Print / Save as PDF</button>
    {(docType !== 'progress' || doc.id) && <button className="secondary" disabled={downloading} onClick={downloadWord}>{downloading ? 'Preparing…' : 'Download Word'}</button>}
    <label className="deid-toggle" title="Fetch a PHI-stripped copy (no client/assessor/signatory names, no DOB, no free-text notes)">
     <input type="checkbox" checked={deid} onChange={(e) => toggleDeid(e.target.checked)} /> De-identified
    </label>
   </div>

   <div className="doc-tabs no-print" role="tablist">
    {DOC_TYPES.map((t) => (
     <button key={t.key} role="tab" aria-selected={docType === t.key} className={docType === t.key ? 'active' : ''} onClick={() => switchDoc(t.key)}>
      {t.label}
     </button>
    ))}
   </div>

   {signable
    ? (deid
      ? <p className="signoff-note no-print">Sign-off management is hidden while De-identified is on — signatory names are stripped from this view.</p>
      : <SignOffPanel assessmentId={assessment.id} docType={docType} docLabel={meta.fallback} onChanged={onRefreshDoc} />)
    : <p className="signoff-note no-print">Data sheets are capture forms and carry no signatures. Open the FBA Report, BIP, or Crisis Plan to manage sign-offs.</p>}

   {doc.deidentified ? <div className="deid-banner"><b>⚠ DE-IDENTIFIED</b><span>{doc.deidentified_header || 'FOR SUPERVISION/RESEARCH ONLY, NOT A TREATMENT RECORD'}</span></div> : null}

   <div className="report-header">
    <div className="eyebrow">{meta.eyebrow}</div>
    <h1>{docTitle}</h1>
    <div className="report-sub">{fullName} · Generated {fmtDate(generated_at)}</div>
    {is_preliminary ? <span className="prelim-badge">PRELIMINARY — not yet finalized</span> : <span className="final-badge">Final document</span>}
   </div>

   {docType === 'report' && <ReportSections doc={doc} />}
   {docType === 'bip' && <BipSections doc={doc} />}
   {docType === 'crisis' && <CrisisSections doc={doc} />}
   {docType === 'dataSheet' && <DataSheetSections doc={doc} />}
   {docType === 'progress' && <ProgressReport doc={doc} />}

   {signable && <SignatureLines lines={doc.signatures} signOffs={doc.sign_offs} />}

   <p className="report-footer">Generated by ClearPathFBA · {fmtDateTime(generated_at)} · This document reflects the data recorded in the system at the time of generation.</p>
  </div>
 );
}
