// Sessão Sincronizada — service worker
// Guarda várias sessões (janelas, abas e grupos) em chrome.storage.sync,
// que acompanha a conta Google, e restaura em qualquer computador logado.

const INDICE = 'indice';            // lista com os dados de cada sessão
const LEGADO_META = 'sessao_meta';  // formato da versão 1.0 (uma sessão só)
const LEGADO_PARTE = 'parte_';
// chrome.storage.sync aceita no máximo 8 KB por item; com o texto convertido
// para ASCII, 3500 caracteres ficam abaixo disso mesmo no pior caso.
const TAMANHO_PARTE = 3500;

const chaveParte = (id, i) => `p_${id}_${i}`;
const chavesPartes = (id, n) => Array.from({ length: n }, (_, i) => chaveParte(id, i));
const novoId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// Converte caracteres não-ASCII em \uXXXX para o tamanho em bytes ser previsível.
function paraAscii(texto) {
  return texto.replace(/[\u007f-￿]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

function podeAbrir(url) {
  if (!url) return false;
  if (/^chrome:\/\/(newtab|new-tab-page)/i.test(url)) return false;
  return /^(https?|ftp|file|chrome):/i.test(url);
}

async function lerIndice() {
  const d = await chrome.storage.sync.get(INDICE);
  return Array.isArray(d[INDICE]) ? d[INDICE] : [];
}

// Converte a sessão única da versão 1.0 para o formato com várias sessões.
async function migrarLegado() {
  const d = await chrome.storage.sync.get(LEGADO_META);
  const antiga = d[LEGADO_META];
  if (!antiga) return;
  const chavesAntigas = Array.from({ length: antiga.partes }, (_, i) => LEGADO_PARTE + i);
  const partes = await chrome.storage.sync.get(chavesAntigas);
  const indice = await lerIndice();
  const id = novoId();
  const dados = {};
  chavesAntigas.forEach((k, i) => { dados[chaveParte(id, i)] = partes[k] ?? ''; });
  indice.push({
    id, nome: 'Sessão salva', partes: antiga.partes, quando: antiga.quando,
    dispositivo: antiga.dispositivo, janelas: antiga.janelas, abas: antiga.abas, grupos: antiga.grupos,
  });
  dados[INDICE] = indice;
  await chrome.storage.sync.remove([LEGADO_META, ...chavesAntigas]);
  await chrome.storage.sync.set(dados);
}

// ---------- CAPTURAR ABAS ATUAIS ----------
async function capturar() {
  const janelas = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  const w = [];
  let abas = 0;
  let grupos = 0;

  for (const janela of janelas) {
    if (janela.incognito) continue;
    const gruposJanela = await chrome.tabGroups.query({ windowId: janela.id });
    const indiceGrupo = new Map();
    const g = []; // [titulo, cor, recolhido]
    const t = []; // [url, fixada, indiceGrupo]

    for (const aba of janela.tabs) {
      const url = aba.pendingUrl || aba.url;
      if (!podeAbrir(url)) continue;
      let gi = -1;
      if (aba.groupId !== -1) {
        if (!indiceGrupo.has(aba.groupId)) {
          const gr = gruposJanela.find((x) => x.id === aba.groupId);
          indiceGrupo.set(aba.groupId, g.length);
          g.push([gr?.title || '', gr?.color || 'grey', gr?.collapsed ? 1 : 0]);
        }
        gi = indiceGrupo.get(aba.groupId);
      }
      t.push([url, aba.pinned ? 1 : 0, gi]);
    }

    if (t.length) {
      w.push({ t, g });
      abas += t.length;
      grupos += g.length;
    }
  }
  if (!abas) throw new Error('Não há abas para salvar.');
  return { sessao: { v: 1, w }, janelas: w.length, abas, grupos };
}

// ---------- SALVAR (nova ou substituindo uma existente) ----------
async function salvar({ id, nome }) {
  nome = (nome || '').trim();
  const indice = await lerIndice();
  const existente = id ? indice.find((s) => s.id === id) : null;
  if (id && !existente) throw new Error('Essa sessão não existe mais (talvez tenha sido excluída em outro computador).');
  if (!existente && !nome) throw new Error('Dê um nome para a nova sessão.');
  if (!existente && indice.some((s) => s.nome.toLowerCase() === nome.toLowerCase())) {
    throw new Error(`Já existe uma sessão chamada "${nome}". Use o botão "Atualizar" dela para substituir.`);
  }

  const { sessao, janelas, abas, grupos } = await capturar();
  const texto = paraAscii(JSON.stringify(sessao));
  const partes = [];
  for (let i = 0; i < texto.length; i += TAMANHO_PARTE) partes.push(texto.slice(i, i + TAMANHO_PARTE));

  const { nomeDispositivo } = await chrome.storage.local.get('nomeDispositivo');
  const meta = {
    id: existente?.id || novoId(),
    nome: existente?.nome || nome,
    partes: partes.length,
    quando: Date.now(),
    dispositivo: (nomeDispositivo || '').trim() || 'Sem nome',
    janelas, abas, grupos,
  };

  const novoIndice = existente
    ? indice.map((s) => (s.id === meta.id ? meta : s))
    : [...indice, meta];
  const dados = { [INDICE]: novoIndice };
  partes.forEach((p, i) => { dados[chaveParte(meta.id, i)] = p; });

  try {
    await chrome.storage.sync.set(dados);
  } catch (e) {
    if (/quota/i.test(String(e?.message))) {
      throw new Error(
        `Sem espaço no armazenamento sincronizado (${abas} abas nesta sessão). ` +
        `Exclua uma sessão antiga ou feche algumas abas e tente de novo.`);
    }
    throw e;
  }

  // Remove partes que sobraram de uma versão anterior maior desta sessão.
  if (existente && existente.partes > partes.length) {
    await chrome.storage.sync.remove(chavesPartes(meta.id, existente.partes).slice(partes.length));
  }
  return meta;
}

// ---------- EXCLUIR ----------
async function excluir({ id }) {
  const indice = await lerIndice();
  const alvo = indice.find((s) => s.id === id);
  if (!alvo) return;
  await chrome.storage.sync.set({ [INDICE]: indice.filter((s) => s.id !== id) });
  await chrome.storage.sync.remove(chavesPartes(id, alvo.partes));
}

// ---------- RENOMEAR ----------
async function renomear({ id, nome }) {
  nome = (nome || '').trim();
  if (!nome) throw new Error('O nome não pode ficar vazio.');
  const indice = await lerIndice();
  if (indice.some((s) => s.id !== id && s.nome.toLowerCase() === nome.toLowerCase())) {
    throw new Error(`Já existe uma sessão chamada "${nome}".`);
  }
  await chrome.storage.sync.set({ [INDICE]: indice.map((s) => (s.id === id ? { ...s, nome } : s)) });
}

// ---------- RESTAURAR ----------
async function carregar(id) {
  const meta = (await lerIndice()).find((s) => s.id === id);
  if (!meta) throw new Error('Essa sessão não existe mais.');
  const chaves = chavesPartes(id, meta.partes);
  const d = await chrome.storage.sync.get(chaves);
  try {
    return JSON.parse(chaves.map((k) => d[k] ?? '').join(''));
  } catch {
    throw new Error('A sessão ainda está chegando de outro computador. Aguarde alguns segundos e tente de novo.');
  }
}

async function restaurar({ id, pularAbertas }) {
  const sessao = await carregar(id);

  const jaAbertas = new Set();
  if (pularAbertas) {
    for (const aba of await chrome.tabs.query({})) jaAbertas.add(aba.pendingUrl || aba.url);
  }

  let abertas = 0;
  let puladas = 0;
  let falhas = 0;
  let ultimaJanela = null;

  for (const w of sessao.w) {
    const lista = w.t.filter(([url]) => {
      if (pularAbertas && jaAbertas.has(url)) { puladas++; return false; }
      return true;
    });
    if (!lista.length) continue;

    let janela = null;
    const criadas = []; // [tabId, fixada, indiceGrupo]

    for (const [url, fixada, gi] of lista) {
      try {
        if (!janela) {
          janela = await chrome.windows.create({ url, focused: false });
          criadas.push([janela.tabs[0].id, fixada, gi]);
        } else {
          const aba = await chrome.tabs.create({ windowId: janela.id, url, active: false });
          criadas.push([aba.id, fixada, gi]);
        }
        abertas++;
      } catch (e) {
        falhas++;
        console.warn('Não foi possível abrir', url, e);
      }
    }
    if (!janela) continue;
    ultimaJanela = janela.id;

    for (const [tabId, fixada] of criadas) {
      if (fixada) await chrome.tabs.update(tabId, { pinned: true }).catch(() => {});
    }

    const porGrupo = new Map();
    for (const [tabId, fixada, gi] of criadas) {
      if (gi < 0 || fixada) continue;
      if (!porGrupo.has(gi)) porGrupo.set(gi, []);
      porGrupo.get(gi).push(tabId);
    }
    for (const [gi, ids] of porGrupo) {
      try {
        const groupId = await chrome.tabs.group({ tabIds: ids, createProperties: { windowId: janela.id } });
        const [title, color, recolhido] = w.g[gi] || ['', 'grey', 0];
        await chrome.tabGroups.update(groupId, { title, color, collapsed: !!recolhido });
      } catch (e) {
        console.warn('Não foi possível recriar o grupo', e);
      }
    }
  }

  return { abertas, puladas, falhas, ultimaJanela };
}

// ---------- LISTAR ----------
async function listar() {
  const sessoes = (await lerIndice()).sort((a, b) => b.quando - a.quando);
  const usado = await chrome.storage.sync.getBytesInUse(null);
  return { sessoes, usado, limite: chrome.storage.sync.QUOTA_BYTES };
}

// ---------- MENSAGENS DO POPUP ----------
const acoes = { listar, salvar, excluir, renomear, restaurar };

chrome.runtime.onMessage.addListener((msg, _sender, responder) => {
  (async () => {
    try {
      const fn = acoes[msg?.acao];
      if (!fn) throw new Error('Ação desconhecida.');
      await migrarLegado();
      const r = await fn(msg);
      responder({ ok: true, ...(r || {}) });
      if (msg.acao === 'restaurar' && r?.ultimaJanela) {
        chrome.windows.update(r.ultimaJanela, { focused: true }).catch(() => {});
      }
    } catch (e) {
      responder({ ok: false, erro: e?.message || String(e) });
    }
  })();
  return true; // resposta assíncrona
});

chrome.runtime.onInstalled.addListener(() => { migrarLegado().catch(console.warn); });
