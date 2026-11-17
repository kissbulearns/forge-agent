import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import { marked } from 'marked';
import type { Todo, UiItem, Usage } from '../core/types';
import type { ActiveFile, FromWebview, ToWebview, ViewState } from '../protocol';
import css from './style.css';

declare function acquireVsCodeApi(): { postMessage(m: FromWebview): void; getState(): any; setState(s: any): void };

const vscode = acquireVsCodeApi();
const send = (m: FromWebview) => vscode.postMessage(m);

type ToolItem = Extract<UiItem, { kind: 'tool' }>;

const ICON = {
  check: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.2 3.2L13 4.8"/></svg>',
  cross: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
  ask: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="8" cy="8" r="6.2"/><path d="M8 4.8v3.8"/><circle cx="8" cy="11.2" r="0.5" fill="currentColor"/></svg>',
  warn: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"><path d="M8 2.2l6.3 11.3H1.7z"/><path d="M8 6.5v3.2"/><circle cx="8" cy="11.6" r="0.4" fill="currentColor"/></svg>',
  chev: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5L10.5 8 6 12.5"/></svg>',
  send: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13V3M3.5 7.5L8 3l4.5 4.5"/></svg>',
  stop: '<svg viewBox="0 0 16 16" fill="currentColor"><rect x="4" y="4" width="8" height="8" rx="1.5"/></svg>',
  at: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="8" cy="8" r="2.6"/><path d="M10.6 5.4v3.4a1.7 1.7 0 0 0 3.4 0V8a6 6 0 1 0-2.4 4.8"/></svg>',
};

// ---- State ----

let state: ViewState = {
  items: [],
  todos: [],
  usage: { input: 0, cachedInput: 0, output: 0, lastPrompt: 0 },
  busy: false,
  mode: 'agent',
  ready: { ok: true, missing: [] },
  pricing: { input: 0, cachedInput: 0, output: 0 },
  contextWindow: 200000,
  hasWorkspace: true,
};
const nodes = new Map<string, HTMLElement>();
const openCards = new Map<string, boolean>();
let includeActive = true;
let todosOpen = false;

// ---- Skeleton ----

const style = document.createElement('style');
style.textContent = css;
document.head.appendChild(style);

const app = document.getElementById('app')!;
app.innerHTML = `
  <div class="scroll" id="scroll">
    <div class="empty" id="empty"></div>
    <div class="items" id="items" role="log" aria-live="polite"></div>
  </div>
  <div class="bottom">
    <div class="todos" id="todos" hidden></div>
    <div class="composer">
      <div class="chips" id="chips"></div>
      <textarea id="input" rows="1" placeholder="Ask Forge to build, fix or investigate…" aria-label="Message"></textarea>
      <div class="bar">
        <select id="mode" title="Agent can edit files and run commands. Read-only can only look." aria-label="Mode">
          <option value="agent">Agent</option>
          <option value="ask">Read-only</option>
        </select>
        <button class="icon-btn" id="attach" title="Mention a file" aria-label="Mention a file">${ICON.at}</button>
        <span class="spacer"></span>
        <span class="meter" id="meter"></span>
        <button class="send" id="send" title="Send (Enter)" aria-label="Send">${ICON.send}</button>
      </div>
    </div>
  </div>`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const scroll = $('scroll');
const itemsEl = $('items');
const emptyEl = $('empty');
const todosEl = $('todos');
const chipsEl = $('chips');
const input = $<HTMLTextAreaElement>('input');
const modeEl = $<HTMLSelectElement>('mode');
const meterEl = $('meter');
const sendBtn = $<HTMLButtonElement>('send');

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

// ---- Scrolling ----

let stick = true;
scroll.addEventListener('scroll', () => {
  stick = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 60;
});
const toBottom = () => {
  if (stick) scroll.scrollTop = scroll.scrollHeight;
};

// ---- Markdown ----

marked.setOptions({ gfm: true, breaks: false });
const FILE_REF = /^[\w@.\-\/\\ ]*[\w\-]\.[A-Za-z][\w\-]{0,9}(:\d+(-\d+)?)?$/;

