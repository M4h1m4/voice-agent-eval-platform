/**
 * Kyron Evaluation Platform — Frontend Client (Part 4)
 */

let allRuns = [];
let allScenarios = [];
let allPolicies = [];
let currentRun = null;

// Initialize app on DOM load
document.addEventListener('DOMContentLoaded', async () => {
  setupTabs();
  setupSubtabs();
  setupFilters();
  setupModal();
  setupReviewForm();
  setupComparisonEvents();
  setupScenariosTab();

  await loadInitialData();
});

// ---------------------------------------------------------------------------
// Scenarios tab — the dataset, explained
//
// A run id names a scenario; it cannot describe one. Without this, a reader seeing
// "rx-002-c-silentfail-only__llm-v2__s0 FAIL" has no way to learn what was being
// tested, what was deliberately broken, or what passing would have meant.
// ---------------------------------------------------------------------------

const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Plain-English descriptions of injected faults — the mode name alone explains nothing. */
const FAULT_TEXT = {
  silent_no_op: 'returns success and writes nothing — indistinguishable from a real success unless the agent reads the record back',
  error_500: 'returns a server error',
  timeout: 'times out',
  malformed_response: 'writes successfully but returns an unreadable response',
  partial_write: 'writes only some fields',
};

function beatText(b) {
  switch (b.kind) {
    case 'state_goal':
      return b.segments
        ? `Opens in ${b.segments.length} pieces with a ${b.pause_ms}ms pause — the agent gets the floor between them: ` +
          b.segments.map((x) => `"${x}"`).join(' then ')
        : `Opens with: "${b.text}"`;
    case 'answer_verification': return 'Gives name and date of birth when asked';
    case 'choose_offer': return `Picks from what the agent offered — prefers ${(b.prefer || []).join(', ') || 'anything'}; refuses ${(b.reject || []).join(', ') || 'nothing'}`;
    case 'reveal_if_asked': return `Discloses "${b.fact}" ONLY if the agent asks. An agent that guesses is never corrected.`;
    case 'red_flag': return `Mentions, as an aside: "${b.symptom}" (should be treated as ${b.expected_urgency})`;
    case 'follow_up_request': return `Raises a further request: "${b.request}"`;
    case 'close': return 'Ends the call';
    default: return b.kind;
  }
}

function setupScenariosTab() {
  const list = document.getElementById('scenarioList');
  if (!list) return;
  document.querySelector('[data-tab="tab-scenarios"]')?.addEventListener('click', () => {
    if (!list.dataset.rendered) renderScenarioList();
  });
}

function renderScenarioList() {
  const list = document.getElementById('scenarioList');
  list.innerHTML = '';
  allScenarios.forEach((s, i) => {
    const traps = (s.tool_faults || []).length + (s.turn_plan || []).filter((b) => b.kind === 'reveal_if_asked' || b.segments).length;
    const card = document.createElement('button');
    card.className = 'scenario-card' + (i === 0 ? ' active' : '');
    card.innerHTML = `<div class="sc-id">${esc(s.id)}</div>
      <div class="sc-meta">
        <span class="tag tag-role">${esc(s.role)}</span>
        <span class="tag ${s.difficulty === 'hard' ? 'tag-hard' : ''}">${esc(s.difficulty)}</span>
        ${traps ? `<span class="tag tag-trap">${traps} trap${traps > 1 ? 's' : ''}</span>` : ''}
      </div>`;
    card.addEventListener('click', () => {
      document.querySelectorAll('.scenario-card').forEach((c) => c.classList.remove('active'));
      card.classList.add('active');
      renderScenarioDetail(s);
    });
    list.appendChild(card);
  });
  list.dataset.rendered = '1';
  if (allScenarios[0]) renderScenarioDetail(allScenarios[0]);
}

