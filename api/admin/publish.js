// Recebe a biblioteca (JSON compactado com gzip) e grava em data/queries.json no GitHub.
// A Vercel faz o deploy automaticamente a cada commit.
import zlib from 'node:zlib';
import { audit, requireAdmin, sameOrigin } from '../_session.js';

const GITHUB_API = 'https://api.github.com';
const FILE_PATH = 'data/queries.json';
const MAX_QUERIES = 2000;

async function readBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function github(path, options) {
  const opts = options || {};
  return fetch(GITHUB_API + path, {
    method: opts.method || 'GET',
    body: opts.body,
    headers: {
      Authorization: 'Bearer ' + process.env.GITHUB_TOKEN,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'queryhub'
    }
  });
}

// Mantém só os campos conhecidos de cada consulta (inclusive o número/ID e a data de atualização)
function sanitize(list) {
  const usedNums = new Set();
  return list.map((q) => {
    let num = Number.isInteger(q.num) && q.num > 0 && !usedNums.has(q.num) ? q.num : undefined;
    if (num) usedNums.add(num);
    return {
      id: String(q.id),
      num: num,
      name: String(q.name),
      categories: Array.isArray(q.categories) ? q.categories.map(String).slice(0, 3) : ['Outros'],
      description: String(q.description || ''),
      source_filename: String(q.source_filename || ''),
      columns: Array.isArray(q.columns) ? q.columns : [],
      primary_columns: Array.isArray(q.primary_columns) ? q.primary_columns : [],
      required_filters: Array.isArray(q.required_filters) ? q.required_filters : [],
      created_at: Number(q.created_at) || Date.now(),
      updated_at: Number(q.updated_at) || undefined,
      raw_json: q.raw_json
    };
  });
}

async function currentSha(repo, branch) {
  const res = await github('/repos/' + repo + '/contents/data?ref=' + encodeURIComponent(branch));
  if (res.status === 404) return null;
  if (!res.ok) throw Object.assign(new Error('github_read'), { status: res.status });
  const list = await res.json();
  const file = Array.isArray(list) ? list.find((f) => f.name === 'queries.json') : null;
  return file ? file.sha : null;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  if (!sameOrigin(req)) return res.status(403).json({ error: 'bad_origin' });

  const session = await requireAdmin(req, res);
  if (!session) return;

  const repo = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';
  if (!process.env.GITHUB_TOKEN || !repo) return res.status(503).json({ error: 'github_not_configured' });

  // 1) Lê e valida o conteúdo enviado
  let list;
  try {
    let raw = await readBody(req);
    if (raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
      raw = zlib.gunzipSync(raw, { maxOutputLength: 60 * 1024 * 1024 });
    }
    list = JSON.parse(raw.toString('utf8'));
  } catch (err) {
    return res.status(400).json({ error: 'invalid_body' });
  }

  if (!Array.isArray(list) || list.length > MAX_QUERIES) {
    return res.status(400).json({ error: 'invalid_library' });
  }
  // Biblioteca vazia é permitida, mas só com confirmação explícita (evita apagar tudo por acidente)
  if (!list.length && req.headers['x-confirm-empty'] !== 'yes') {
    return res.status(400).json({ error: 'empty_not_confirmed' });
  }
  const valid = list.every((q) => q && q.id && q.name && q.raw_json && typeof q.raw_json === 'object');
  if (!valid) return res.status(400).json({ error: 'invalid_library' });

  const clean = sanitize(list);
  const numbered = clean.filter((q) => q.num).length;
  const content = Buffer.from(JSON.stringify(clean), 'utf8').toString('base64');
  const message = 'Atualiza consultas (' + list.length + ') por ' + session.email;

  // 2) Faz o commit (tenta de novo se o arquivo mudou no meio do caminho)
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const sha = await currentSha(repo, branch);
      const body = { message: message, content: content, branch: branch };
      if (sha) body.sha = sha;

      const put = await github('/repos/' + repo + '/contents/' + FILE_PATH, { method: 'PUT', body: JSON.stringify(body) });
      if (put.ok) {
        const data = await put.json();
        audit('publish_ok', { email: session.email, count: list.length, commit: data.commit && data.commit.sha });
        return res.status(200).json({ ok: true, count: list.length, nums: numbered, commit: data.commit && data.commit.sha });
      }
      if (put.status !== 409 && put.status !== 422) {
        audit('publish_failed', { email: session.email, status: put.status });
        return res.status(502).json({ error: put.status === 401 || put.status === 403 ? 'github_auth' : 'github_write', status: put.status });
      }
    }
    return res.status(409).json({ error: 'github_conflict' });
  } catch (err) {
    const auth = err.status === 401 || err.status === 403;
    return res.status(502).json({ error: auth ? 'github_auth' : err.status === 404 ? 'github_repo' : 'github_read' });
  }
}
