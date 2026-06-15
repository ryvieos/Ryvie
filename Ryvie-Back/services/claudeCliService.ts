// Fournisseur « Claude CLI » : shim OpenAI-compatible qui relaie vers le binaire
// `claude` (Claude Code) DÉJÀ authentifié sur la machine (~/.claude). Aucun login :
// on réutilise la session locale. Branché dans LiteLLM comme provider openai-compatible.
// Endpoints : /chat/completions ET /responses (utilisé par n8n), avec support du
// STREAMING (SSE) car n8n envoie stream=true. ⚠️ `claude -p` = agent texte : pas de
// tool_calls (inadapté macros OnlyOffice), ~3-4s/req, usage backend hors ToS Anthropic.
export {};

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');
const { AI_CONFIG_FILE } = require('../config/paths');

function getMasterKey(): string {
  try { return JSON.parse(fs.readFileSync(AI_CONFIG_FILE, 'utf8')).masterKey || ''; } catch (_) { return ''; }
}

function checkAuth(req: any, res: any): boolean {
  const master = getMasterKey();
  const token = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  if (!master || token !== master) {
    res.status(401).json({ error: { message: 'Unauthorized', type: 'auth_error' } });
    return false;
  }
  return true;
}

function claudeBin(): string {
  const cand = process.env.CLAUDE_CLI_BIN || path.join(process.env.HOME || '/home/ryvie', '.local/bin/claude');
  try { if (fs.existsSync(cand)) return cand; } catch (_) { /* fallback PATH */ }
  return 'claude';
}

function partText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c: any) => c.text || c.input_text || c.output_text || '').join('');
  return '';
}

function messagesToPrompt(messages: any[]): string {
  if (!Array.isArray(messages)) return '';
  const parts: string[] = [];
  for (const m of messages) {
    const content = partText(m.content);
    if (content) parts.push(m.role === 'assistant' ? 'Assistant: ' + content : content);
  }
  return parts.join('\n\n');
}

function responsesToPrompt(body: any): string {
  const parts: string[] = [];
  if (body.instructions) parts.push(String(body.instructions));
  const input = body.input;
  if (typeof input === 'string') parts.push(input);
  else if (Array.isArray(input)) {
    for (const item of input) {
      const content = partText(item.content);
      if (content) parts.push(item.role === 'assistant' ? 'Assistant: ' + content : content);
    }
  }
  return parts.join('\n\n');
}

/** Lance `claude -p <prompt>`. stdin IGNORÉ (sinon l'agent attend l'EOF et se fige). */
function runClaude(prompt: string, model?: string, timeoutMs = 180000): Promise<string> {
  const args = ['-p', prompt, '--output-format', 'text'];
  if (model && model !== 'claude-cli') args.push('--model', model);
  return new Promise((resolve, reject) => {
    const child = spawn(claudeBin(), args, { cwd: os.tmpdir(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} reject(new Error('claude CLI timeout')); }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    child.on('error', (e: any) => { clearTimeout(timer); reject(e); });
    child.on('close', (code: number) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error(String(err || `claude exited ${code}`).slice(0, 400)));
    });
  });
}

/** Objet réponse complet de l'API Responses (status 'in_progress' ou 'completed'). */
function buildResponseObject(text: string, model: string, body: any, now: number, status: string): any {
  const msgId = 'msg_' + now;
  return {
    id: 'resp_' + now,
    object: 'response',
    created_at: Math.floor(now / 1000),
    status,
    error: null,
    incomplete_details: null,
    instructions: body.instructions ?? null,
    max_output_tokens: body.max_output_tokens ?? null,
    model,
    output: status === 'completed'
      ? [{ type: 'message', id: msgId, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }]
      : [],
    parallel_tool_calls: true,
    previous_response_id: body.previous_response_id ?? null,
    reasoning: { effort: null, summary: null },
    store: body.store ?? false,
    temperature: body.temperature ?? 1,
    text: { format: { type: 'text' } },
    tool_choice: body.tool_choice ?? 'auto',
    tools: body.tools ?? [],
    top_p: body.top_p ?? 1,
    truncation: body.truncation ?? 'disabled',
    usage: { input_tokens: 0, input_tokens_details: { cached_tokens: 0 }, output_tokens: 0, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 0 },
    user: null,
    metadata: body.metadata ?? {},
    output_text: text
  };
}

