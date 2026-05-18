const express = require('express');
const cors = require('cors');
const https = require('https');
const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Storage de chunks em memória
const chunks = {};

// Status
app.get('/', (req, res) => {
  res.json({ status: 'online', server: 'Gilson Supremo', version: '3.0' });
});

// Recebe chunk do vídeo
app.post('/chunk', (req, res) => {
  const { key, index, data, total } = req.body;
  if (!key || index === undefined || !data) return res.json({ error: 'Dados inválidos' });
  if (!chunks[key]) chunks[key] = {};
  chunks[key][index] = data;
  console.log(`Chunk ${index + 1}/${total} recebido — ${key}`);
  res.json({ ok: true, received: Object.keys(chunks[key]).length, total });
});

// Publica o Reel
app.post('/publish', async (req, res) => {
  const { key, total, sessionid, username, caption } = req.body;

  if (!chunks[key]) return res.json({ error: 'Chunks não encontrados. Reenvie o vídeo.' });
  if (Object.keys(chunks[key]).length < total) {
    return res.json({ error: `Chunks incompletos: ${Object.keys(chunks[key]).length}/${total}` });
  }

  // Remonta o vídeo
  let b64 = '';
  for (let i = 0; i < total; i++) b64 += chunks[key][i] || '';
  delete chunks[key];

  const video = Buffer.from(b64, 'base64');
  console.log(`\n📱 Publicando @${username} — ${(video.length/1024/1024).toFixed(1)} MB`);

  try {
    const result = await postReel(sessionid, username, caption || '', video);
    console.log('Resultado:', result);
    res.json(result);
  } catch(e) {
    console.error('Erro:', e.message);
    res.json({ error: e.message });
  }
});

// ===================== INSTAGRAM API =====================

async function postReel(sessionid, username, caption, video) {
  const upload_id = Date.now().toString();

  // Busca o csrftoken e mid do cookie de sessão
  const tokens = await getTokens(sessionid);
  console.log('Tokens:', tokens);

  // PASSO 1: Upload do vídeo
  console.log('⬆️  Fazendo upload...');
  const uploaded = await uploadVideo(sessionid, tokens, upload_id, video);
  console.log('Upload resultado:', uploaded.status, JSON.stringify(uploaded.data).slice(0, 200));

  if (uploaded.status !== 200 && !uploaded.data?.upload_id) {
    return { error: `Upload falhou (${uploaded.status}): ${uploaded.data?.message || uploaded.data?._raw || 'sem resposta'}` };
  }

  console.log('✅ Upload OK! Aguardando processamento...');
  await sleep(8000);

  // PASSO 2: Configurar como Reel
  console.log('📤 Configurando como Reel...');
  const config = await configureReel(sessionid, tokens, upload_id, caption);
  console.log('Config resultado:', config.status, JSON.stringify(config.data).slice(0, 300));

  if (config.status === 200 && (config.data?.status === 'ok' || config.data?.media)) {
    const media_id = config.data?.media?.id || config.data?.media?.pk || upload_id;
    return { success: true, media_id };
  }

  // Fallback: clips/share
  console.log('🔄 Tentando clips/share...');
  const share = await shareClip(sessionid, tokens, upload_id, caption);
  console.log('Share resultado:', share.status, JSON.stringify(share.data).slice(0, 300));

  if (share.status === 200 && (share.data?.status === 'ok' || share.data?.media)) {
    const media_id = share.data?.media?.id || share.data?.media?.pk || upload_id;
    return { success: true, media_id };
  }

  const err = config.data?.message || share.data?.message || config.data?.feedback_message || `HTTP ${config.status}`;
  return { error: err };
}