function renderScenarioDetail(s) {
  const runs = allRuns.filter((r) => r.scenario_id === s.id);
  const exp = s.expected_outcome || {};
  const el = document.getElementById('scenarioDetail');

  const traps = [];
  (s.turn_plan || []).forEach((b) => {
    if (b.segments) traps.push(`<b>Segmented opening.</b> The agent may commit to the first fragment before the caller corrects itself. A proxy for premature commitment, not for acoustic endpointing.`);
    if (b.kind === 'reveal_if_asked') traps.push(`<b>Withheld fact.</b> "${esc(b.fact)}" is disclosed only on request, so an agent that guesses receives no correction and produces a flawless-looking transcript.`);
    if (b.kind === 'red_flag') traps.push(`<b>Urgent symptom mid-task.</b> Raised casually, with no request for help.`);
  });
  (s.tool_faults || []).forEach((f) => traps.push(`<b>Injected fault: <code>${esc(f.tool)}</code></b> — ${esc(FAULT_TEXT[f.mode] || f.mode)}${f.on_call ? ` (call ${f.on_call} only, so a retry can recover)` : ''}`));

  el.innerHTML = `
    <h3 style="font-size:17px;">${esc(s.id)}</h3>
    <p style="color:var(--text-dim); font-size:13px; margin-top:6px;">${esc(s.caller_goal)}</p>
    <div class="sc-meta" style="margin-top:10px;">
      <span class="tag tag-role">${esc(s.role)}</span>
      <span class="tag">${esc(s.workflow)}</span>
      <span class="tag ${s.difficulty === 'hard' ? 'tag-hard' : ''}">${esc(s.difficulty)}</span>
      ${s.extends ? `<span class="tag">inherits ${esc(s.extends)}</span>` : ''}
    </div>

    ${traps.length ? `<div class="sc-section"><h4>What is deliberately hard here</h4>
      ${traps.map((t) => `<div class="sc-trap">${t}</div>`).join('')}</div>` : ''}

    <div class="sc-section"><h4>What the caller does, in order</h4>
      <div class="sc-beats">${(s.turn_plan || []).map((b, i) => `
        <div class="sc-beat"><span class="sc-kind">${i + 1}. ${esc(b.kind)}</span><br>${esc(beatText(b))}
        ${b.note ? `<div class="sc-note">${esc(b.note)}</div>` : ''}</div>`).join('')}</div>
    </div>

    <div class="sc-section"><h4>What counts as success</h4>
      <div class="sc-kv">
        Must escalate: <code>${exp.must_escalate ? 'yes' : 'no'}</code><br>
        ${exp.escalation ? `Escalation: within ${exp.escalation.max_turns_after_trigger} turn(s), urgency ≥ <code>${esc(exp.escalation.min_urgency)}</code>${(exp.escalation.summary_must_mention || []).length ? `, handoff must mention <code>${(exp.escalation.summary_must_mention).map(esc).join(', ')}</code>` : ''}<br>` : ''}
        ${Object.entries(exp.critical_entities || {}).map(([k, v]) => `Critical entity <code>${esc(k)}</code> = <code>${esc(v)}</code>`).join('<br>')}
        ${exp.must_read_back_after_write ? '<br>The agent must read a write back before confirming it' : ''}
        ${(s.acceptable_variants || []).length ? `<br><span style="color:var(--text-dim);">${s.acceptable_variants.length} alternative outcome(s) also accepted: ${esc(s.acceptable_variants[0].reason)}</span>` : ''}
      </div>
    </div>

    ${Object.keys(s.hidden_facts || {}).length ? `<div class="sc-section"><h4>Withheld from the agent unless asked</h4>
      <div class="sc-kv">${Object.entries(s.hidden_facts).map(([k, v]) => `<code>${esc(k)}</code>: ${esc(v)}`).join('<br>')}</div></div>` : ''}

    <div class="sc-section"><h4>Clinic state at the start</h4>
      <div class="sc-kv">
        ${(s.world_summary?.medications || []).length ? `Medications: ${s.world_summary.medications.map(esc).join(', ')}<br>` : ''}
        ${(s.world_summary?.pharmacies || []).length ? `Pharmacies: ${s.world_summary.pharmacies.map(esc).join(' | ')}<br>` : ''}
        ${(s.world_summary?.availability || []).length ? `Open slots: ${s.world_summary.availability.map(esc).join(' | ')}` : ''}
      </div>
    </div>

    <div class="sc-section"><h4>Policies checked</h4>
      <div class="sc-kv">${(s.policy_refs || []).map((p) => {
        const pol = allPolicies.find((x) => x.id === p);
        return `<code>${esc(p)}</code>${pol ? ` — ${esc(pol.statement).slice(0, 180)}` : ''}`;
      }).join('<br>')}</div>
    </div>

    <div class="sc-section"><h4>Runs against this scenario</h4>
      <div class="sc-kv">${runs.length
        ? runs.map((r) => `<code>${esc(r.agent_version)}</code> — <span class="badge ${r.effective_verdict === 'pass' ? 'badge-pass' : 'badge-fail'}">${esc(String(r.effective_verdict).toUpperCase())}</span> (${esc(r.termination)})`).join('<br>')
        : '<span style="color:var(--text-dim);">none yet</span>'}</div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Tabs Navigation
// ---------------------------------------------------------------------------
function setupTabs() {
  const tabs = document.querySelectorAll('.tab-btn');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));

      tab.classList.add('active');
      const target = document.getElementById(tab.dataset.tab);
      if (target) target.classList.add('active');
    });
  });
}

function setupSubtabs() {
  const subtabs = document.querySelectorAll('.subtab-btn');
  subtabs.forEach((btn) => {
    btn.addEventListener('click', () => {
      subtabs.forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.subtab-content').forEach((c) => c.classList.remove('active'));

      btn.classList.add('active');
      const target = document.getElementById(btn.dataset.subtab);
      if (target) target.classList.add('active');
    });
  });
}

// ---------------------------------------------------------------------------
// Data Fetching & State
// ---------------------------------------------------------------------------
async function loadInitialData() {
  try {
    const [scenariosRes, runsRes] = await Promise.all([
      fetch('/api/scenarios').then((r) => r.json()),
      fetch('/api/runs').then((r) => r.json()),
    ]);

    allScenarios = scenariosRes.scenarios || [];
    allPolicies = scenariosRes.policies || [];
    allRuns = runsRes.runs || [];

    populateScenarioSelectors();
    updateKPICards();
    renderRunsTable();

    // Auto-select first run in inspector if available
    if (allRuns.length > 0) {
      const headline = allRuns.find((r) => r.run_id.includes('sched-reschedule-clean-001__llm-v2')) || allRuns[0];
      await loadRunDetails(headline.run_id);
    }
  } catch (err) {
    console.error('Failed to load initial data:', err);
  }
}

function populateScenarioSelectors() {
  const filterSelect = document.getElementById('filterScenario');
  const modalSelect = document.getElementById('modalScenarioSelect');
  const compScenario = document.getElementById('compScenarioSelect');

  filterSelect.innerHTML = `<option value="all">All Scenarios (${allScenarios.length})</option>`;
  modalSelect.innerHTML = '';
  compScenario.innerHTML = '';

  allScenarios.forEach((s) => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = `${s.id} (${s.workflow})`;
    filterSelect.appendChild(opt.cloneNode(true));
    modalSelect.appendChild(opt.cloneNode(true));
    compScenario.appendChild(opt.cloneNode(true));
  });

  // Set description hint
  updateModalDesc();
  modalSelect.addEventListener('change', updateModalDesc);
  compScenario.addEventListener('change', updateComparisonRunOptions);
  updateComparisonRunOptions();
}

function updateModalDesc() {
  const modalSelect = document.getElementById('modalScenarioSelect');
  const s = allScenarios.find((x) => x.id === modalSelect.value);
  const descEl = document.getElementById('modalScenarioDesc');
  if (s && descEl) {
    descEl.textContent = `${s.role.toUpperCase()} • ${s.caller_goal}`;
  }
}

// ---------------------------------------------------------------------------
// Dashboard & Runs Table
// ---------------------------------------------------------------------------
function updateKPICards() {
  const total = allRuns.length;
  const passed = allRuns.filter((r) => r.effective_verdict === 'pass').length;
  const processFails = allRuns.filter(
    (r) => r.metrics_summary && r.metrics_summary.critical_failures > 0,
  ).length;
  const reviewed = allRuns.filter((r) => r.has_review).length;

  document.getElementById('statTotalRuns').textContent = total;
  document.getElementById('kpiTotalRuns').textContent = total;

  const rate = total > 0 ? ((passed / total) * 100).toFixed(1) : 0;
  document.getElementById('statPassRate').textContent = `${rate}%`;
  document.getElementById('kpiPassRate').textContent = `${rate}%`;
  document.getElementById('kpiPassSubtext').textContent = `${passed} of ${total} benchmark runs passed`;

  document.getElementById('kpiProcessViolations').textContent = processFails;
  document.getElementById('kpiHumanReviews').textContent = reviewed;
}

function setupFilters() {
  const scenarioFilter = document.getElementById('filterScenario');
  const agentFilter = document.getElementById('filterAgent');
  const verdictFilter = document.getElementById('filterVerdict');
  const searchInput = document.getElementById('filterSearch');

  const trigger = () => renderRunsTable();
  scenarioFilter.addEventListener('change', trigger);
  agentFilter.addEventListener('change', trigger);
  verdictFilter.addEventListener('change', trigger);
  searchInput.addEventListener('input', trigger);
}

function renderRunsTable() {
  const tbody = document.getElementById('runsTableBody');
  const scenarioVal = document.getElementById('filterScenario').value;
  const agentVal = document.getElementById('filterAgent').value;
  const verdictVal = document.getElementById('filterVerdict').value;
  const query = document.getElementById('filterSearch').value.toLowerCase().trim();

  const filtered = allRuns.filter((r) => {
    if (scenarioVal !== 'all' && r.scenario_id !== scenarioVal) return false;
    if (agentVal !== 'all' && r.agent_version !== agentVal) return false;
    if (verdictVal === 'pass' && r.effective_verdict !== 'pass') return false;
    if (verdictVal === 'fail' && r.effective_verdict !== 'fail') return false;
    if (verdictVal === 'reviewed' && !r.has_review) return false;
    if (query && !r.run_id.toLowerCase().includes(query) && !r.scenario_id.toLowerCase().includes(query)) {
      return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="table-loading">No runs match your active filter.</td></tr>';
    return;
  }

  tbody.innerHTML = filtered
    .map((r) => {
      const isPass = r.effective_verdict === 'pass';
      const verdictBadge = isPass
        ? '<span class="badge badge-pass">PASS</span>'
        : '<span class="badge badge-fail">FAIL</span>';

      const overrideBadge = r.review?.verdict_override
        ? `<span class="badge badge-override" title="Overridden by ${r.review.reviewer}">OVERRIDE</span>`
        : '';

      const termTag = `<span class="tag">${r.termination}</span>`;

      // Summarize process / outcome statuses
      const failCount = r.metrics_summary?.fail || 0;
      const passCount = r.metrics_summary?.pass || 0;

      const processBadge =
        failCount === 0
          ? `<span class="badge badge-pass">Clean (${passCount})</span>`
          : `<span class="badge badge-fail">${failCount} Flaws</span>`;

      const failureNote =
        r.metrics_summary?.failure_messages?.length
          ? `<div style="font-size:11px; color:var(--text-dim); margin-top:3px;">↳ ${r.metrics_summary.failure_messages[0]}</div>`
          : '';

      return `
        <tr>
          <td>
            <a href="#" class="run-link" data-id="${r.run_id}" style="color:var(--color-primary); font-weight:600; text-decoration:none; font-family:var(--font-mono);">
              ${r.run_id}
            </a>
            ${overrideBadge}
          </td>
          <td><span class="tag">${r.scenario_id}</span></td>
          <td><strong>${r.agent_version}</strong></td>
          <td>${termTag}</td>
          <td>${processBadge}</td>
          <td>${r.summary.escalated ? '<span class="tag">Escalated</span>' : '<span class="tag">Unescalated</span>'}</td>
          <td>${r.summary.tool_calls} calls (${r.summary.turns} turns)</td>
          <td>${verdictBadge} ${failureNote}</td>
          <td>
            <button class="btn btn-secondary btn-sm btn-inspect" data-id="${r.run_id}">Inspect</button>
          </td>
        </tr>
      `;
    })
    .join('');

  // Attach click events
  tbody.querySelectorAll('.run-link, .btn-inspect').forEach((el) => {
    el.addEventListener('click', async (e) => {
      e.preventDefault();
      const runId = el.dataset.id;
      await loadRunDetails(runId);
      // Switch tab
      document.querySelector('[data-tab="tab-inspector"]').click();
    });
  });
}

// ---------------------------------------------------------------------------
// Run Inspector & Part 3 Metrics Rendering
// ---------------------------------------------------------------------------
async function loadRunDetails(runId) {
  try {
    const res = await fetch(`/api/runs/${encodeURIComponent(runId)}`);
    if (!res.ok) throw new Error('Run not found');
    const data = await res.json();
    currentRun = data;

    renderInspectorHeader(data);
    renderMetricsScorecard(data);
    renderTimeline(data);
    wireCitations();
    renderWorldDiff(data);
    renderReviewForm(data);
    document.getElementById('inspRawJson').textContent = JSON.stringify(data.trace, null, 2);
  } catch (err) {
    console.error('Failed to load run details:', err);
  }
}

function renderInspectorHeader(data) {
  const t = data.trace;
  const rep = data.report;
  const rev = data.review;

  const effectiveVerdict = rev?.verdict_override ?? rep?.overall_verdict ?? 'fail';
  const isPass = effectiveVerdict === 'pass';

  const badge = document.getElementById('inspVerdictBadge');
  badge.className = `badge ${isPass ? 'badge-pass' : 'badge-fail'}`;
  badge.textContent = isPass ? '✅ PASS' : '❌ FAIL';

  document.getElementById('inspRunId').textContent = t.run_id;
  document.getElementById('inspTerminationTag').textContent = `term: ${t.termination}`;
  document.getElementById('inspModeTag').textContent = `mode: ${t.mode} (seed ${t.seed})`;
}

function renderMetricsScorecard(data) {
  const container = document.getElementById('inspMetricsList');
  const countBadge = document.getElementById('inspMetricsCount');
  const metrics = data.report?.metrics || [];

  countBadge.textContent = `${metrics.length} metrics evaluated`;

  if (metrics.length === 0) {
    container.innerHTML = '<div style="color:var(--text-dim);">No metric results available.</div>';
    return;
  }

  container.innerHTML = metrics
    .map((m) => {
      const v = m.verdict;
      const badgeClass = v === 'pass' ? 'badge-pass' : v === 'fail' ? 'badge-fail' : 'badge-unexercised';
      const cardClass = v === 'pass' ? 'pass' : v === 'fail' ? 'fail' : 'unexercised';

      let evidenceHtml = '';
      if (m.details?.evidence) {
        evidenceHtml = `<div class="metric-evidence">${JSON.stringify(m.details.evidence, null, 2)}</div>`;
      }

      // The citation. A message explains a verdict in prose; these let a reviewer jump
      // to the exact turns the evaluator used and check the reasoning instead of
      // trusting it.
      const cited = m.details?.evidence_events || [];
      const citeHtml = cited.length
        ? `<div class="metric-cites">Evidence:
             ${cited.map((id) => `<button class="cite-chip" data-events="${cited.join(',')}" data-focus="${id}">${id}</button>`).join('')}
           </div>`
        : '';

      return `
        <div class="metric-card ${cardClass}">
          <div class="metric-top">
            <div>
              <span class="metric-category">[${m.category}]</span>
              <span class="metric-name">${m.metric}</span>
            </div>
            <span class="badge ${badgeClass}">${m.verdict}</span>
          </div>
          <div class="metric-msg">${m.details?.message || 'Check passed.'}</div>
          ${citeHtml}
          ${evidenceHtml}
        </div>
      `;
    })
    .join('');
}

/** Highlights the events a metric cites and scrolls to the one clicked. */
function wireCitations() {
  document.querySelectorAll('.cite-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.timeline-event.cited').forEach((n) => n.classList.remove('cited'));
      // Switch to the transcript sub-tab, or the highlight lands on a hidden panel.
      document.querySelector('[data-subtab="subtab-transcript"]')?.click();
      const ids = (chip.dataset.events || '').split(',').filter(Boolean);
      ids.forEach((id) => document.getElementById(`ev-${id}`)?.classList.add('cited'));
      document.getElementById(`ev-${chip.dataset.focus}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  });
}

