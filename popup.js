const $ = (id) => document.getElementById(id);
const elComputador = $('computador');
const elNovoNome = $('novoNome');
const btSalvarNova = $('salvarNova');
const elLista = $('lista');
const elPular = $('pular');
const elStatus = $('status');

let ocupado = false;

const enviar = (acao, dados = {}) => chrome.runtime.sendMessage({ acao, ...dados });
const plural = (n, s, p) => `${n} ${n === 1 ? s : p}`;
const formatarData = (ms) => new Date(ms).toLocaleString('pt-BR', {
  day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
});

function status(texto, tipo = '') {
  elStatus.textContent = texto;
  elStatus.className = tipo;
}

function el(tag, props = {}, ...filhos) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...filhos);
  return e;
}

// Botão que pede um segundo clique para confirmar ações destrutivas.
function botaoComConfirmacao(texto, textoConfirmar, classe, acao) {
  const b = el('button', { textContent: texto, className: classe });
  let armado = false;
  let timer;
  b.addEventListener('click', () => {
    if (!armado) {
      armado = true;
      b.textContent = textoConfirmar;
      b.classList.add('confirmar');
      timer = setTimeout(() => {
        armado = false;
        b.textContent = texto;
        b.classList.remove('confirmar');
      }, 4000);
      return;
    }
    clearTimeout(timer);
    acao();
  });
  return b;
}

function editarNome(elNome, sessao) {
  const input = el('input', { type: 'text', value: sessao.nome, maxLength: 40 });
  elNome.replaceChildren(input);
  input.focus();
  input.select();
  let feito = false;
  const concluir = async (salvar) => {
    if (feito) return;
    feito = true;
    const novo = input.value.trim();
    if (salvar && novo && novo !== sessao.nome) {
      const r = await enviar('renomear', { id: sessao.id, nome: novo });
      if (!r?.ok) status(r?.erro || 'Erro ao renomear.', 'erro');
    }
    atualizar();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') concluir(true);
    if (e.key === 'Escape') concluir(false);
  });
  input.addEventListener('blur', () => concluir(true));
}

function desenhar({ sessoes, usado, limite }) {
  elLista.replaceChildren();
  if (!sessoes.length) {
    elLista.append(el('div', { className: 'vazio suave',
      textContent: 'Nenhuma sessão salva. Dê um nome acima e clique em “Salvar abas”.' }));
  }

  for (const s of sessoes) {
    const elNome = el('span', { className: 'nome', textContent: s.nome, title: 'Clique para renomear' });
    elNome.addEventListener('click', () => { if (!elNome.querySelector('input')) editarNome(elNome, s); });

    const detalhe = el('div', { className: 'suave',
      textContent: `${plural(s.abas, 'aba', 'abas')} · ${plural(s.grupos, 'grupo', 'grupos')} · ` +
        `${plural(s.janelas, 'janela', 'janelas')}` });
    const origem = el('div', { className: 'suave',
      textContent: `${s.dispositivo} · ${formatarData(s.quando)}` });

    const btRestaurar = el('button', { textContent: 'Restaurar', className: 'principal' });
    btRestaurar.addEventListener('click', () => executar(
      'Restaurando… (pode levar alguns segundos)',
      () => enviar('restaurar', { id: s.id, pularAbertas: elPular.checked }),
      (r) => {
        let msg = r.abertas ? `"${s.nome}": ${plural(r.abertas, 'aba aberta', 'abas abertas')}.` : 'Nada novo para abrir.';
        if (r.puladas) msg += ` ${plural(r.puladas, 'já estava aberta', 'já estavam abertas')}.`;
        if (r.falhas) msg += ` ${plural(r.falhas, 'não pôde ser aberta', 'não puderam ser abertas')}.`;
        return msg;
      }));

    const btAtualizar = botaoComConfirmacao('Atualizar', 'Substituir?', '', () => executar(
      'Salvando…',
      () => enviar('salvar', { id: s.id }),
      (r) => `"${r.nome}" atualizada com as abas atuais (${plural(r.abas, 'aba', 'abas')}).`));
    btAtualizar.title = 'Substitui esta sessão pelas abas abertas agora';

    const btExcluir = botaoComConfirmacao('Excluir', 'Confirmar', 'perigo', () => executar(
      'Excluindo…',
      () => enviar('excluir', { id: s.id }),
      () => `"${s.nome}" excluída.`));

    elLista.append(el('div', { className: 'sessao' },
      el('div', { className: 'topo' }, elNome),
      detalhe, origem,
      el('div', { className: 'acoes' }, btRestaurar, btAtualizar, btExcluir)));
  }

  const pct = Math.min(100, Math.round((usado / limite) * 100));
  $('usoTexto').textContent = `Espaço sincronizado usado: ${pct}% (${(usado / 1024).toFixed(1)} de ${Math.round(limite / 1024)} KB)`;
  $('usoBarra').style.width = pct + '%';
}

async function executar(textoAguarde, chamada, mensagemOk) {
  if (ocupado) return;
  ocupado = true;
  document.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  status(textoAguarde);
  try {
    const r = await chamada();
    if (r?.ok) status(mensagemOk(r), 'ok');
    else status(r?.erro || 'Algo deu errado.', 'erro');
  } finally {
    ocupado = false;
    document.querySelectorAll('button').forEach((b) => { b.disabled = false; });
    await atualizar();
  }
}

async function atualizar() {
  const r = await enviar('listar');
  if (r?.ok) desenhar(r);
  else status(r?.erro || 'Não foi possível carregar as sessões.', 'erro');
}

btSalvarNova.addEventListener('click', () => {
  const nome = elNovoNome.value.trim();
  if (!nome) { status('Dê um nome para a nova sessão.', 'erro'); elNovoNome.focus(); return; }
  executar('Salvando…', () => enviar('salvar', { nome }), (r) => {
    elNovoNome.value = '';
    return `"${r.nome}" salva: ${plural(r.abas, 'aba', 'abas')}, ${plural(r.grupos, 'grupo', 'grupos')}.`;
  });
});
elNovoNome.addEventListener('keydown', (e) => { if (e.key === 'Enter') btSalvarNova.click(); });

elComputador.addEventListener('input', () => {
  chrome.storage.local.set({ nomeDispositivo: elComputador.value.trim() });
});

// Atualiza a lista se outro computador salvar enquanto o popup está aberto.
chrome.storage.onChanged.addListener((mudancas, area) => {
  if (area === 'sync' && mudancas.indice && !ocupado) atualizar();
});

(async () => {
  const { nomeDispositivo } = await chrome.storage.local.get('nomeDispositivo');
  elComputador.value = nomeDispositivo || '';
  (nomeDispositivo ? elNovoNome : elComputador).focus();
  await atualizar();
})();
