// Optional CORS proxy for Vercel (Node serverless function).
//
// Browsers usually can't call api.upstox.com directly (CORS). Deploy this folder to Vercel, then paste
//   https://<your-project>.vercel.app/api/upstox
// into Settings -> "CORS proxy URL". The app calls  <proxy>?url=<encoded Upstox URL>.
//
// Only Upstox hosts are allowed, so this can't be used as an open proxy. Your token is forwarded
// in the Authorization header and is never stored or logged here.

const ALLOWED_HOSTS = new Set(['api.upstox.com', 'assets.upstox.com']);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept');
  if (req.method === 'OPTIONS') return res.status(204).end();

  let target;
  try {
    target = new URL(String(req.query.url || ''));
  } catch {
    return res.status(400).json({ error: 'Missing or invalid ?url=' });
  }
  if (target.protocol !== 'https:' || !ALLOWED_HOSTS.has(target.hostname)) {
    return res.status(403).json({ error: 'Host not allowed' });
  }

  const headers = { Accept: req.headers.accept || 'application/json' };
  if (req.headers.authorization) headers.Authorization = req.headers.authorization;
  if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];

  let body;
  if (req.method === 'POST') {
    body = typeof req.body === 'string' ? req.body : new URLSearchParams(req.body || {}).toString();
  }

  try {
    const upstream = await fetch(target, { method: req.method, headers, body });
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.status(upstream.status);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
    res.setHeader('Cache-Control', target.hostname === 'assets.upstox.com' ? 'public, max-age=3600' : 'no-store');
    return res.send(buf);
  } catch (e) {
    return res.status(502).json({ error: 'Upstream request failed', detail: e.message });
  }
}