/** Endpoint OpenAI Chat (/v1/chat/completions), avec streaming optionnel. */
async function chatCompletions(req: any, res: any): Promise<void> {
  if (!checkAuth(req, res)) return;
  const body = req.body || {};
  const prompt = messagesToPrompt(body.messages);
  if (!prompt) { res.status(400).json({ error: { message: 'No prompt in messages' } }); return; }
  const model = body.model || 'claude-cli';
  try {
    const text = await runClaude(prompt, body.model);
    const now = Date.now();
    if (!body.stream) {
      res.json({
        id: 'claudecli-' + now, object: 'chat.completion', created: Math.floor(now / 1000), model,
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      });
      return;
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders?.();
    const base = { id: 'claudecli-' + now, object: 'chat.completion.chunk', created: Math.floor(now / 1000), model };
    res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (e: any) {
    if (!res.headersSent) res.status(502).json({ error: { message: 'Claude CLI: ' + (e.message || 'échec'), type: 'cli_error' } });
    else res.end();
  }
}

/** Endpoint OpenAI Responses (/v1/responses), utilisé par n8n, avec streaming SSE. */
async function responses(req: any, res: any): Promise<void> {
  if (!checkAuth(req, res)) return;
  const body = req.body || {};
  const prompt = responsesToPrompt(body);
  if (!prompt) { res.status(400).json({ error: { message: 'No input' } }); return; }
  const model = body.model || 'claude-cli';
  try {
    const text = await runClaude(prompt, body.model);
    const now = Date.now();
    if (!body.stream) {
      res.json(buildResponseObject(text, model, body, now, 'completed'));
      return;
    }
    // Streaming SSE : on émet la séquence d'événements de l'API Responses. Comme
    // `claude -p` donne tout le texte d'un coup, on envoie un seul delta = texte complet.
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders?.();
    const msgId = 'msg_' + now;
    let seq = 0;
    const emit = (type: string, data: any) => {
      res.write('event: ' + type + '\n');
      res.write('data: ' + JSON.stringify({ type, sequence_number: seq++, ...data }) + '\n\n');
    };
    const part = { type: 'output_text', text, annotations: [] };
    emit('response.created', { response: buildResponseObject(text, model, body, now, 'in_progress') });
    emit('response.in_progress', { response: buildResponseObject(text, model, body, now, 'in_progress') });
    emit('response.output_item.added', { output_index: 0, item: { id: msgId, type: 'message', status: 'in_progress', role: 'assistant', content: [] } });
    emit('response.content_part.added', { item_id: msgId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    emit('response.output_text.delta', { item_id: msgId, output_index: 0, content_index: 0, delta: text });
    emit('response.output_text.done', { item_id: msgId, output_index: 0, content_index: 0, text });
    emit('response.content_part.done', { item_id: msgId, output_index: 0, content_index: 0, part });
    emit('response.output_item.done', { output_index: 0, item: { id: msgId, type: 'message', status: 'completed', role: 'assistant', content: [part] } });
    emit('response.completed', { response: buildResponseObject(text, model, body, now, 'completed') });
    res.end();
  } catch (e: any) {
    if (!res.headersSent) res.status(502).json({ error: { message: 'Claude CLI: ' + (e.message || 'échec'), type: 'cli_error' } });
    else { try { res.write('event: error\ndata: ' + JSON.stringify({ type: 'error', message: e.message }) + '\n\n'); } catch (_) {} res.end(); }
  }
}

/**
 * État d'authentification du binaire `claude` local (`claude auth status`, JSON).
 * Sert au front à savoir si le fournisseur Claude CLI est utilisable et sous quel
 * compte. Ne lève jamais : renvoie { loggedIn:false, error } en cas d'échec.
 */
function authStatus(): Promise<any> {
  return new Promise((resolve) => {
    const child = spawn(claudeBin(), ['auth', 'status'], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} resolve({ installed: true, loggedIn: false, error: 'timeout' }); }, 10000);
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    // ENOENT = binaire `claude` ABSENT de la machine → installed:false (≠ non connecté).
    child.on('error', (e: any) => {
      clearTimeout(timer);
      const installed = e && e.code !== 'ENOENT';
      resolve({ installed, loggedIn: false, error: installed ? String(e.message || e).slice(0, 200) : 'claude non installé' });
    });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const j = JSON.parse(out);
        resolve({ installed: true, loggedIn: !!j.loggedIn, email: j.email, subscriptionType: j.subscriptionType, authMethod: j.authMethod });
      } catch (_) {
        resolve({ installed: true, loggedIn: false, error: String(err || out || 'statut illisible').trim().slice(0, 200) });
      }
    });
  });
}

/** Handler HTTP (admin) : GET /api/ai/cli/status → état d'auth du CLI claude. */
async function status(_req: any, res: any): Promise<void> {
  res.json(await authStatus());
}

// ───────── Connexion interactive (OAuth) pilotée depuis Ryvie ─────────
// `claude auth login` exige un TERMINAL interactif (raw TTY) : impossible via un
// simple pipe. On lui en fournit un avec `script` (util-linux) — aucune dépendance
// native (node-pty). Le flux : (1) on lance le login, on capte le lien d'autorisation
// affiché par le CLI ; (2) l'utilisateur autorise dans son navigateur et récupère un
// code ; (3) on réinjecte ce code dans le PTY → le CLI écrit ~/.claude/.credentials.json.
// Une SEULE session à la fois (relancer tue la précédente). Admin uniquement.
let loginSession: { child: any; buf: string; url: string; done: boolean } | null = null;

function stripAnsi(s: string): string {
  // codes CSI (couleurs, déplacements curseur) + séquences OSC.
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '');
}

function killLogin(): void {
  if (loginSession && loginSession.child) { try { loginSession.child.kill('SIGKILL'); } catch (_) {} }
  loginSession = null;
}

const AUTHORIZE_RE = /https:\/\/[^\s]*oauth\/authorize\?[^\s]+/;