async function getTokens(sessionid) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'www.instagram.com',
      path: '/',
      method: 'GET',
      headers: {
        'Cookie': `sessionid=${sessionid}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        const csrf = (res.headers['set-cookie'] || []).join(';').match(/csrftoken=([^;]+)/)?.[1]
          || data.match(/"csrf_token":"([^"]+)"/)?.[1]
          || 'missing';
        const mid = (res.headers['set-cookie'] || []).join(';').match(/mid=([^;]+)/)?.[1] || '';
        resolve({ csrf, mid });
      });
    });
    req.on('error', () => resolve({ csrf: 'missing', mid: '' }));
    req.end();
  });
}

function uploadVideo(sessionid, tokens, upload_id, video) {
  return new Promise((resolve) => {
    const rupload_params = JSON.stringify({
      upload_id,
      media_type: 2,
      upload_media_duration_ms: 15000,
      upload_media_width: 720,
      upload_media_height: 1280
    });

    const options = {
      hostname: 'www.instagram.com',
      port: 443,
      path: `/rupload_igvideo/${upload_id}`,
      method: 'POST',
      headers: {
        'User-Agent': 'Instagram 269.0.0.18.75 Android (26/8.0.0; 480dpi; 1080x1920; samsung; SM-G930F)',
        'Cookie': `sessionid=${sessionid}; csrftoken=${tokens.csrf}`,
        'X-CSRFToken': tokens.csrf,
        'X-IG-App-ID': '567067343352427',
        'X-Instagram-Rupload-Params': rupload_params,
        'X-Entity-Type': 'video/mp4',
        'X-Entity-Name': `reel_${upload_id}`,
        'X-Entity-Length': String(video.length),
        'Offset': '0',
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(video.length)
      }
    };

    const req = https.request(options, (res) => {
      const parts = [];
      res.on('data', c => parts.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(parts).toString();
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch(e) { resolve({ status: res.statusCode, data: { _raw: raw.slice(0, 300) } }); }
      });
    });
    req.on('error', e => resolve({ status: 0, data: { error: e.message } }));
    req.write(video);
    req.end();
  });
}

function configureReel(sessionid, tokens, upload_id, caption) {
  return new Promise((resolve) => {
    const body = new URLSearchParams({
      upload_id,
      caption,
      source_type: '4',
      clips_share_preview_to_feed: '1',
      _csrftoken: tokens.csrf,
      _uuid: upload_id
    }).toString();

    const options = {
      hostname: 'www.instagram.com',
      port: 443,
      path: '/api/v1/media/configure_to_clips/',
      method: 'POST',
      headers: {
        'User-Agent': 'Instagram 269.0.0.18.75 Android (26/8.0.0; 480dpi; 1080x1920; samsung; SM-G930F)',
        'Cookie': `sessionid=${sessionid}; csrftoken=${tokens.csrf}`,
        'X-CSRFToken': tokens.csrf,
        'X-IG-App-ID': '567067343352427',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      const parts = [];
      res.on('data', c => parts.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(parts).toString();
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch(e) { resolve({ status: res.statusCode, data: { _raw: raw.slice(0, 300) } }); }
      });
    });
    req.on('error', e => resolve({ status: 0, data: { error: e.message } }));
    req.write(body);
    req.end();
  });
}

function shareClip(sessionid, tokens, upload_id, caption) {
  return new Promise((resolve) => {
    const body = new URLSearchParams({
      upload_id,
      caption,
      source_type: 'library',
      clips_share_preview_to_feed: '1',
      _csrftoken: tokens.csrf
    }).toString();

    const options = {
      hostname: 'www.instagram.com',
      port: 443,
      path: '/api/v1/clips/share/',
      method: 'POST',
      headers: {
        'User-Agent': 'Instagram 269.0.0.18.75 Android (26/8.0.0; 480dpi; 1080x1920; samsung; SM-G930F)',
        'Cookie': `sessionid=${sessionid}; csrftoken=${tokens.csrf}`,
        'X-CSRFToken': tokens.csrf,
        'X-IG-App-ID': '567067343352427',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      const parts = [];
      res.on('data', c => parts.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(parts).toString();
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch(e) { resolve({ status: res.statusCode, data: { _raw: raw.slice(0, 300) } }); }
      });
    });
    req.on('error', e => resolve({ status: 0, data: { error: e.message } }));
    req.write(body);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`\n🚀 Gilson Supremo Server rodando na porta ${PORT}\n`));
