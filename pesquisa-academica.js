const BASE_URL = 'https://api.openalex.org/works';

const STOPWORDS = new Set([
  'para', 'como', 'sobre', 'entre', 'mais', 'menos', 'uma', 'umas', 'uns',
  'dos', 'das', 'que', 'com', 'sem', 'por', 'the', 'and', 'for', 'from',
  'with', 'de', 'da', 'do', 'em', 'no', 'na', 'nos', 'nas', 'e', 'ou',
  'um', 'ao', 'aos', 'as', 'os', 'seu', 'sua', 'seus', 'suas'
]);

function normalizar(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) || [];
}

function extrairTermos(tema) {
  return [...new Set(normalizar(tema).filter(p => p.length > 2 && !STOPWORDS.has(p)))];
}

function extrairResumo(invertedIndex) {
  if (!invertedIndex || typeof invertedIndex !== 'object') return null;
  const palavras = [];
  for (const [palavra, posicoes] of Object.entries(invertedIndex)) {
    if (!Array.isArray(posicoes)) continue;
    for (const posicao of posicoes) {
      if (Number.isInteger(posicao) && posicao >= 0) palavras[posicao] = palavra;
    }
  }
  const resumo = palavras.join(' ').trim();
  return resumo || null;
}

function pontuarRelevancia(termos, titulo, resumo) {
  const tituloSet = new Set(normalizar(titulo));
  const resumoSet = new Set(normalizar(resumo));
  const noTitulo = termos.filter(t => tituloSet.has(t)).length;
  const noResumo = termos.filter(t => resumoSet.has(t)).length;
  const tituloScore = termos.length ? noTitulo / termos.length : 0;
  const resumoScore = termos.length ? noResumo / termos.length : 0;
  return Math.round(tituloScore * 65 + resumoScore * 35);
}

function montarConsultas(tema, objetivo = '') {
  const termos = extrairTermos(tema);
  const termosObjetivo = extrairTermos(objetivo).slice(0, 5);
  const consultas = [String(tema).trim()];
  if (termosObjetivo.length) consultas.push(String(tema).trim() + ' ' + termosObjetivo.join(' '));
  if (termos.length >= 3) {
    consultas.push(termos.slice(0, Math.ceil(termos.length / 2)).join(' '));
    consultas.push(termos.slice(-Math.ceil(termos.length / 2)).join(' '));
  }
  return [...new Set(consultas)].slice(0, 3);
}

async function consultarOpenAlex(consulta, quantidade) {
  const params = new URLSearchParams({
    search: consulta,
    'per-page': String(quantidade),
    sort: 'relevance_score:desc'
  });
  const resposta = await fetch(BASE_URL + '?' + params.toString(), {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Assistente-TCC-ABNT/1.1 (academic research assistant)'
    },
    signal: AbortSignal.timeout(20000)
  });
  if (!resposta.ok) {
    throw new Error('OpenAlex retornou HTTP ' + resposta.status + ' para a consulta: ' + consulta);
  }
  const dados = await resposta.json();
  return Array.isArray(dados.results) ? dados.results : [];
}

function mapearTrabalho(trabalho, termos) {
  const autores = (trabalho.authorships || [])
    .map(item => item.author && item.author.display_name)
    .filter(Boolean);
  const resumo = extrairResumo(trabalho.abstract_inverted_index);
  const titulo = trabalho.title || 'Título não informado';
  const relevancia = pontuarRelevancia(termos, titulo, resumo || '');
  const doi = trabalho.doi || null;
  const link = doi || (trabalho.primary_location && trabalho.primary_location.landing_page_url) || null;
  const revista = trabalho.primary_location && trabalho.primary_location.source
    ? trabalho.primary_location.source.display_name
    : null;

  return {
    openAlexId: trabalho.id || null,
    titulo,
    autores,
    ano: trabalho.publication_year || null,
    revista,
    volume: trabalho.biblio && trabalho.biblio.volume || null,
    numero: trabalho.biblio && trabalho.biblio.issue || null,
    paginaInicial: trabalho.biblio && trabalho.biblio.first_page || null,
    paginaFinal: trabalho.biblio && trabalho.biblio.last_page || null,
    doi,
    link,
    resumo,
    citacoes: trabalho.cited_by_count == null ? null : trabalho.cited_by_count,
    tipo: trabalho.type || null,
    idioma: trabalho.language || null,
    acessoAberto: trabalho.open_access ? trabalho.open_access.is_oa : null,
    pontuacaoRelevancia: relevancia,
    relevancia: relevancia >= 55 ? 'Mais relevante' : relevancia >= 25 ? 'Precisa de análise' : 'Relevância incerta'
  };
}