/** Démarre le login et résout avec le lien d'autorisation à ouvrir dans le navigateur. */
async function loginStart(): Promise<{ url: string }> {
  // Échec rapide et explicite si le binaire `claude` n'est pas installé sur la machine
  // (sinon on attendrait 20s un lien qui ne viendra jamais).
  const st = await authStatus();
  if (st.installed === false) {
    throw Object.assign(new Error('Le binaire « claude » n\'est pas installé sur la machine Ryvie.'), { status: 412 });
  }
  killLogin(); // une seule session active
  return new Promise((resolve, reject) => {
    const child = spawn('script', ['-q', '-c', `${claudeBin()} auth login --claudeai`, '/dev/null'], {
      env: { ...process.env, COLUMNS: '1000', LINES: '50', TERM: 'xterm-256color' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const session = { child, buf: '', url: '', done: false };
    loginSession = session;
    let settled = false;
    const onData = (d: Buffer) => {
      session.buf += stripAnsi(d.toString());
      if (!session.url) {
        const m = session.buf.match(AUTHORIZE_RE);
        if (m && !settled) { session.url = m[0]; settled = true; clearTimeout(timer); resolve({ url: session.url }); }
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e: any) => {
      if (!settled) { settled = true; clearTimeout(timer); killLogin(); reject(new Error('Lancement du login impossible: ' + e.message)); }
    });
    child.on('close', () => { session.done = true; });
    const timer = setTimeout(() => {
      if (!settled) { settled = true; killLogin(); reject(Object.assign(new Error('Lien d\'autorisation non obtenu (délai dépassé)'), { status: 504 })); }
    }, 20000);
    // Filet : tue une session abandonnée (utilisateur qui ne colle jamais le code).
    setTimeout(() => { if (loginSession === session && !session.done) killLogin(); }, 300000);
  });
}

/** Réinjecte le code collé par l'utilisateur ; renvoie l'état réel (loggedIn) après coup. */
async function loginComplete(code: string): Promise<{ ok: boolean; error?: string; email?: string }> {
  const session = loginSession;
  if (!session || !session.child || session.done) {
    return { ok: false, error: 'Aucune connexion en cours. Relancez « Se connecter ».' };
  }
  const c = String(code || '').trim();
  if (!c) return { ok: false, error: 'Code vide' };
  session.buf = ''; // repart propre pour détecter la réaction au code
  try { session.child.stdin.write(c + '\n'); } catch (_) { return { ok: false, error: 'Envoi du code impossible' }; }

  // Attend la fin du process (succès) ou un message d'erreur du CLI.
  const outcome = await new Promise<'closed' | 'invalid' | 'timeout'>((resolve) => {
    let done = false;
    const finish = (v: any) => { if (!done) { done = true; resolve(v); } };
    const iv = setInterval(() => { if (/invalid code|expired|error|failed|échou/i.test(session.buf)) finish('invalid'); }, 300);
    session.child.on('close', () => { clearInterval(iv); finish('closed'); });
    setTimeout(() => { clearInterval(iv); finish('timeout'); }, 15000);
  });

  // Vérité terrain : on relit l'état d'auth réel (le CLI a-t-il écrit les credentials ?).
  const st = await authStatus();
  if (st.loggedIn) { killLogin(); return { ok: true, email: st.email }; }
  // Échec : si le CLI a re-demandé un code (session vivante), on la garde pour réessai ;
  // sinon on nettoie.
  if (session.done || outcome === 'closed') killLogin();
  return { ok: false, error: outcome === 'invalid' ? 'Code invalide. Vérifiez de l\'avoir copié en entier.' : 'Connexion non confirmée. Réessayez.' };
}

/** Déconnecte le binaire `claude` local (`claude auth logout`). Non interactif. */
function logout(): Promise<{ ok: boolean; error?: string }> {
  killLogin(); // annule un éventuel login en cours
  return new Promise((resolve) => {
    const child = spawn(claudeBin(), ['auth', 'logout'], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} resolve({ ok: false, error: 'timeout' }); }, 10000);
    child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    child.on('error', (e: any) => { clearTimeout(timer); resolve({ ok: false, error: String(e.message || e).slice(0, 200) }); });
    child.on('close', (code: number) => { clearTimeout(timer); resolve(code === 0 ? { ok: true } : { ok: false, error: String(err || `claude exited ${code}`).slice(0, 200) }); });
  });
}

async function loginStartHandler(_req: any, res: any): Promise<void> {
  try { res.json(await loginStart()); }
  catch (e: any) { res.status(e.status || 500).json({ error: e.message || 'Échec' }); }
}
async function loginCompleteHandler(req: any, res: any): Promise<void> {
  const r = await loginComplete((req.body || {}).code);
  res.status(r.ok ? 200 : 400).json(r);
}
function loginCancelHandler(_req: any, res: any): void { killLogin(); res.json({ ok: true }); }
async function logoutHandler(_req: any, res: any): Promise<void> { res.json(await logout()); }

module.exports = {
  chatCompletions, responses, authStatus, status,
  loginStartHandler, loginCompleteHandler, loginCancelHandler, logoutHandler
};
