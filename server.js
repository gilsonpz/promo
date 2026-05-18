const express = require('express');
const cors = require('cors');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
app.use(cors());
app.use(express.json({ limit: '100mb' }));
const chunks = {};

app.get('/', (req, res) => res.json({ status: 'online', server: 'Gilson Supremo', version: '5.0' }));

app.post('/chunk', (req, res) => {
  const { key, index, data, total } = req.body;
  if (!chunks[key]) chunks[key] = {};
  chunks[key][index] = data;
  console.log(`Chunk ${index+1}/${total}`);
  res.json({ ok: true, received: Object.keys(chunks[key]).length });
});

app.post('/publish', async (req, res) => {
  const { key, total, sessionid, username, caption } = req.body;
  if (!chunks[key]) return res.json({ error: 'Chunks não encontrados' });
  let b64 = '';
  for (let i = 0; i < total; i++) b64 += chunks[key][i] || '';
  delete chunks[key];
  const buf = Buffer.from(b64, 'base64');
  const videoPath = path.join(os.tmpdir(), `reel_${Date.now()}.mp4`);
  fs.writeFileSync(videoPath, buf);
  console.log(`\nPublicando @${username} — ${(buf.length/1024/1024).toFixed(1)} MB`);
  try {
    const result = await publishReel(sessionid, username, caption || '', videoPath, buf);
    try { fs.unlinkSync(videoPath); } catch(_) {}
    res.json(result);
  } catch(e) {
    try { fs.unlinkSync(videoPath); } catch(_) {}
    console.error('Erro:', e.message);
    res.json({ error: e.message });
  }
});

function igReq(opts, body) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: opts.host || 'i.instagram.com',
      port: 443,
      path: opts.path,
      method: opts.method || 'POST',
      headers: {
        'User-Agent': 'Instagram 269.0.0.18.75 Android (26/8.0.0; 480dpi; 1080x1920; samsung; SM-G930F; herolte; samsungexynos8890; en_US; 301484483)',
        'Cookie': `sessionid=${opts.sessionid}`,
        'X-IG-App-ID': '567067343352427',
        'X-IG-Capabilities': '3brTvw==',
        'X-IG-Connection-Type': 'WIFI',
        'Accept-Language': 'en-US',
        'Accept-Encoding': 'gzip, deflate',
        ...(opts.headers || {}),
        ...(body ? { 'Content-Length': String(Buffer.isBuffer(body) ? body.length : Buffer.byteLength(body)) } : {})
      }
    }, (res) => {
      const parts = [];
      res.on('data', c => parts.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(parts);
        try { resolve({ status: res.statusCode, data: JSON.parse(raw.toString()) }); }
        catch(e) { resolve({ status: res.statusCode, data: { _raw: raw.toString().slice(0,300) } }); }
      });
    });
    req.on('error', e => resolve({ status: 0, data: { error: e.message } }));
    if (body) req.write(body);
    req.end();
  });
}

async function getUserInfo(sessionid, username) {
  const res = await igReq({
    host: 'www.instagram.com',
    path: `/api/v1/users/web_profile_info/?username=${username.replace('@','')}`,
    method: 'GET',
    sessionid,
    headers: { 'X-IG-App-ID': '936619743392459' }
  });
  console.log('UserInfo:', res.status, JSON.stringify(res.data).slice(0,200));
  const user = res.data?.data?.user;
  if (!user) throw new Error('Usuário não encontrado ou sessão inválida');
  return { userId: user.id, username: user.username };
}

async function publishReel(sessionid, username, caption, videoPath, videoBuf) {
  // 1. Busca user ID
  console.log('Buscando informações do usuário...');
  const { userId } = await getUserInfo(sessionid, username);
  console.log('User ID:', userId);

  const upload_id = Date.now().toString();

  // 2. Inicia upload do vídeo
  console.log('Iniciando upload do vídeo...');
  const ruploadParams = JSON.stringify({
    upload_id,
    media_type: 2,
    upload_media_duration_ms: 15000,
    upload_media_width: 720,
    upload_media_height: 1280
  });

  const uploadRes = await igReq({
    host: 'www.instagram.com',
    path: `/rupload_igvideo/${upload_id}`,
    method: 'POST',
    sessionid,
    headers: {
      'X-Instagram-Rupload-Params': ruploadParams,
      'X-Entity-Type': 'video/mp4',
      'X-Entity-Name': upload_id,
      'X-Entity-Length': String(videoBuf.length),
      'Offset': '0',
      'Content-Type': 'application/octet-stream',
    }
  }, videoBuf);

  console.log('Upload result:', uploadRes.status, JSON.stringify(uploadRes.data).slice(0,200));

  if (uploadRes.status !== 200 && !uploadRes.data?.upload_id) {
    throw new Error(`Upload falhou (${uploadRes.status}): ${uploadRes.data?.message || uploadRes.data?._raw || 'sem resposta'}`);
  }

  // 3. Aguarda processamento
  console.log('Aguardando processamento (8s)...');
  await sleep(8000);

  // 4. Configura como Reel
  console.log('Configurando como Reel...');
  const configBody = new URLSearchParams({
    upload_id,
    caption,
    source_type: '4',
    clips_share_preview_to_feed: '1',
    _uid: userId,
    device_id: 'android-' + upload_id.slice(-8)
  }).toString();

  const configRes = await igReq({
    host: 'www.instagram.com',
    path: '/api/v1/clips/share/',
    method: 'POST',
    sessionid,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  }, Buffer.from(configBody));

  console.log('Config result:', configRes.status, JSON.stringify(configRes.data).slice(0,300));

  if (configRes.status === 200 && (configRes.data?.status === 'ok' || configRes.data?.media)) {
    const mediaId = configRes.data?.media?.id || configRes.data?.media?.pk || upload_id;
    console.log('✅ Reel publicado! Media ID:', mediaId);
    return { success: true, media_id: mediaId, confirmed: true };
  }

  // 5. Fallback: configure_to_clips
  console.log('Tentando configure_to_clips...');
  const configBody2 = new URLSearchParams({
    upload_id,
    caption,
    source_type: '4',
    clips_share_preview_to_feed: '1'
  }).toString();

  const configRes2 = await igReq({
    host: 'www.instagram.com',
    path: '/api/v1/media/configure_to_clips/',
    method: 'POST',
    sessionid,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  }, Buffer.from(configBody2));

  console.log('Config2 result:', configRes2.status, JSON.stringify(configRes2.data).slice(0,300));

  if (configRes2.status === 200 && (configRes2.data?.status === 'ok' || configRes2.data?.media)) {
    const mediaId = configRes2.data?.media?.id || configRes2.data?.media?.pk || upload_id;
    console.log('✅ Reel publicado via fallback! Media ID:', mediaId);
    return { success: true, media_id: mediaId, confirmed: true };
  }

  const err = configRes.data?.message || configRes2.data?.message || 
              configRes.data?.feedback_message || `HTTP ${configRes.status}`;
  throw new Error(err);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Gilson Supremo v5.0 — porta ${PORT}`));
