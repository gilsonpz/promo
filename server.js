const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
app.use(cors());
app.use(express.json({ limit: '100mb' }));
const chunks = {};

app.get('/', (req, res) => res.json({ status: 'online', server: 'Gilson Supremo', version: '4.5' }));

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
    const result = await postReel(sessionid, username, caption || '', videoPath);
    try { fs.unlinkSync(videoPath); } catch(_) {}
    res.json(result);
  } catch(e) {
    try { fs.unlinkSync(videoPath); } catch(_) {}
    console.error('Erro:', e.message);
    res.json({ error: e.message });
  }
});

// Pega o último post do perfil via API pública
function getLastPostTime(username, sessionid) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'www.instagram.com',
      path: `/api/v1/users/web_profile_info/?username=${username}`,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Cookie': `sessionid=${sessionid}`,
        'X-IG-App-ID': '936619743392459'
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const edges = json?.data?.user?.edge_owner_to_timeline_media?.edges;
          if (edges && edges.length > 0) {
            resolve(edges[0].node.taken_at_timestamp);
          } else resolve(null);
        } catch(e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

async function safeClick(page, texts) {
  return await page.evaluate((texts) => {
    const all = [...document.querySelectorAll('button,[role="button"],a,span,div')];
    for (const el of all) {
      const t = (el.innerText || el.textContent || '').trim();
      if (texts.includes(t) && el.click) { el.click(); return t; }
    }
    for (const el of [...document.querySelectorAll('*')]) {
      const label = el.getAttribute('aria-label') || '';
      if (texts.some(t => label.includes(t)) && el.click) { el.click(); return label; }
    }
    return null;
  }, texts);
}

async function postReel(sessionid, username, caption, videoPath) {
  let browser;
  const cleanUsername = username.replace('@','');

  // Pega timestamp do último post ANTES de publicar
  console.log('Verificando último post antes de publicar...');
  const postTimeBefore = await getLastPostTime(cleanUsername, sessionid);
  console.log('Último post antes:', postTimeBefore ? new Date(postTimeBefore*1000).toISOString() : 'nenhum');

  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--window-size=1280,900']
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setCookie({ name:'sessionid', value:sessionid, domain:'.instagram.com', path:'/', httpOnly:true, secure:true });

    console.log('Acessando Instagram...');
    await page.goto('https://www.instagram.com/', { waitUntil:'networkidle2', timeout:40000 });
    await sleep(4000);

    const loggedIn = await page.evaluate(() => !document.querySelector('input[name="username"]'));
    if (!loggedIn) throw new Error('Session ID inválido ou expirado');
    console.log('Logado!');

    await safeClick(page, ['Criar','Create','Nova publicação','New post']);
    await sleep(2500);

    await safeClick(page, ['Reel','Reels']);
    await sleep(2000);

    // Encontra input de arquivo
    let fileInput = null;
    for (let i = 0; i < 20; i++) {
      await page.evaluate(() => {
        document.querySelectorAll('input[type="file"]').forEach(inp => {
          inp.style.cssText = 'display:block!important;visibility:visible!important;opacity:1!important;position:fixed!important;top:0!important;left:0!important;z-index:99999!important;width:1px!important;height:1px!important;';
          inp.removeAttribute('hidden');
        });
      });
      fileInput = await page.$('input[type="file"]');
      if (fileInput) { console.log(`Input encontrado (tentativa ${i+1})`); break; }
      await page.evaluate(() => {
        [...document.querySelectorAll('button,[role="button"],div,span')].forEach(b => {
          const t = (b.innerText || '').trim();
          if ((t.includes('Selecionar') || t.includes('Select') || t.includes('computador') || t.includes('computer')) && b.click) b.click();
        });
      });
      await sleep(1000);
    }

    if (!fileInput) {
      await page.evaluate(() => {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.id = '__g__'; inp.accept = 'video/*';
        inp.style.cssText = 'position:fixed;top:0;left:0;z-index:999999;width:1px;height:1px;opacity:0.01;';
        document.body.appendChild(inp);
      });
      fileInput = await page.$('#__g__');
    }

    if (!fileInput) throw new Error('Campo de upload não encontrado');

    console.log('Fazendo upload...');
    await fileInput.uploadFile(videoPath);
    console.log('Processando vídeo (20s)...');
    await sleep(20000);

    // Avança
    for (let i = 0; i < 5; i++) {
      const r = await safeClick(page, ['Avançar','Next','Continue','Continuar']);
      if (r) { console.log(`Avançou: ${r}`); await sleep(3000); }
    }

    // Legenda
    if (caption) {
      try {
        const el = await page.$('div[contenteditable="true"],textarea');
        if (el) { await el.click(); await el.type(caption, { delay: 15 }); await sleep(1000); }
      } catch(_) {}
    }

    // Compartilha
    console.log('Compartilhando...');
    for (let i = 0; i < 5; i++) {
      const r = await safeClick(page, ['Compartilhar','Share','Publicar','Post','Postar']);
      if (r) { console.log(`Compartilhou: ${r}`); break; }
      await sleep(2000);
    }

    // Aguarda processamento
    console.log('Aguardando publicação (30s)...');
    await sleep(30000);
    await browser.close();
    browser = null;

    // VERIFICAÇÃO REAL: checa se apareceu novo post no perfil
    console.log('Verificando se post apareceu no perfil...');
    let confirmed = false;
    for (let i = 0; i < 6; i++) {
      await sleep(5000);
      const postTimeAfter = await getLastPostTime(cleanUsername, sessionid);
      console.log(`Verificação ${i+1}: último post = ${postTimeAfter ? new Date(postTimeAfter*1000).toISOString() : 'nenhum'}`);
      if (postTimeAfter && (!postTimeBefore || postTimeAfter > postTimeBefore)) {
        confirmed = true;
        console.log('✅ Post confirmado no perfil!');
        break;
      }
    }

    if (confirmed) {
      return { success: true, media_id: Date.now().toString(), confirmed: true };
    } else {
      // Post pode ter sido feito mas não aparece ainda (delay do Instagram)
      console.log('⚠️ Post não confirmado no perfil ainda (pode aparecer em breve)');
      return { success: false, error: 'Reel enviado mas não confirmado no perfil. Verifique o Instagram manualmente.' };
    }

  } finally {
    if (browser) { try { await browser.close(); } catch(_) {} }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Gilson Supremo v4.5 — porta ${PORT}`));
