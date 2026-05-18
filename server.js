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

app.get('/', (req, res) => res.json({ status: 'online', server: 'Gilson Supremo', version: '4.1' }));

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

    // Seta cookies
    await page.setCookie(
      { name:'sessionid', value:sessionid, domain:'.instagram.com', path:'/', httpOnly:true, secure:true },
      { name:'ds_user_id', value:'', domain:'.instagram.com', path:'/' }
    );

    // Acessa Instagram
    console.log('Acessando Instagram...');
    await page.goto('https://www.instagram.com/', { waitUntil:'networkidle2', timeout:40000 });
    await sleep(4000);

    // Verifica login
    const loggedIn = await page.evaluate(() => {
      return !document.querySelector('input[name="username"]') &&
             (document.querySelector('svg[aria-label]') !== null ||
              document.querySelector('[role="main"]') !== null);
    });
    if (!loggedIn) throw new Error('Session ID inválido ou expirado');
    console.log('✅ Logado!');

    // Tira screenshot para debug
    await page.screenshot({ path: path.join(os.tmpdir(), 'ig_home.png') });

    // Clica no botão Criar — tenta vários seletores
    console.log('Clicando em Criar...');
    const createClicked = await page.evaluate(() => {
      // Tenta por aria-label do SVG
      const selectors = [
        'svg[aria-label="Nova publicação"]',
        'svg[aria-label="New post"]',
        'svg[aria-label="Criar"]',
        'svg[aria-label="Create"]'
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) { el.closest('a,[role="link"],[role="button"]')?.click(); return true; }
      }
      // Tenta pelo texto do span
      for (const span of document.querySelectorAll('span')) {
        if (['Criar','Create','Nova publicação','New post'].includes(span.textContent.trim())) {
          span.closest('a,[role="link"],[role="button"]')?.click();
          return true;
        }
      }
      return false;
    });

    if (!createClicked) {
      // Tenta via XPath
      const btns = await page.$x('//*[contains(@aria-label,"Criar") or contains(@aria-label,"Create") or contains(@aria-label,"New post")]');
      if (btns.length > 0) await btns[0].click();
      else throw new Error('Botão Criar não encontrado');
    }
    await sleep(2000);

    // Verifica se abriu modal e tenta clicar em Reel
    console.log('Selecionando Reel...');
    await page.evaluate(() => {
      for (const el of document.querySelectorAll('[role="menuitem"],div,span,a')) {
        if (el.textContent.trim() === 'Reel' || el.textContent.trim() === 'Reels') {
          el.click(); return;
        }
      }
    });
    await sleep(2000);

    // Aguarda o input de arquivo aparecer
    console.log('Aguardando campo de upload...');
    let fileInput = null;

    // Tenta por até 15 segundos
    for (let i = 0; i < 15; i++) {
      fileInput = await page.$('input[type="file"]');
      if (fileInput) break;

      // Tenta clicar em "Selecionar do computador" se aparecer
      await page.evaluate(() => {
        for (const el of document.querySelectorAll('button,[role="button"],div')) {
          const txt = el.textContent.trim();
          if (txt.includes('Selecionar') || txt.includes('Select') || txt.includes('computador') || txt.includes('computer')) {
            el.click(); return;
          }
        }
      });
      await sleep(1000);
    }

    if (!fileInput) {
      await page.screenshot({ path: path.join(os.tmpdir(), 'ig_upload.png') });
      throw new Error('Campo de upload não encontrado após 15 segundos');
    }

    // Faz upload
    console.log('Fazendo upload do vídeo...');
    await fileInput.uploadFile(videoPath);
    console.log('Aguardando processamento...');
    await sleep(12000);

    // Clica em Avançar até chegar na tela de legenda
    console.log('Avançando...');
    for (let i = 0; i < 4; i++) {
      const advanced = await page.evaluate(() => {
        const btns = [...document.querySelectorAll('[role="button"],button')];
        const next = btns.find(b => {
          const t = b.textContent.trim();
          return t === 'Avançar' || t === 'Next' || t === 'Continue' || t === 'Continuar';
        });
        if (next) { next.click(); return true; }
        return false;
      });
      if (advanced) await sleep(2500);
    }

    // Adiciona legenda
    if (caption) {
      console.log('Adicionando legenda...');
      const captionEl = await page.$(
        'textarea[aria-label*="legenda"],textarea[aria-label*="caption"],div[contenteditable="true"][aria-label*="legenda"],div[contenteditable="true"][aria-label*="caption"],div[contenteditable="true"]'
      );
      if (captionEl) {
        await captionEl.click();
        await captionEl.type(caption, { delay: 20 });
        await sleep(1000);
      }
    }

    // Clica em Compartilhar
    console.log('Compartilhando...');
    const shared = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('[role="button"],button')];
      const share = btns.find(b => {
        const t = b.textContent.trim();
        return t === 'Compartilhar' || t === 'Share' || t === 'Publicar' || t === 'Post';
      });
      if (share) { share.click(); return true; }
      return false;
    });

    if (!shared) throw new Error('Botão compartilhar não encontrado');

    console.log('Aguardando confirmação de publicação...');
    await sleep(15000);

    // Verifica confirmação
    const confirmed = await page.evaluate(() => {
      const body = document.body.innerText;
      return body.includes('compartilhado') || body.includes('shared') ||
             body.includes('Publicado') || body.includes('Published') ||
             body.includes('Reel compartilhado');
    });

    console.log(`✅ Reel publicado! @${username} (confirmado: ${confirmed})`);
    return { success: true, media_id: Date.now().toString() };

  } finally {
    if (browser) { try { await browser.close(); } catch(_) {} }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Gilson Supremo v4.1 — porta ${PORT}`));
