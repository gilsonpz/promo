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

app.get('/', (req, res) => res.json({ status: 'online', server: 'Gilson Supremo', version: '4.3' }));

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

async function clickElement(page, texts) {
  return await page.evaluate((texts) => {
    const all = [...document.querySelectorAll('button, [role="button"], a, span, div')];
    for (const el of all) {
      const t = (el.textContent || '').trim();
      if (texts.includes(t) && typeof el.click === 'function') {
        el.click();
        return t;
      }
    }
    // Tenta por aria-label
    for (const el of document.querySelectorAll('*')) {
      const label = el.getAttribute('aria-label') || '';
      if (texts.some(t => label.includes(t)) && typeof el.click === 'function') {
        el.click();
        return label;
      }
    }
    return null;
  }, texts);
}

async function postReel(sessionid, username, caption, videoPath) {
  let browser;
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
    console.log('✅ Logado!');

    // Clica em Criar
    console.log('Clicando em Criar...');
    const createResult = await clickElement(page, ['Criar','Create','Nova publicação','New post']);
    console.log('Criar clicado:', createResult);
    await sleep(2500);

    // Clica em Reel
    console.log('Selecionando Reel...');
    const reelResult = await clickElement(page, ['Reel','Reels']);
    console.log('Reel clicado:', reelResult);
    await sleep(2000);

    // Procura o input de arquivo
    console.log('Procurando campo de upload...');
    let fileInput = null;

    for (let i = 0; i < 20; i++) {
      // Expõe inputs ocultos
      await page.evaluate(() => {
        document.querySelectorAll('input[type="file"]').forEach(inp => {
          inp.style.cssText = 'display:block!important;visibility:visible!important;opacity:1!important;position:fixed!important;top:0!important;left:0!important;z-index:99999!important;width:100px!important;height:100px!important;';
          inp.removeAttribute('hidden');
        });
      });

      fileInput = await page.$('input[type="file"]');
      if (fileInput) { console.log(`Input encontrado na tentativa ${i+1}`); break; }

      // Tenta clicar em botões de seleção
      await page.evaluate(() => {
        const btns = [...document.querySelectorAll('button,[role="button"],div,span')];
        for (const b of btns) {
          const t = (b.textContent || '').trim();
          if ((t.includes('Selecionar') || t.includes('Select') || t.includes('computador') || t.includes('computer') || t.includes('dispositivo') || t.includes('device')) && typeof b.click === 'function') {
            b.click();
            return t;
          }
        }
      });

      await sleep(1000);
    }

    // Último recurso: cria input no DOM
    if (!fileInput) {
      console.log('Criando input manualmente...');
      await page.evaluate(() => {
        const inp = document.createElement('input');
        inp.type = 'file';
        inp.id = '__gilson_input__';
        inp.accept = 'video/*,video/mp4';
        inp.style.cssText = 'position:fixed;top:0;left:0;z-index:999999;width:1px;height:1px;opacity:0.01;';
        document.body.appendChild(inp);
      });
      fileInput = await page.$('#__gilson_input__');
    }

    if (!fileInput) throw new Error('Não foi possível criar campo de upload mesmo com injeção');

    console.log('Fazendo upload do vídeo...');
    await fileInput.uploadFile(videoPath);
    console.log('Aguardando processamento (15s)...');
    await sleep(15000);

    // Avança
    console.log('Avançando pelas telas...');
    for (let i = 0; i < 5; i++) {
      const r = await clickElement(page, ['Avançar','Next','Continue','Continuar']);
      if (r) { console.log(`Avançou: ${r}`); await sleep(2500); }
    }

    // Legenda
    if (caption) {
      console.log('Adicionando legenda...');
      try {
        const el = await page.$('div[contenteditable="true"], textarea');
        if (el) { await el.click(); await el.type(caption, { delay: 15 }); await sleep(1000); }
      } catch(_) {}
    }

    // Compartilha
    console.log('Compartilhando...');
    const shareResult = await clickElement(page, ['Compartilhar','Share','Publicar','Post']);
    if (!shareResult) throw new Error('Botão compartilhar não encontrado');
    console.log('Compartilhar clicado:', shareResult);
    await sleep(15000);

    console.log(`✅ Publicado! @${username}`);
    return { success: true, media_id: Date.now().toString() };

  } finally {
    if (browser) { try { await browser.close(); } catch(_) {} }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Gilson Supremo v4.3 — porta ${PORT}`));