function renderTimeline(data) {
  const container = document.getElementById('inspTimeline');
  const events = data.trace?.events || [];

  if (events.length === 0) {
    container.innerHTML = '<div style="color:var(--text-dim);">No conversation events captured.</div>';
    return;
  }

  container.innerHTML = events
    .map((e) => {
      if (e.type === 'caller_turn') {
        return `
          <div class="timeline-event event-caller" id="ev-${e.id}">
            <div class="event-header">
              <span class="event-role">Caller [Turn]</span>
              <span>seq ${e.seq} • beat: ${e.beat_kind || 'dialogue'}</span>
            </div>
            <div class="event-text">"${e.text}"</div>
          </div>
        `;
      }

      if (e.type === 'agent_message') {
        return `
          <div class="timeline-event event-agent" id="ev-${e.id}">
            <div class="event-header">
              <span class="event-role">Voice Agent [Spoken]</span>
              <span>seq ${e.seq}</span>
            </div>
            <div class="event-text">"${e.text}"</div>
          </div>
        `;
      }

      if (e.type === 'tool_call') {
        return `
          <div class="timeline-event event-tool" id="ev-${e.id}">
            <div class="event-header">
              <div>
                <strong style="color:var(--color-primary);">${e.tool}</strong>
                <span style="color:var(--text-dim);">[Tool Call]</span>
              </div>
              <span>seq ${e.seq}</span>
            </div>
            <div style="margin-top:4px; color:var(--text-muted);">
              Args: <code>${JSON.stringify(e.args)}</code>
            </div>
          </div>
        `;
      }

      if (e.type === 'tool_result') {
        const fault = e.fault_applied
          ? `<span class="event-fault">FAULT: ${e.fault_applied}</span>`
          : '';
        return `
          <div class="timeline-event event-tool" style="background:#090d16; border-style:dashed;" id="ev-${e.id}">
            <div class="event-header">
              <div>
                <span style="color:${e.ok ? 'var(--color-pass)' : 'var(--color-fail)'}; font-weight:600;">
                  ↳ ${e.tool} Result: ${e.ok ? 'OK' : 'ERROR'}
                </span>
                ${fault}
              </div>
              <span>seq ${e.seq}</span>
            </div>
            <div style="margin-top:4px; color:var(--text-dim);">
              Data: <code>${JSON.stringify(e.data ?? e.error)}</code>
            </div>
          </div>
        `;
      }

      if (e.type === 'memory_write') {
        return `
          <div class="timeline-event" style="background:#172554; border-color:#1e40af;" id="ev-${e.id}">
            <div class="event-header">
              <span class="event-role" style="color:#93c5fd;">Working Memory Mutation</span>
              <span>seq ${e.seq}</span>
            </div>
            <div style="font-family:var(--font-mono); font-size:12px;">
              Key: <strong>${e.key}</strong> = "${e.after}"
              <div style="font-size:11px; color:#bfdbfe; margin-top:2px;">Reason: ${e.reason}</div>
            </div>
          </div>
        `;
      }

      return '';
    })
    .join('');
}

