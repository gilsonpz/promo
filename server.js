const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
app.use(cors());
app.use(express.json({ limit: '100mb' }));

const chunks = {};

app.get('/', (req, res) => {
  res.json({ status: 'online', server: 'Gilson Supremo', version: '4.0' });
});

app.post('/chunk', (req, res) => {
  const { key, index, data, total } = req.body;
  if (!chunks[key]) chunks[key] = {};
  chunks[key][index] = data;
  console.log(`Chunk ${index+1}/${total} recebido`);
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

async function postReel(sessionid, username, caption, videoPath) {
  let browser;
  try {
    console.log('Abrindo browser...');
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu']
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');

    // Define sessão
    await page.setCookie({ name:'sessionid', value:sessionid, domain:'.instagram.com', path:'/', httpOnly:true, secure:true });

    console.log('Acessando Instagram...');
    await page.goto('https://www.instagram.com/', { waitUntil:'networkidle2', timeout:40000 });
    await sleep(3000);

    // Verifica login
    const loggedIn = await page.evaluate(() => !document.querySelector('input[name="username"]'));
    if (!loggedIn) throw new Error('Session ID inválido ou expirado');
    console.log('Logado!');

    // Vai direto para criação de Reel
    await page.goto('https://www.instagram.com/', { waitUntil:'networkidle2' });
    await sleep(2000);

    // Clica no botão criar (ícone +)
    const clicked = await page.evaluate(() => {
      const svgs = document.querySelectorAll('svg');
      for (const svg of svgs) {
        const label = svg.getAttribute('aria-label') || '';
        if (label.includes('Criar') || label.includes('Create') || label.includes('Nova')) {
          svg.closest('[role="link"],[role="button"],a')?.click();
          return true;
        }
      }
      // Tenta pelo texto
      const spans = document.querySelectorAll('span');
      for (const s of spans) {
        if (s.textContent.trim() === 'Criar' || s.textContent.trim() === 'Create') {
          s.closest('[role="link"],[role="button"],a')?.click();
          return true;
        }
      }
      return false;
    });

    if (!clicked) throw new Error('Botão Criar não encontrado');
    await sleep(2000);

    // Clica em "Reel"
    await page.evaluate(() => {
      const items = document.querySelectorAll('[role="menuitem"],[role="option"],span,div');
      for (const el of items) {
        if (el.textContent.trim() === 'Reel' || el.textContent.trim() === 'Reels') {
          el.click(); return;
        }
      }
    });
    await sleep(1500);

    // Upload do vídeo
    console.log('Fazendo upload...');
    const input = await page.$('input[type="file"]');
    if (!input) throw new Error('Campo de upload não encontrado');
    await input.uploadFile(videoPath);
    await sleep(10000);

    // Clica em Avançar (pode ser necessário múltiplas vezes)
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => {
        const btns = [...document.querySelectorAll('[role="button"],button')];
        const next = btns.find(b => b.textContent.includes('Avançar') || b.textContent.includes('Next') || b.textContent.includes('Continue'));
        if (next) next.click();
      });
      await sleep(2000);
    }

    // Adiciona legenda
    if (caption) {
      console.log('Adicionando legenda...');
      const captionEl = await page.$('[aria-label*="legenda"],[aria-label*="caption"],[aria-label*="Caption"],div[contenteditable="true"]');
      if (captionEl) {
        await captionEl.click();
        await page.keyboard.type(caption, { delay: 20 });
        await sleep(1000);
      }
    }

    // Clica em Compartilhar/Share
    console.log('Clicando em compartilhar...');
    const shared = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('[role="button"],button')];
      const share = btns.find(b =>
        b.textContent.includes('Compartilhar') ||
        b.textContent.includes('Share') ||
        b.textContent.includes('Publicar') ||
        b.textContent.includes('Publish')
      );
      if (share) { share.click(); return true; }
      return false;
    });

    if (!shared) throw new Error('Botão compartilhar não encontrado');
    console.log('Aguardando confirmação...');
    await sleep(12000);

    console.log(`✅ Reel publicado! @${username}`);
    return { success: true, media_id: Date.now().toString() };

  } finally {
    if (browser) { try { await browser.close(); } catch(_) {} }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`\n🚀 Gilson Supremo v4 rodando na porta ${PORT}\n`));