function renderMarkdown(target: HTMLElement, text: string, final: boolean): void {
  const html = marked.parse(text, { async: false }) as string;
  target.innerHTML = DOMPurify.sanitize(html, { FORBID_TAGS: ['style', 'form', 'input', 'button', 'img'], FORBID_ATTR: ['style'] });
  if (!final) return;
  target.querySelectorAll<HTMLElement>('pre code').forEach((code) => {
    const lang = /language-([\w-]+)/.exec(code.className)?.[1];
    if (lang && hljs.getLanguage(lang)) {
      try {
        hljs.highlightElement(code);
      } catch {
        // Leave it plain.
      }
    }
    const copy = el('button', 'copy', 'Copy');
    copy.addEventListener('click', () => {
      void navigator.clipboard.writeText(code.textContent ?? '');
      copy.textContent = 'Copied';
      setTimeout(() => (copy.textContent = 'Copy'), 1200);
    });
    code.parentElement?.appendChild(copy);
  });
  target.querySelectorAll<HTMLElement>(':not(pre) > code').forEach((code) => {
    const t = code.textContent ?? '';
    if (t.length < 200 && (t.includes('/') || t.includes('\\')) && FILE_REF.test(t)) {
      code.classList.add('file-link');
      code.title = 'Open file';
      code.addEventListener('click', () => send({ type: 'openFile', path: t.replace(/-\d+$/, '') }));
    }
  });
}

// Streaming text is re-rendered at most once per frame.
const pending = new Set<string>();
let frame = 0;
function scheduleRender(id: string): void {
  pending.add(id);
  frame ||= requestAnimationFrame(() => {
    frame = 0;
    for (const pid of pending) {
      const item = state.items.find((x) => x.id === pid);
      const node = nodes.get(pid);
      if (item?.kind === 'assistant' && node) renderMarkdown(node.querySelector('.md') as HTMLElement, item.text, false);
    }
    pending.clear();
    toBottom();
  });
}

// ---- Items ----

function renderItem(item: UiItem): HTMLElement {
  switch (item.kind) {
    case 'user': {
      const wrap = el('div', 'msg user');
      wrap.appendChild(el('div', 'bubble', item.text));
      return wrap;
    }
    case 'assistant': {
      const wrap = el('div', `msg assistant${item.streaming ? ' streaming' : ''}`);
      const md = el('div', 'md');
      renderMarkdown(md, item.text, !item.streaming);
      wrap.appendChild(md);
      return wrap;
    }
    case 'notice':
      return el('div', `notice ${item.level}`, item.text);
    case 'tool':
      return renderTool(item);
  }
}

function statusIcon(item: ToolItem): string {
  if (item.status === 'running') return '<span class="spinner"></span>';
  if (item.status === 'approval') return item.danger ? ICON.warn : ICON.ask;
  if (item.status === 'done') return ICON.check;
  return ICON.cross;
}

function renderDiff(diff: string): HTMLElement {
  const box = el('div', 'diff');
  for (const line of diff.split('\n')) {
    const cls = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.startsWith('@@') || line.startsWith('[') ? 'hunk' : '';
    box.appendChild(el('div', cls, line || ' '));
  }
  return box;
}