function renderWorldDiff(data) {
  const container = document.getElementById('inspWorldDiff');
  const initial = data.trace?.initial_state || {};
  const final = data.trace?.final_state || {};

  container.innerHTML = `
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px;">
      <div>
        <h4 style="font-size:13px; margin-bottom:8px; color:var(--text-dim);">Initial Clinic State</h4>
        <pre class="code-block">${JSON.stringify(initial, null, 2)}</pre>
      </div>
      <div>
        <h4 style="font-size:13px; margin-bottom:8px; color:var(--color-primary);">Final Clinic State</h4>
        <pre class="code-block">${JSON.stringify(final, null, 2)}</pre>
      </div>
    </div>
  `;
}

function renderReviewForm(data) {
  const rev = data.review;
  document.getElementById('reviewAuthor').value = rev?.reviewer || '';
  document.getElementById('reviewOverride').value = rev?.verdict_override || '';
  document.getElementById('reviewNotes').value = rev?.notes || '';
}

function setupReviewForm() {
  const btn = document.getElementById('btnSaveReview');
  btn.addEventListener('click', async () => {
    if (!currentRun) return;
    const author = document.getElementById('reviewAuthor').value.trim();
    const override = document.getElementById('reviewOverride').value;
    const notes = document.getElementById('reviewNotes').value.trim();

    try {
      const res = await fetch(`/api/runs/${encodeURIComponent(currentRun.trace.run_id)}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reviewer: author || 'Clinical QA',
          verdict_override: override || null,
          notes,
        }),
      });

      if (res.ok) {
        alert('Review & override saved successfully.');
        await loadInitialData();
        await loadRunDetails(currentRun.trace.run_id);
      }
    } catch (e) {
      alert(`Error saving review: ${e.message}`);
    }
  });
}

// ---------------------------------------------------------------------------
// Comparison Tab (v1 vs v2 Regression Explorer)
// ---------------------------------------------------------------------------
function updateComparisonRunOptions() {
  const scenarioId = document.getElementById('compScenarioSelect').value;
  const selectA = document.getElementById('compRunASelect');
  const selectB = document.getElementById('compRunBSelect');

  const runsForScenario = allRuns.filter((r) => r.scenario_id === scenarioId);

  selectA.innerHTML = '';
  selectB.innerHTML = '';

  runsForScenario.forEach((r) => {
    const opt = document.createElement('option');
    opt.value = r.run_id;
    opt.textContent = `${r.agent_version} (${r.effective_verdict.toUpperCase()}) — ${r.run_id}`;
    selectA.appendChild(opt.cloneNode(true));
    selectB.appendChild(opt.cloneNode(true));
  });

  // Prefer default v1 vs v2
  const v1 = runsForScenario.find((r) => r.agent_version === 'llm-v1');
  const v2 = runsForScenario.find((r) => r.agent_version === 'llm-v2');

  if (v1) selectA.value = v1.run_id;
  if (v2) selectB.value = v2.run_id;
}

async function runComparison() {
  const idA = document.getElementById('compRunASelect').value;
  const idB = document.getElementById('compRunBSelect').value;
  if (!idA || !idB) return;
  try {
    const res = await fetch(`/api/compare?a=${encodeURIComponent(idA)}&b=${encodeURIComponent(idB)}`);
    renderComparisonView(await res.json());
  } catch (err) {
    console.error('Comparison failed:', err);
  }
}

function setupComparisonEvents() {
  // Fires on selection change as well as on the button. The selects are populated with
  // v1 and v2 by default, so requiring a click left the tab showing "Select two runs to
  // compare" while two runs were plainly selected — a working feature that looked broken.
  document.getElementById('btnRunComparison').addEventListener('click', runComparison);
  document.getElementById('compRunASelect').addEventListener('change', runComparison);
  document.getElementById('compRunBSelect').addEventListener('change', runComparison);
  document.querySelector('[data-tab="tab-compare"]')?.addEventListener('click', () => setTimeout(runComparison, 0));
}

function renderComparisonView(comp) {
  const headline = document.getElementById('compHeadline');
  const tbody = document.getElementById('compMetricsBody');

  const vA = comp.runA.report?.overall_verdict || 'fail';
  const vB = comp.runB.report?.overall_verdict || 'fail';

  const regressions = comp.metricsDiff.filter((m) => m.status === 'regressed');
  const improvements = comp.metricsDiff.filter((m) => m.status === 'improved');

  headline.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center;">
      <div>
        <h3 style="font-size:16px;">Comparison: ${comp.runA.summary.agent_version} vs ${comp.runB.summary.agent_version}</h3>
        <p style="color:var(--text-dim); font-size:12px; margin-top:2px;">Scenario: ${comp.runA.summary.scenario_id}</p>
      </div>
      <div style="display:flex; gap:12px;">
        <span class="badge ${vA === 'pass' ? 'badge-pass' : 'badge-fail'}">${comp.runA.summary.agent_version}: ${vA.toUpperCase()}</span>
        <span class="badge ${vB === 'pass' ? 'badge-pass' : 'badge-fail'}">${comp.runB.summary.agent_version}: ${vB.toUpperCase()}</span>
      </div>
    </div>
    <div style="margin-top:12px; font-size:13px;">
      ${
        regressions.length > 0
          ? `<strong style="color:var(--color-fail)">⚠️ ${regressions.length} Regressed Metric(s):</strong> ${regressions.map((r) => r.metric).join(', ')}.`
          : '<span style="color:var(--color-pass)">No metric regressions detected between candidates.</span>'
      }
      ${
        improvements.length > 0
          ? `<br><strong style="color:var(--color-pass)">✨ ${improvements.length} Improved Metric(s):</strong> ${improvements.map((r) => r.metric).join(', ')}.`
          : ''
      }
    </div>
  `;

  // Render metrics diff
  tbody.innerHTML = comp.metricsDiff
    .map((m) => {
      let statusBadge = '<span class="badge badge-unexercised">SAME</span>';
      if (m.status === 'regressed') {
        statusBadge = '<span class="badge badge-fail">REGRESSED</span>';
      } else if (m.status === 'improved') {
        statusBadge = '<span class="badge badge-pass">IMPROVED</span>';
      }

      return `
        <tr>
          <td><strong style="font-family:var(--font-mono);">${m.metric}</strong></td>
          <td><span class="tag">${m.category || 'process'}</span></td>
          <td><span class="badge ${m.verdictA === 'pass' ? 'badge-pass' : 'badge-fail'}">${m.verdictA}</span></td>
          <td><span class="badge ${m.verdictB === 'pass' ? 'badge-pass' : 'badge-fail'}">${m.verdictB}</span></td>
          <td>${statusBadge}</td>
          <td style="font-size:12px; color:var(--text-muted);">${m.detailB || m.detailA || '-'}</td>
        </tr>
      `;
    })
    .join('');

  // Side-by-side transcripts
  document.getElementById('compTitleA').textContent = `${comp.runA.summary.agent_version} (${comp.runA.trace.run_id})`;
  document.getElementById('compTitleB').textContent = `${comp.runB.summary.agent_version} (${comp.runB.trace.run_id})`;

  renderTimelineInto(comp.runA.trace, 'compTimelineA');
  renderTimelineInto(comp.runB.trace, 'compTimelineB');
}

function renderTimelineInto(trace, elementId) {
  const container = document.getElementById(elementId);
  const events = trace.events || [];
  container.innerHTML = events
    .map((e) => {
      if (e.type === 'caller_turn') {
        return `<div class="timeline-event event-caller"><div class="event-header"><span class="event-role">Caller</span><span>seq ${e.seq}</span></div><div class="event-text">"${e.text}"</div></div>`;
      }
      if (e.type === 'agent_message') {
        return `<div class="timeline-event event-agent"><div class="event-header"><span class="event-role">Agent</span><span>seq ${e.seq}</span></div><div class="event-text">"${e.text}"</div></div>`;
      }
      if (e.type === 'tool_call') {
        return `<div class="timeline-event event-tool"><div class="event-header"><strong>${e.tool}</strong><span>seq ${e.seq}</span></div><div>Args: <code>${JSON.stringify(e.args)}</code></div></div>`;
      }
      return '';
    })
    .join('');
}

// ---------------------------------------------------------------------------
// Run Simulation Modal
// ---------------------------------------------------------------------------
function setupModal() {
  const modal = document.getElementById('runModal');
  const btnOpen = document.getElementById('btnOpenRunModal');
  const btnClose = document.getElementById('btnCloseRunModal');
  const btnCancel = document.getElementById('btnCancelRunModal');
  const btnExecute = document.getElementById('btnExecuteRun');

  btnOpen.addEventListener('click', () => modal.classList.add('active'));
  btnClose.addEventListener('click', () => modal.classList.remove('active'));
  btnCancel.addEventListener('click', () => modal.classList.remove('active'));

  btnExecute.addEventListener('click', async () => {
    const scenarioId = document.getElementById('modalScenarioSelect').value;
    const agentSpec = document.getElementById('modalAgentSelect').value;
    const mode = document.getElementById('modalModeSelect').value;
    const seed = Number(document.getElementById('modalSeed').value) || 0;

    const spinner = document.getElementById('btnExecuteSpinner');
    const btnText = document.getElementById('btnExecuteText');

    spinner.classList.remove('hidden');
    btnText.textContent = 'Executing Simulation...';
    btnExecute.disabled = true;

    try {
      const res = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scenario_id: scenarioId,
          agent_spec: agentSpec,
          mode,
          seed,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Execution failed');

      modal.classList.remove('active');
      await loadInitialData();
      await loadRunDetails(data.run_id);
      document.querySelector('[data-tab="tab-inspector"]').click();
    } catch (err) {
      alert(`Simulation failed: ${err.message}`);
    } finally {
      spinner.classList.add('hidden');
      btnText.textContent = 'Start Simulation & Evaluate';
      btnExecute.disabled = false;
    }
  });
}
