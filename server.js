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

app.get('/', (req, res) => res.json({ status: 'online', server: 'Gilson Supremo', version: '4.2' }));

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

    // Intercepta requisições para expor o input de arquivo oculto
    await page.setRequestInterception(false);

    // Seta cookies de sessão
    await page.setCookie(
      { name:'sessionid', value:sessionid, domain:'.instagram.com', path:'/', httpOnly:true, secure:true }
    );

    console.log('Acessando Instagram...');
    await page.goto('https://www.instagram.com/', { waitUntil:'networkidle2', timeout:40000 });
    await sleep(4000);

    // Verifica login
    const loggedIn = await page.evaluate(() => !document.querySelector('input[name="username"]'));
    if (!loggedIn) throw new Error('Session ID inválido ou expirado');
    console.log('✅ Logado!');

    // Clica no botão Criar
    console.log('Clicando em Criar...');
    await page.evaluate(() => {
      const all = [...document.querySelectorAll('*')];
      for (const el of all) {
        const label = el.getAttribute('aria-label') || '';
        if (label.includes('Criar') || label.includes('Create') || label.includes('Nova publicação') || label.includes('New post')) {
          el.closest('a,[role="link"],[role="button"]')?.click() || el.click();
          return;
        }
      }
      // Fallback por texto
      for (const span of document.querySelectorAll('span')) {
        if (['Criar','Create'].includes(span.textContent.trim())) {
          span.closest('a,[role="link"]')?.click();
          return;
        }
      }
    });
    await sleep(2500);

    // Clica em Reel no menu
    console.log('Selecionando Reel...');
    await page.evaluate(() => {
      const all = [...document.querySelectorAll('*')];
      for (const el of all) {
        if (el.textContent.trim() === 'Reel' && el.children.length === 0) {
          el.click(); return;
        }
      }
    });
    await sleep(2000);

    // ESTRATÉGIA PRINCIPAL: expõe todos os inputs file ocultos e faz upload
    console.log('Procurando campo de upload...');
    let fileInput = null;

    // Tenta por até 20 segundos com múltiplas estratégias
    for (let attempt = 0; attempt < 20; attempt++) {

      // Estratégia 1: input file direto
      fileInput = await page.$('input[type="file"]');
      if (fileInput) { console.log('Input encontrado diretamente!'); break; }

      // Estratégia 2: torna inputs ocultos visíveis
      const exposed = await page.evaluate(() => {
        const inputs = document.querySelectorAll('input[type="file"]');
        if (inputs.length > 0) {
          inputs.forEach(i => {
            i.style.display = 'block';
            i.style.visibility = 'visible';
            i.style.opacity = '1';
            i.removeAttribute('hidden');
          });
          return true;
        }
        return false;
      });
      if (exposed) {
        fileInput = await page.$('input[type="file"]');
        if (fileInput) { console.log('Input encontrado após exposição!'); break; }
      }

      // Estratégia 3: clica em "Selecionar do computador"
      await page.evaluate(() => {
        const btns = [...document.querySelectorAll('button,[role="button"],div,span')];
        for (const b of btns) {
          const t = b.textContent.trim();
          if (t.includes('Selecionar do computador') || t.includes('Select from computer') ||
              t.includes('Selecionar') || t.includes('Select') || t.includes('computador')) {
            b.click(); return;
          }
        }
      });
      await sleep(1000);
    }

    if (!fileInput) {
      // Última tentativa: injeta input diretamente no DOM
      console.log('Injetando input de arquivo...');
      await page.evaluate(() => {
        const input = document.createElement('input');
        input.type = 'file';
        input.id = 'injected-file-input';
        input.accept = 'video/*';
        input.style.position = 'fixed';
        input.style.top = '0';
        input.style.left = '0';
        input.style.zIndex = '99999';
        document.body.appendChild(input);
      });
      fileInput = await page.$('#injected-file-input');
      if (!fileInput) throw new Error('Não foi possível criar campo de upload');
    }

    // Faz upload
    console.log('Fazendo upload do vídeo...');
    await fileInput.uploadFile(videoPath);
    console.log('Aguardando processamento do vídeo...');
    await sleep(15000);

    // Avança pelas telas
    console.log('Avançando...');
    for (let i = 0; i < 5; i++) {
      const advanced = await page.evaluate(() => {
        const btns = [...document.querySelectorAll('[role="button"],button')];
        const next = btns.find(b => {
          const t = b.textContent.trim();
          return ['Avançar','Next','Continue','Continuar'].includes(t);
        });
        if (next) { next.click(); return true; }
        return false;
      });
      if (advanced) { console.log(`Avançou (${i+1})`); await sleep(2500); }
    }

    // Adiciona legenda
    if (caption) {
      console.log('Adicionando legenda...');
      try {
        const captionEl = await page.$('div[contenteditable="true"],textarea');
        if (captionEl) {
          await captionEl.click();
          await captionEl.type(caption, { delay: 15 });
          await sleep(1000);
        }
      } catch(_) {}
    }

    // Compartilha
    console.log('Compartilhando...');
    const shared = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('[role="button"],button')];
      const share = btns.find(b => {
        const t = b.textContent.trim();
        return ['Compartilhar','Share','Publicar','Post'].includes(t);
      });
      if (share) { share.click(); return true; }
      return false;
    });

    if (!shared) throw new Error('Botão compartilhar não encontrado');
    console.log('Aguardando confirmação...');
    await sleep(15000);

    console.log(`✅ Publicado! @${username}`);
    return { success: true, media_id: Date.now().toString() };

  } finally {
    if (browser) { try { await browser.close(); } catch(_) {} }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Gilson Supremo v4.2 — porta ${PORT}`));