function renderTool(item: ToolItem): HTMLElement {
  const isCommand = item.name === 'run_command';
  const firstLine = (item.output ?? '').split('\n')[0];
  const hasBody =
    item.status === 'approval' ||
    !!item.diff ||
    (isCommand && !!item.detail) ||
    (!!item.output && (item.output.includes('\n') || item.output.length > 70));
  const open = openCards.get(item.id) ?? (item.status === 'approval' || (item.status === 'error' && hasBody));

  const card = el('div', `tool status-${item.status}${item.danger ? ' danger' : ''}${open && hasBody ? ' open' : ''}`);
  const head = el('div', `tool-head${hasBody ? ' can-open' : ''}`);
  const ico = el('span', 'ico');
  ico.innerHTML = statusIcon(item);
  head.appendChild(ico);
  head.appendChild(el('span', 'tool-title', item.title));
  const detail = el('span', 'tool-detail', item.detail?.split('\n')[0] ?? '');
  if (item.detail) detail.title = item.detail;
  head.appendChild(detail);
  const meta = item.status === 'running' ? item.progress : item.status === 'approval' ? 'needs approval' : firstLine.length <= 70 ? firstLine : '';
  if (meta) head.appendChild(el('span', 'tool-meta', meta));
  if (hasBody) {
    const chev = el('span', 'chev');
    chev.innerHTML = ICON.chev;
    head.appendChild(chev);
    head.addEventListener('click', () => {
      openCards.set(item.id, !card.classList.contains('open'));
      card.classList.toggle('open');
      toBottom();
    });
  }
  card.appendChild(head);
  if (!hasBody) return card;

  const body = el('div', 'tool-body');
  if (isCommand && item.detail) body.appendChild(el('pre', 'cmd', item.detail));
  if (item.name === 'limit' && item.detail) body.appendChild(el('pre', '', item.detail));
  if (item.diff) body.appendChild(renderDiff(item.diff));
  if (item.output && item.status !== 'approval') {
    if (item.name === 'spawn_agent' && item.status === 'done') {
      const report = el('div', 'report md');
      renderMarkdown(report, item.output, true);
      body.appendChild(report);
    } else {
      const out = el('pre', 'out', item.output);
      body.appendChild(out);
      if (item.status === 'running') requestAnimationFrame(() => (out.scrollTop = out.scrollHeight));
    }
  }

  if (item.status === 'approval') {
    const box = el('div', 'approval');
    if (item.reason) {
      const reason = el('div', 'reason');
      const i = el('span', 'ico');
      i.innerHTML = ICON.warn;
      reason.appendChild(i);
      reason.appendChild(el('span', '', item.reason));
      box.appendChild(reason);
    }
    const row = el('div', 'row');
    const decide = (decision: 'approve' | 'always' | 'reject') => send({ type: 'approval', id: item.id, decision, feedback: feedback.value });
    const approve = el('button', 'btn primary', item.name === 'limit' ? 'Continue' : isCommand ? 'Run' : 'Apply');
    approve.addEventListener('click', () => decide('approve'));
    row.appendChild(approve);
    if (item.canAlways) {
      const always = el('button', 'btn', isCommand ? 'Always allow this command' : 'Apply all edits in this chat');
      always.title = isCommand ? 'Run commands that start the same way without asking, for the rest of this chat' : 'Stop asking about file edits for the rest of this chat';
      always.addEventListener('click', () => decide('always'));
      row.appendChild(always);
    }
    const reject = el('button', 'btn', item.name === 'limit' ? 'Stop here' : 'Reject');
    reject.addEventListener('click', () => decide('reject'));
    row.appendChild(reject);
    if (item.canViewDiff) {
      const view = el('button', 'btn link', 'Open diff');
      view.addEventListener('click', () => send({ type: 'viewDiff', id: item.id }));
      row.appendChild(view);
    }
    box.appendChild(row);
    const feedback = el('input');
    feedback.type = 'text';
    feedback.placeholder = 'Optional: tell the agent what to do instead, then Reject';
    feedback.setAttribute('aria-label', 'Feedback for the agent');
    feedback.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && feedback.value.trim()) decide('reject');
    });
    box.appendChild(feedback);
    body.appendChild(box);
  } else if (item.canViewDiff) {
    const row = el('div', 'approval');
    const view = el('button', 'btn link', 'Open diff');
    view.style.alignSelf = 'flex-start';
    view.addEventListener('click', () => send({ type: 'viewDiff', id: item.id }));
    row.appendChild(view);
    body.appendChild(row);
  }
  card.appendChild(body);
  return card;
}

function upsertItem(item: UiItem): void {
  const i = state.items.findIndex((x) => x.id === item.id);
  if (i >= 0) state.items[i] = item;
  else state.items.push(item);

  const old = nodes.get(item.id);
  // Do not rebuild an approval card the user may be typing in.
  if (old && item.kind === 'tool' && item.status === 'approval' && old.classList.contains('status-approval')) return;
  const node = renderItem(item);
  nodes.set(item.id, node);
  if (old) old.replaceWith(node);
  else itemsEl.appendChild(node);
  renderEmpty();
  renderThinking();
  toBottom();
}

let thinkingEl: HTMLElement | undefined;
function renderThinking(): void {
  const last = state.items[state.items.length - 1];
  const waiting =
    state.busy &&
    (!last ||
      last.kind === 'user' ||
      last.kind === 'notice' ||
      (last.kind === 'assistant' && !last.streaming) ||
      (last.kind === 'tool' && last.status !== 'running' && last.status !== 'approval'));
  if (waiting) {
    if (!thinkingEl) {
      thinkingEl = el('div', 'thinking');
      thinkingEl.innerHTML = '<span class="spinner"></span><span>Working…</span>';
    }
    itemsEl.appendChild(thinkingEl);
  } else {
    thinkingEl?.remove();
  }
}

// ---- Empty state ----