function titulosCorrespondem(tituloA, tituloB) {
  const a = new Set(extrairTermos(tituloA));
  const b = new Set(extrairTermos(tituloB));
  if (!a.size || !b.size) return false;
  const intersecao = [...a].filter(t => b.has(t)).length;
  return intersecao / Math.max(a.size, b.size) >= 0.8;
}

async function verificarNoCrossref(fonte) {
  if (!fonte.doi) return { ...fonte, verificacaoCrossref: 'Não verificado: DOI ausente' };
  try {
    const doiLimpo = String(fonte.doi).replace(/^https?:\\/\\/(dx\\.)?doi\\.org\\//i, '');
    const resposta = await fetch('https://api.crossref.org/works/' + encodeURIComponent(doiLimpo), {
      headers: { Accept: 'application/json', 'User-Agent': 'Assistente-TCC-ABNT/1.1 (academic metadata verification)' },
      signal: AbortSignal.timeout(15000)
    });
    if (!resposta.ok) return { ...fonte, verificacaoCrossref: 'Não confirmado no Crossref' };
    const dados = await resposta.json();
    const registro = dados && dados.message;
    const tituloCrossref = registro && Array.isArray(registro.title) ? registro.title[0] : '';
    if (!tituloCrossref || !titulosCorrespondem(fonte.titulo, tituloCrossref)) {
      return { ...fonte, verificacaoCrossref: 'Divergência de título no Crossref' };
    }
    const autoresCrossref = (registro.author || []).map(a => a.family).filter(Boolean);
    const sobrenomesOpenAlex = (fonte.autores || []).map(nome => String(nome).trim().split(/\\s+/).pop().toLowerCase());
    const autoresCorrespondem = sobrenomesOpenAlex.length && autoresCrossref.length &&
      sobrenomesOpenAlex.some(nome => autoresCrossref.some(sobrenome => sobrenome.toLowerCase() === nome));
    if (!autoresCorrespondem) {
      return { ...fonte, verificacaoCrossref: 'Divergência de autoria no Crossref' };
    }
    const datas = [registro.published, registro['published-print'], registro['published-online'], registro.issued]
      .filter(Boolean).map(d => d['date-parts'] && d['date-parts'][0] && Number(d['date-parts'][0][0])).filter(Boolean);
    if (fonte.ano && datas.length && !datas.some(ano => Math.abs(ano - Number(fonte.ano)) <= 1)) {
      return { ...fonte, verificacaoCrossref: 'Divergência de ano no Crossref' };
    }
    return { ...fonte, verificacaoCrossref: 'Confirmado no Crossref', crossrefUrl: registro.URL || null };
  } catch (error) {
    return { ...fonte, verificacaoCrossref: 'Não verificado: ' + (error.message || 'falha na consulta') };
  }
}

async function pesquisarTrabalhos(tema, limite = 8, objetivo = '') {
  if (!tema || !String(tema).trim()) {
    throw new Error('Informe um tema para pesquisar.');
  }

  const quantidade = Math.min(Math.max(Number(limite) || 8, 1), 10);
  const termos = extrairTermos(tema);
  if (!termos.length) throw new Error('Não foi possível identificar palavras-chave no tema informado.');

  const consultas = montarConsultas(tema, objetivo);
  const termosDeRelevancia = [...new Set([...termos, ...extrairTermos(objetivo).slice(0, 5)])];
  const resultados = await Promise.allSettled(
    consultas.map(consulta => consultarOpenAlex(consulta, quantidade))
  );

  const trabalhosBrutos = [];
  const erros = [];
  for (let i = 0; i < resultados.length; i += 1) {
    const item = resultados[i];
    if (item.status === 'fulfilled') trabalhosBrutos.push(...item.value);
    else erros.push(item.reason && item.reason.message || 'Falha na consulta');
  }

  if (!trabalhosBrutos.length) {
    throw new Error('A pesquisa acadêmica não retornou resultados. ' + (erros[0] || 'Tente delimitar o tema com outras palavras-chave.'));
  }

  const unicos = new Map();
  for (const trabalho of trabalhosBrutos) {
    const mapeado = mapearTrabalho(trabalho, termosDeRelevancia);
    const chave = mapeado.doi || mapeado.openAlexId || mapeado.titulo.toLowerCase();
    if (!unicos.has(chave) || mapeado.pontuacaoRelevancia > unicos.get(chave).pontuacaoRelevancia) {
      unicos.set(chave, mapeado);
    }
  }

  const candidatos = [...unicos.values()]
    .filter(item => item.pontuacaoRelevancia >= 15 && item.titulo && item.autores.length && item.ano && item.link)
    .sort((a, b) => b.pontuacaoRelevancia - a.pontuacaoRelevancia)
    .slice(0, Math.min(quantidade * 2, 20));

  const candidatosVerificados = await Promise.all(candidatos.map(verificarNoCrossref));
  const selecionados = candidatosVerificados
    .filter(item => item.verificacaoCrossref === 'Confirmado no Crossref')
    .sort((a, b) => {
      if (b.pontuacaoRelevancia !== a.pontuacaoRelevancia) {
        return b.pontuacaoRelevancia - a.pontuacaoRelevancia;
      }
      return (b.ano || 0) - (a.ano || 0);
    })
    .slice(0, quantidade)
    .map((item, index) => ({
      ...item,
      idFonte: 'F' + (index + 1),
      temResumo: Boolean(item.resumo && item.resumo.trim())
    }));

  if (!selecionados.length) {
    throw new Error('Foram encontrados registros, mas nenhum pôde ser confirmado no Crossref com DOI, título, autoria e ano compatíveis. Nenhuma referência será inventada. Tente ampliar ou ajustar o tema, ou revise as fontes manualmente.');
  }

  return selecionados;
}

function formatarReferenciaABNT(fonte) {
  const autores = Array.isArray(fonte.autores) ? fonte.autores : [];
  const autoresFormatados = autores.length
    ? autores.map(nome => {
        const partes = String(nome).trim().split(/\s+/);
        const sobrenome = partes.pop() || nome;
        return (sobrenome + ', ' + partes.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ')).toUpperCase();
      }).join('; ')
    : '[AUTORIA NÃO IDENTIFICADA]';

  const dados = [autoresFormatados, fonte.titulo, fonte.revista, fonte.ano ? String(fonte.ano) : null];
  if (fonte.volume) dados.push('v. ' + fonte.volume);
  if (fonte.numero) dados.push('n. ' + fonte.numero);
  if (fonte.paginaInicial) dados.push('p. ' + fonte.paginaInicial + (fonte.paginaFinal ? '-' + fonte.paginaFinal : ''));
  if (fonte.doi) dados.push('DOI: ' + fonte.doi);
  else if (fonte.link) dados.push('Disponível em: ' + fonte.link);
  return dados.filter(Boolean).join('. ') + '.';
}

module.exports = {
  pesquisarTrabalhos,
  formatarReferenciaABNT,
  extrairResumo,
  pontuarRelevancia
};
