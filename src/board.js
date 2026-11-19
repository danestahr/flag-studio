// Read-only Pipedrive-style board: one column per stage of the product's pipeline, one card per
// open deal. Placement comes from each deal's LIVE Pipedrive stage (Studio already pushes design
// status changes there), so stages Studio doesn't track (Ordered, Shipped...) still show correctly.
// Deals linked to a Studio project open that project and show its design status; unlinked deals
// open in Pipedrive.
import { pipedriveListBoard, listPipedriveLinkedProjects, pipedriveCreateFromDeal } from './supabase.js';
import { esc } from './dom-utils.js';
import { STATUS_LABEL } from './status-labels.js';

function money(value, currency) {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD', maximumFractionDigits: 0 }).format(value || 0);
  } catch {
    return `$${Math.round(value || 0)}`;
  }
}

export function createBoard(root) {
  let data = null;        // { stages, deals }
  let links = new Map();  // dealId -> { id, name, status }
  let search = '';
  let generation = 0;
  let product = 'flags';
  // (project|null) => boolean. Set by the landing page so the status/deadline filters apply;
  // gets null for a deal with no Studio project.
  let projectFilter = () => true;

  function cardHtml(deal) {
    const link = links.get(Number(deal.id));
    const href = link ? `/project?project=${link.id}` : deal.url;
    const target = link ? '' : ' target="_blank" rel="noopener"';
    const pill = link?.status
      ? `<span class="status-pill status-${esc(link.status)}">${esc(STATUS_LABEL[link.status] || link.status)}</span>`
      : '';
    return `<a class="board-card${link ? ' linked' : ''}" href="${esc(href)}"${target}>
      <div class="board-card-title">${esc(deal.title)}</div>
      ${deal.org ? `<div class="board-card-meta">${esc(deal.org)}</div>` : ''}
      ${deal.person ? `<div class="board-card-meta">${esc(deal.person)}</div>` : ''}
      <div class="board-card-foot"><span>${esc(money(deal.value, deal.currency))}</span>${pill}${link ? '' : `<button type="button" class="btn-secondary sm" data-create-deal="${esc(String(deal.id))}">Create project</button>`}</div>
    </a>`;
  }

  function render() {
    if (!data) return;
    const q = search.toLowerCase();
    const matches = (d) =>
      (!q || [d.title, d.org, d.person].some(v => v && v.toLowerCase().includes(q))) &&
      projectFilter(links.get(Number(d.id))?.project ?? null);
    const byStage = new Map(data.stages.map(s => [s.id, []]));
    for (const d of data.deals) {
      if (matches(d) && byStage.has(d.stage_id)) byStage.get(d.stage_id).push(d);
    }
    const columns = data.stages.map(stage => {
      const cards = byStage.get(stage.id);
      const total = cards.reduce((sum, d) => sum + (d.value || 0), 0);
      return `<div class="board-col">
        <div class="board-col-head">
          <div class="board-col-name" title="${esc(stage.name)}">${esc(stage.name)}</div>
          <div class="board-col-sub">${esc(money(total, cards[0]?.currency))} · ${cards.length} deal${cards.length === 1 ? '' : 's'}</div>
        </div>
        <div class="board-col-body">${cards.map(cardHtml).join('')}</div>
      </div>`;
    });
    root.innerHTML = `<div class="board">${columns.join('')}</div>`;
  }

  // Unlinked cards carry a "Create project" button (inside the card's <a>, so it must not navigate).
  root.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-create-deal]');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    btn.disabled = true;
    btn.textContent = 'Creating…';
    try {
      const { projectId } = await pipedriveCreateFromDeal(Number(btn.dataset.createDeal), product);
      window.location.href = `/project?project=${projectId}`;
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Create project';
      alert(`Couldn't create the project: ${err.message}`);
    }
  });

  async function load(productFilterValue) {
    product = productFilterValue === 'hole_signs' ? 'hole-signs' : 'flags';
    const mine = ++generation;
    root.innerHTML = '<div class="drafts-empty">Loading board…</div>';
    try {
      const [board, projects] = await Promise.all([
        pipedriveListBoard(product),
        listPipedriveLinkedProjects(product),
      ]);
      if (mine !== generation) return;
      const dealCol = product === 'flags' ? 'pipedrive_flags_deal_id' : 'pipedrive_hs_deal_id';
      const cfgKey = product === 'flags' ? 'flag_config' : 'hole_sign_config';
      links = new Map(projects.map(p => {
        const cfg = Array.isArray(p[cfgKey]) ? p[cfgKey][0] : p[cfgKey];
        return [Number(p[dealCol]), { id: p.id, name: p.name, status: cfg?.status || null, project: p }];
      }));
      data = board;
      render();
    } catch (err) {
      if (mine !== generation) return;
      console.error(err);
      root.innerHTML = `<div class="drafts-empty">${esc(err.message || 'Could not load the board.')}</div>`;
    }
  }

  return {
    load,
    setSearch(value) { search = value.trim(); render(); },
    setProjectFilter(fn) { projectFilter = fn; render(); },
  };
}