const SUGGESTIONS = [
  'Explain how this project is structured and where the main logic lives.',
  'Run the tests, find out why any fail, and fix them.',
  'Find where this error comes from and propose a fix: <paste the error>',
];

function renderEmpty(): void {
  if (state.items.length) {
    emptyEl.hidden = true;
    return;
  }
  emptyEl.hidden = false;
  emptyEl.replaceChildren();
  emptyEl.appendChild(el('h1', '', 'Forge Agent'));

  if (!state.hasWorkspace) {
    const card = el('div', 'card attention');
    card.appendChild(el('strong', '', 'Open a folder to start'));
    card.appendChild(el('p', '', 'Forge works inside a workspace folder: it reads, edits and runs commands there.'));
    emptyEl.appendChild(card);
    return;
  }
  if (!state.ready.ok) {
    const card = el('div', 'card attention');
    card.appendChild(el('strong', '', 'Connect to Azure OpenAI'));
    const p = el('p');
    p.append('Missing: ');
    state.ready.missing.forEach((m, i) => {
      if (i) p.append(', ');
      p.appendChild(el('code', '', m));
    });
    card.appendChild(p);
    const row = el('div', 'row');
    const setup = el('button', 'btn primary', 'Open connection file');
    setup.addEventListener('click', () => send({ type: 'command', command: 'setup' }));
    row.appendChild(setup);
    card.appendChild(row);
    emptyEl.appendChild(card);
    return;
  }

  const p = el('p');
  p.append('Runs on your Azure OpenAI deployment ');
  p.appendChild(el('code', '', state.ready.deployment || ''));
  p.append('. It reads and edits files in this folder and runs commands, asking before anything risky.');
  emptyEl.appendChild(p);
  const list = el('div', 'suggest');
  for (const s of SUGGESTIONS) {
    const b = el('button', '', s);
    b.addEventListener('click', () => {
      input.value = s;
      autosize();
      input.focus();
    });
    list.appendChild(b);
  }
  emptyEl.appendChild(list);
  const row = el('div', 'row');
  const test = el('button', 'btn link', 'Test connection');
  test.addEventListener('click', () => send({ type: 'command', command: 'testConnection' }));
  row.appendChild(test);
  const settings = el('button', 'btn link', 'Settings');
  settings.addEventListener('click', () => send({ type: 'command', command: 'openSettings' }));
  row.appendChild(settings);
  emptyEl.appendChild(row);
}

// ---- Plan ----

function renderTodos(todos: Todo[]): void {
  state.todos = todos;
  if (!todos.length) {
    todosEl.hidden = true;
    return;
  }
  todosEl.hidden = false;
  todosEl.className = `todos${todosOpen ? ' open' : ''}`;
  todosEl.replaceChildren();
  const done = todos.filter((t) => t.status === 'completed').length;
  const current = todos.find((t) => t.status === 'in_progress') ?? todos.find((t) => t.status === 'pending');
  const head = el('div', 'todos-head');
  head.setAttribute('role', 'button');
  head.tabIndex = 0;
  const chev = el('span', 'chev');
  chev.innerHTML = ICON.chev;
  head.appendChild(chev);
  head.appendChild(el('span', '', `Plan ${done}/${todos.length}`));
  head.appendChild(el('span', 'current', done === todos.length ? 'All done' : (current?.content ?? '')));
  const toggle = () => {
    todosOpen = !todosOpen;
    todosEl.classList.toggle('open', todosOpen);
  };
  head.addEventListener('click', toggle);
  head.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    }
  });
  todosEl.appendChild(head);
  const list = el('ul', 'todos-list');
  for (const t of todos) {
    const li = el('li', t.status);
    li.appendChild(el('span', 'box'));
    li.appendChild(el('span', '', t.content));
    list.appendChild(li);
  }
  todosEl.appendChild(list);
}

// ---- Meter, chips, composer ----

const fmt = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : String(n));

function renderMeter(u: Usage): void {
  state.usage = u;
  const total = u.input + u.output;
  if (!total) {
    meterEl.textContent = '';
    return;
  }
  const p = state.pricing;
  const parts = [`${fmt(total)} tokens`];
  if (p.input || p.output) {
    const cachedRate = p.cachedInput || p.input;
    const cost = ((u.input - u.cachedInput) * p.input + u.cachedInput * cachedRate + u.output * p.output) / 1e6;
    parts.push(`$${cost < 10 ? cost.toFixed(2) : cost.toFixed(0)}`);
  }
  if (u.lastPrompt && state.contextWindow) parts.push(`${Math.min(100, Math.round((u.lastPrompt / state.contextWindow) * 100))}% context`);
  meterEl.textContent = parts.join(' · ');
  meterEl.title = `This chat: ${u.input.toLocaleString()} input tokens (${u.cachedInput.toLocaleString()} cached), ${u.output.toLocaleString()} output tokens`;
}

function renderChips(file?: ActiveFile): void {
  state.activeFile = file;
  chipsEl.replaceChildren();
  if (!file) return;
  const chip = el('button', `chip${includeActive ? '' : ' off'}`);
  const name = file.path.split('/').pop() ?? file.path;
  chip.appendChild(el('span', '', file.selection ? `${name}:${file.selection.start}-${file.selection.end}` : name));
  chip.title = includeActive ? `Tells the agent you have ${file.path} open. Click to leave it out.` : 'Not shared with the agent. Click to include.';
  chip.setAttribute('aria-pressed', String(includeActive));
  chip.addEventListener('click', () => {
    includeActive = !includeActive;
    renderChips(state.activeFile);
  });
  chipsEl.appendChild(chip);
}

function renderBusy(busy: boolean): void {
  state.busy = busy;
  sendBtn.classList.toggle('stop', busy);
  sendBtn.innerHTML = busy ? ICON.stop : ICON.send;
  sendBtn.title = busy ? 'Stop' : 'Send (Enter)';
  sendBtn.setAttribute('aria-label', busy ? 'Stop' : 'Send');
  sendBtn.disabled = !busy && !input.value.trim();
  renderThinking();
  toBottom();
}

function autosize(): void {
  input.style.height = 'auto';
  input.style.height = `${Math.min(220, input.scrollHeight)}px`;
  sendBtn.disabled = !state.busy && !input.value.trim();
  vscode.setState({ draft: input.value });
}

function submit(): void {
  if (state.busy) {
    send({ type: 'stop' });
    return;
  }
  const text = input.value.trim();
  if (!text) return;
  stick = true;
  send({ type: 'send', text, includeActive });
  input.value = '';
  autosize();
}

input.addEventListener('input', autosize);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (!state.busy) submit();
  } else if (e.key === 'Escape' && state.busy) {
    send({ type: 'stop' });
  }
});
sendBtn.addEventListener('click', submit);
modeEl.addEventListener('change', () => send({ type: 'mode', mode: modeEl.value as 'agent' | 'ask' }));
$('attach').addEventListener('click', () => send({ type: 'attach' }));

function insertAtCursor(text: string): void {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  const before = input.value.slice(0, start);
  const pad = before && !/\s$/.test(before) ? ' ' : '';
  input.value = before + pad + text + input.value.slice(end);
  const pos = before.length + pad.length + text.length;
  input.setSelectionRange(pos, pos);
  autosize();
  input.focus();
}

// ---- Messages from the extension ----

function applyState(s: ViewState): void {
  state = s;
  nodes.clear();
  itemsEl.replaceChildren();
  thinkingEl = undefined;
  for (const item of s.items) {
    const node = renderItem(item);
    nodes.set(item.id, node);
    itemsEl.appendChild(node);
  }
  modeEl.value = s.mode;
  renderEmpty();
  renderTodos(s.todos);
  renderMeter(s.usage);
  renderChips(s.activeFile);
  renderBusy(s.busy);
  stick = true;
  toBottom();
}

window.addEventListener('message', (e: MessageEvent<ToWebview>) => {
  const m = e.data;
  switch (m.type) {
    case 'state':
      return applyState(m.state);
    case 'item':
      return upsertItem(m.item);
    case 'delta': {
      const item = state.items.find((x) => x.id === m.id);
      if (item?.kind === 'assistant') {
        item.text += m.text;
        scheduleRender(m.id);
      }
      return;
    }
    case 'todos':
      return renderTodos(m.todos);
    case 'usage':
      return renderMeter(m.usage);
    case 'busy':
      return renderBusy(m.busy);
    case 'activeFile':
      return renderChips(m.file);
    case 'insert':
      return insertAtCursor(m.text);
    case 'focus':
      return input.focus();
  }
});

const saved = vscode.getState();
if (saved?.draft) input.value = saved.draft;
autosize();
renderEmpty();
send({ type: 'ready' });
