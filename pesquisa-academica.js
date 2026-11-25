const { isIP } = require('node:net');

const BASE_URL = 'https://api.openalex.org/works';
const MAX_PDF_BYTES = 12 * 1024 * 1024;
const MAX_FULLTEXT_CHARS = 120000;

let PDFParse;
function obterParserPdf() {
  if (!PDFParse) {
    try {
      ({ PDFParse } = require('pdf-parse'));
    } catch {
      throw new Error('O leitor de PDF não está instalado. Execute npm install antes de pesquisar textos completos.');
    }
  }
  return PDFParse;
}

function normalizarDoi(valor) {
  return String(valor || '').replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:/i, '');
}

function urlHttpsPublica(valor) {
  try {
    const url = new URL(valor);
    if (url.protocol !== 'https:' || url.username || url.password) return false;

    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host.endsWith('.local') ||
      host.endsWith('.internal') ||
      host.endsWith('.lan')
    ) return false;

    const tipoIp = isIP(host);
    // Endereços IPv6 literais são recusados para evitar falhas de classificação
    // de faixas locais, link-local, mapeadas e reservadas.
    if (tipoIp === 6) return false;

    if (tipoIp === 4) {
      const [a, b, c, d] = host.split('.').map(Number);
      if (
        a === 0 || a === 10 || a === 127 || a >= 224 ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && (b === 0 || b === 168)) ||
        (a === 192 && b === 88 && c === 99) ||
        (a === 198 && (b === 18 || b === 19)) ||
        (a === 198 && b === 51 && c === 100) ||
        (a === 203 && b === 0 && c === 113) ||
        (a === 255 && b === 255 && c === 255 && d === 255)
      ) return false;
    }

    return true;
  } catch {
    return false;
  }
}

async function lerCorpoLimitado(resposta, limite) {
  if (!resposta.body) throw new Error('Resposta sem corpo para leitura.');
  const leitor = resposta.body.getReader();
  const partes = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await leitor.read();
      if (done) break;
      total += value.byteLength;
      if (total > limite) {
        await leitor.cancel();
        throw new Error('PDF excede o limite de tamanho permitido.');
      }
      partes.push(Buffer.from(value));
    }
  } finally {
    leitor.releaseLock();
  }
  return Buffer.concat(partes, total);
}

async function fetchPdfComRedirecionamentosSeguros(urlInicial) {
  let urlAtual = urlInicial;
  const maxRedirecionamentos = 4;
  for (let tentativa = 0; tentativa <= maxRedirecionamentos; tentativa += 1) {
    if (!urlHttpsPublica(urlAtual)) {
      throw new Error('Endereço de PDF ou redirecionamento não permitido.');
    }
    const resposta = await fetch(urlAtual, {
      headers: { Accept: 'application/pdf,application/octet-stream;q=0.9' },
      signal: AbortSignal.timeout(25000),
      redirect: 'manual'
    });
    if ([301, 302, 303, 307, 308].includes(resposta.status)) {
      const destino = resposta.headers.get('location');
      if (!destino) throw new Error('Redirecionamento sem endereço de destino.');
      if (tentativa === maxRedirecionamentos) throw new Error('Limite de redirecionamentos excedido.');
      urlAtual = new URL(destino, urlAtual).toString();
      continue;
    }
    return { resposta, urlFinal: urlAtual };
  }
  throw new Error('Não foi possível acessar o PDF com segurança.');
}

async function obterTextoCompleto(fonte) {
  const url = fonte.pdfUrl;
  if (!urlHttpsPublica(url)) {
    return { ...fonte, textoCompleto: null, statusTextoCompleto: 'PDF aberto não localizado ou endereço não permitido' };
  }

  try {
    const { resposta, urlFinal } = await fetchPdfComRedirecionamentosSeguros(url);
    if (!resposta.ok) {
      return { ...fonte, textoCompleto: null, statusTextoCompleto: 'PDF indisponível (HTTP ' + resposta.status + ')' };
    }
    const tipo = String(resposta.headers.get('content-type') || '').toLowerCase();
    const tamanho = Number(resposta.headers.get('content-length') || 0);
    if (tamanho > MAX_PDF_BYTES ||
        (tipo && !tipo.includes('pdf') && !tipo.includes('octet-stream') && !tipo.includes('application/binary'))) {
      return { ...fonte, textoCompleto: null, statusTextoCompleto: 'Formato ou tamanho do arquivo não permitido' };
    }
    const buffer = await lerCorpoLimitado(resposta, MAX_PDF_BYTES);
    if (buffer.length < 5 || buffer.subarray(0, 5).toString() !== '%PDF-') {
      return { ...fonte, textoCompleto: null, statusTextoCompleto: 'O endereço não retornou um PDF válido' };
    }

    const Parser = obterParserPdf();
    const parser = new Parser({ data: buffer });
    let resultado;
    try {
      resultado = await parser.getText();
    } finally {
      await parser.destroy();
    }
    const texto = String(resultado.text || '')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, MAX_FULLTEXT_CHARS);
    const urlFinalPdf = urlFinal;
    if (texto.length < 1000) {
      return { ...fonte, textoCompleto: null, statusTextoCompleto: 'PDF sem texto extraível suficiente (possível documento digitalizado)' };
    }
    return {
      ...fonte,
      textoCompleto: texto,
      pdfUrlVerificado: urlFinalPdf,
      statusTextoCompleto: 'Texto extraído de PDF em acesso aberto',
      paginasTextoCompleto: Number(resultado.total) || null
    };
  } catch (error) {
    return {
      ...fonte,
      textoCompleto: null,
      statusTextoCompleto: 'Não foi possível extrair o PDF: ' + String(error.message || 'erro').slice(0, 140)
    };
  }
}

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

const TIPOS_PUBLICACAO_ACADEMICA = new Set([
  'article',
  'review',
  'proceedings-article'
]);

function tipoPublicacaoAcademicaAceito(tipo) {
  return TIPOS_PUBLICACAO_ACADEMICA.has(String(tipo || '').toLowerCase());
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

const cacheOpenAlex = new Map();
const CACHE_OPENALEX_TTL_MS = 10 * 60 * 1000;

const aguardar = ms => new Promise(resolve => setTimeout(resolve, ms));

async function consultarOpenAlex(consulta, quantidade) {
  const chaveCache = consulta.trim().toLowerCase() + '::' + quantidade;
  const cache = cacheOpenAlex.get(chaveCache);
  if (cache && Date.now() - cache.timestamp < CACHE_OPENALEX_TTL_MS) {
    return cache.resultados;
  }

  const params = new URLSearchParams({
    search: consulta,
    'per-page': String(quantidade),
    sort: 'relevance_score:desc'
  });
  const url = BASE_URL + '?' + params.toString();
  let ultimoErro;

  // Evita disparar consultas simultâneas contra a OpenAlex. Em caso de
  // limite temporário (HTTP 429), respeita Retry-After com teto seguro.
  for (let tentativa = 0; tentativa < 3; tentativa += 1) {
    try {
      const resposta = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Assistente-TCC-ABNT/1.2 (academic research assistant)'
        },
        signal: AbortSignal.timeout(25000)
      });

      if (resposta.status === 429 || resposta.status >= 500) {
        const retryHeader = Number(resposta.headers.get('retry-after'));
        const espera = Number.isFinite(retryHeader) && retryHeader > 0
          ? Math.min(retryHeader * 1000, 8000)
          : [1500, 3500, 7000][tentativa];
        ultimoErro = new Error('OpenAlex retornou HTTP ' + resposta.status);
        if (tentativa < 2) {
          await aguardar(espera);
          continue;
        }
        break;
      }

      if (!resposta.ok) {
        throw new Error('OpenAlex retornou HTTP ' + resposta.status + ' para a consulta: ' + consulta);
      }

      const dados = await resposta.json();
      const resultados = Array.isArray(dados.results) ? dados.results : [];
      cacheOpenAlex.set(chaveCache, { timestamp: Date.now(), resultados });
      return resultados;
    } catch (error) {
      ultimoErro = error;
      if (tentativa < 2 && (error.name === 'TimeoutError' || error.name === 'AbortError' || error.cause)) {
        await aguardar([1000, 2500, 5000][tentativa]);
        continue;
      }
      break;
    }
  }

  throw new Error((ultimoErro && ultimoErro.message || 'Falha de conexão') +
    ' após tentativas automáticas na OpenAlex. Aguarde alguns minutos e tente novamente.');
}

function mapearTrabalho(trabalho, termosTema, termosObjetivo = []) {
  const autores = (trabalho.authorships || [])
    .map(item => item.author && item.author.display_name)
    .filter(Boolean);
  const resumo = extrairResumo(trabalho.abstract_inverted_index);
  const titulo = trabalho.title || 'Título não informado';
  const relevanciaTema = pontuarRelevancia(termosTema, titulo, resumo || '');
  const relevanciaObjetivo = termosObjetivo.length
    ? pontuarRelevancia(termosObjetivo, titulo, resumo || '')
    : null;
  const relevancia = relevanciaObjetivo === null
    ? relevanciaTema
    : Math.round(relevanciaTema * 0.7 + relevanciaObjetivo * 0.3);
  const doi = trabalho.doi || null;
  const melhorLocalAberto = trabalho.best_oa_location || null;
  const localPrincipal = trabalho.primary_location || null;
  const linkDoi = doi ? 'https://doi.org/' + normalizarDoi(doi) : null;
  const linkPagina = (melhorLocalAberto && melhorLocalAberto.landing_page_url) ||
    (localPrincipal && localPrincipal.landing_page_url) || null;
  const link = urlHttpsPublica(linkDoi) ? linkDoi :
    (urlHttpsPublica(linkPagina) ? linkPagina : null);
  const pdfUrlCandidato = melhorLocalAberto && melhorLocalAberto.pdf_url ||
    (trabalho.locations || []).find(local => local && local.is_oa && local.pdf_url)?.pdf_url || null;
  const pdfUrl = urlHttpsPublica(pdfUrlCandidato) ? pdfUrlCandidato : null;
  const revista = (localPrincipal && localPrincipal.source && localPrincipal.source.display_name) ||
    (melhorLocalAberto && melhorLocalAberto.source && melhorLocalAberto.source.display_name) || null;

  return {
    fonteDados: 'OpenAlex',
    openAlexId: trabalho.id || null,
    versaoAcessoAberto: melhorLocalAberto && melhorLocalAberto.version || null,
    urlPaginaArtigo: urlHttpsPublica(melhorLocalAberto && melhorLocalAberto.landing_page_url)
      ? melhorLocalAberto.landing_page_url
      : link,
    pdfUrl,
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
    pontuacaoTema: relevanciaTema,
    pontuacaoObjetivo: relevanciaObjetivo,
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

const cacheCrossref = new Map();
const CACHE_CROSSREF_TTL_MS = 24 * 60 * 60 * 1000;

async function consultarCrossrefComRetry(doiLimpo) {
  const cache = cacheCrossref.get(doiLimpo);
  if (cache && Date.now() - cache.timestamp < CACHE_CROSSREF_TTL_MS) return { registro: cache.registro };

  let ultimoErro;
  for (let tentativa = 0; tentativa < 3; tentativa += 1) {
    try {
      const resposta = await fetch('https://api.crossref.org/works/' + encodeURIComponent(doiLimpo), {
        headers: { Accept: 'application/json', 'User-Agent': 'Assistente-TCC-ABNT/1.2 (academic metadata verification)' },
        signal: AbortSignal.timeout(15000)
      });
      if (resposta.status === 429 || resposta.status >= 500) {
        const retryHeader = Number(resposta.headers.get('retry-after'));
        const espera = Number.isFinite(retryHeader) && retryHeader > 0
          ? Math.min(retryHeader * 1000, 10000)
          : [1500, 3500, 7000][tentativa];
        ultimoErro = new Error('Crossref retornou HTTP ' + resposta.status);
        if (tentativa < 2) {
          await aguardar(espera);
          continue;
        }
        break;
      }
      if (!resposta.ok) return { erro: 'Crossref retornou HTTP ' + resposta.status };
      const dados = await resposta.json();
      const registro = dados && dados.message;
      if (!registro) return { erro: 'Resposta do Crossref sem metadados' };
      cacheCrossref.set(doiLimpo, { timestamp: Date.now(), registro });
      return { registro };
    } catch (error) {
      ultimoErro = error;
      if (tentativa < 2 && (error.name === 'TimeoutError' || error.name === 'AbortError' || error.cause)) {
        await aguardar([1000, 2500, 5000][tentativa]);
        continue;
      }
      break;
    }
  }
  return { erro: (ultimoErro && ultimoErro.message) || 'Falha de conexão com Crossref' };
}

async function verificarNoCrossref(fonte) {
  if (!fonte.doi) return { ...fonte, verificacaoCrossref: 'Não verificado: DOI ausente' };
  try {
    const consulta = await consultarCrossrefComRetry(normalizarDoi(fonte.doi));
    if (!consulta.registro) return { ...fonte, verificacaoCrossref: 'Não verificado: ' + consulta.erro };
    const registro = consulta.registro;
    const tituloCrossref = Array.isArray(registro.title) ? registro.title[0] : '';
    if (!tituloCrossref || !titulosCorrespondem(fonte.titulo, tituloCrossref)) {
      return { ...fonte, verificacaoCrossref: 'Divergência de título no Crossref' };
    }
    const normalizarSobrenome = valor => normalizar(valor).join(' ');
    const autoresCrossref = (registro.author || []).map(a => normalizarSobrenome(a.family || '')).filter(Boolean);
    const sobrenomesOpenAlex = (fonte.autores || []).map(nome => {
      const partes = normalizar(nome);
      return partes.length ? partes[partes.length - 1] : '';
    }).filter(Boolean);
    const autoresCorrespondem = sobrenomesOpenAlex.length > 0 &&
      autoresCrossref.length > 0 &&
      sobrenomesOpenAlex.length === autoresCrossref.length &&
      sobrenomesOpenAlex.every((nome, indice) => nome === autoresCrossref[indice]);
    if (!autoresCorrespondem) return { ...fonte, verificacaoCrossref: 'Divergência de autoria no Crossref' };
    const datas = [registro.published, registro['published-print'], registro['published-online'], registro.issued]
      .filter(Boolean).map(d => d['date-parts'] && d['date-parts'][0] && Number(d['date-parts'][0][0])).filter(Boolean);
    if (!datas.length || !fonte.ano || !datas.some(ano => Math.abs(ano - Number(fonte.ano)) <= 1)) {
      return { ...fonte, verificacaoCrossref: 'Ano ausente ou divergente no Crossref' };
    }
    return { ...fonte, verificacaoCrossref: 'Confirmado no Crossref', crossrefUrl: registro.URL || null };
  } catch (error) {
    return { ...fonte, verificacaoCrossref: 'Não verificado: ' + (error.message || 'falha na consulta') };
  }
}


function limparResumoCrossref(valor) {
  if (!valor) return null;
  const texto = String(valor)
    .replace(/<\/?(?:jats:[\w-]+|\w+)[^>]*>/gi, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
  return texto.length >= 80 ? texto : null;
}

function mapearRegistroCrossref(registro, termosTema, termosObjetivo = []) {
  const titulo = Array.isArray(registro.title) ? String(registro.title[0] || '').trim() : '';
  const resumo = limparResumoCrossref(registro.abstract);
  const autores = (registro.author || [])
    .map(a => [a.given, a.family].filter(Boolean).join(' ').trim())
    .filter(Boolean);
  const data = [registro.published, registro['published-print'], registro['published-online'], registro.issued]
    .find(d => d && d['date-parts'] && d['date-parts'][0] && Number(d['date-parts'][0][0]));
  const ano = data ? Number(data['date-parts'][0][0]) : null;
  const doi = registro.DOI || null;
  const link = doi ? 'https://doi.org/' + normalizarDoi(doi) : (registro.URL || null);
  const linkPdf = (registro.link || []).find(item =>
    /pdf/i.test(String(item['content-type'] || '')) && urlHttpsPublica(item.URL)
  );
  const tipoCrossref = String(registro.type || '').toLowerCase();
  const tipo = tipoCrossref === 'journal-article' ? 'article' :
    tipoCrossref === 'proceedings-article' ? 'proceedings-article' :
    tipoCrossref === 'journal' ? 'review' : tipoCrossref;
  const relevanciaTema = pontuarRelevancia(termosTema, titulo, resumo || '');
  const relevanciaObjetivo = termosObjetivo.length
    ? pontuarRelevancia(termosObjetivo, titulo, resumo || '')
    : null;
  const relevancia = relevanciaObjetivo === null
    ? relevanciaTema
    : Math.round(relevanciaTema * 0.7 + relevanciaObjetivo * 0.3);
  const paginas = String(registro.page || '').match(/^(\d+)\s*[-–]\s*(\d+)$/);
  return {
    fonteDados: 'Crossref',
    openAlexId: null,
    versaoAcessoAberto: null,
    urlPaginaArtigo: urlHttpsPublica(link) ? link : null,
    pdfUrl: linkPdf ? linkPdf.URL : null,
    titulo,
    autores,
    ano,
    revista: Array.isArray(registro['container-title']) ? registro['container-title'][0] || null : null,
    volume: registro.volume || null,
    numero: registro.issue || null,
    paginaInicial: paginas ? paginas[1] : (registro.page || null),
    paginaFinal: paginas ? paginas[2] : null,
    doi,
    link: urlHttpsPublica(link) ? link : null,
    resumo,
    citacoes: Number.isFinite(Number(registro['is-referenced-by-count'])) ? Number(registro['is-referenced-by-count']) : null,
    tipo,
    idioma: registro.language || null,
    acessoAberto: null,
    pontuacaoRelevancia: relevancia,
    pontuacaoTema: relevanciaTema,
    pontuacaoObjetivo: relevanciaObjetivo,
    relevancia: relevancia >= 55 ? 'Mais relevante' : relevancia >= 25 ? 'Precisa de análise' : 'Relevância incerta',
    verificacaoCrossref: 'Metadados obtidos diretamente do Crossref',
    crossrefUrl: registro.URL || link
  };
}

async function pesquisarCrossref(consultas, quantidade, termosTema, termosObjetivo) {
  const encontrados = [];
  const consultasUnicas = [...new Set(consultas)].slice(0, 2);
  for (const consulta of consultasUnicas) {
    const params = new URLSearchParams({
      'query.bibliographic': consulta,
      rows: String(Math.min(quantidade * 4, 40)),
      select: 'DOI,title,author,published,published-print,published-online,issued,type,container-title,volume,issue,page,URL,link,abstract,is-referenced-by-count,language'
    });
    const resposta = await fetch('https://api.crossref.org/works?' + params.toString(), {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Assistente-TCC-ABNT/1.2 (academic research fallback)'
      },
      signal: AbortSignal.timeout(25000)
    });
    if (!resposta.ok) {
      throw new Error('Crossref retornou HTTP ' + resposta.status + ' na busca alternativa.');
    }
    const dados = await resposta.json();
    const itens = dados && dados.message && Array.isArray(dados.message.items) ? dados.message.items : [];
    for (const item of itens) {
      const mapeado = mapearRegistroCrossref(item, termosTema, termosObjetivo);
      if (
        tipoPublicacaoAcademicaAceito(mapeado.tipo) &&
        mapeado.pontuacaoRelevancia >= 15 &&
        mapeado.titulo && mapeado.autores.length && mapeado.ano &&
        mapeado.doi && mapeado.link && mapeado.resumo
      ) encontrados.push(mapeado);
    }
    await aguardar(300);
  }
  const unicos = new Map();
  for (const item of encontrados) {
    const chave = normalizarDoi(item.doi) || item.titulo.toLowerCase();
    if (!unicos.has(chave) || item.pontuacaoRelevancia > unicos.get(chave).pontuacaoRelevancia) {
      unicos.set(chave, item);
    }
  }
  return [...unicos.values()]
    .sort((a, b) => b.pontuacaoRelevancia - a.pontuacaoRelevancia || (b.ano || 0) - (a.ano || 0))
    .slice(0, Math.min(quantidade * 2, 20));
}

async function pesquisarTrabalhos(tema, limite = 8, objetivo = '') {
  if (!tema || !String(tema).trim()) {
    throw new Error('Informe um tema para pesquisar.');
  }

  const quantidade = Math.min(Math.max(Number(limite) || 8, 1), 10);
  const termos = extrairTermos(tema);
  if (!termos.length) throw new Error('Não foi possível identificar palavras-chave no tema informado.');
  const termosObjetivo = extrairTermos(objetivo).slice(0, 5);

  const consultas = montarConsultas(tema, objetivo);
  const trabalhosBrutos = [];
  const erros = [];

  // Consultas sequenciais para respeitar os limites do serviço e reduzir 429.
  for (let i = 0; i < consultas.length; i += 1) {
    try {
      const encontrados = await consultarOpenAlex(consultas[i], quantidade);
      trabalhosBrutos.push(...encontrados);
      if (i < consultas.length - 1) await aguardar(500);
    } catch (error) {
      erros.push(error && error.message || 'Falha na consulta');
      // Se a OpenAlex estiver limitando, não insistir nas demais consultas.
      if (/HTTP 429|limite de requisições/i.test(String(error.message || ''))) break;
    }
  }

  let candidatos;
  let basePesquisa = 'OpenAlex';
  if (!trabalhosBrutos.length) {
    console.warn('⚠️ OpenAlex indisponível; ativando busca alternativa no Crossref:', erros[0] || 'sem resultados');
    basePesquisa = 'Crossref';
    try {
      candidatos = await pesquisarCrossref(consultas, quantidade, termos, termosObjetivo);
    } catch (erroCrossref) {
      throw new Error(
        'OpenAlex indisponível (' + (erros[0] || 'sem resultados') +
        ') e a busca alternativa Crossref também falhou (' + (erroCrossref.message || 'erro não identificado') + ').'
      );
    }
  } else {
    const unicos = new Map();
    for (const trabalho of trabalhosBrutos) {
      const mapeado = mapearTrabalho(trabalho, termos, termosObjetivo);
      const chave = mapeado.doi || mapeado.openAlexId || mapeado.titulo.toLowerCase();
      if (!unicos.has(chave) || mapeado.pontuacaoRelevancia > unicos.get(chave).pontuacaoRelevancia) {
        unicos.set(chave, mapeado);
      }
    }
    candidatos = [...unicos.values()]
    .filter(item =>
      tipoPublicacaoAcademicaAceito(item.tipo) &&
      item.pontuacaoRelevancia >= 15 &&
      item.titulo && item.autores.length && item.ano && item.doi && item.link && item.resumo
    )
    .sort((a, b) => b.pontuacaoRelevancia - a.pontuacaoRelevancia)
    .slice(0, Math.min(quantidade * 2, 20));
  }

  const candidatosVerificados = [];
  // A busca alternativa já retorna metadados diretamente do Crossref;
  // quando a origem é OpenAlex, a conferência independente continua obrigatória.
  for (let i = 0; i < candidatos.length; i += 1) {
    candidatosVerificados.push(candidatos[i].fonteDados === 'Crossref'
      ? candidatos[i]
      : await verificarNoCrossref(candidatos[i]));
    if (i < candidatos.length - 1) await aguardar(200);
  }
  const selecionados = candidatosVerificados
    .filter(item =>
      item.verificacaoCrossref === 'Confirmado no Crossref' ||
      item.verificacaoCrossref === 'Metadados obtidos diretamente do Crossref'
    )
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

  const fontesComTexto = await Promise.all(selecionados.map(obterTextoCompleto));
  const fontesFinal = fontesComTexto.map(fonte => ({
    ...fonte,
    link: fonte.urlPaginaArtigo || fonte.link
  }));

  if (!selecionados.length) {
    throw new Error('Foram encontrados registros, mas nenhum pôde ser confirmado no Crossref com DOI, título, autoria e ano compatíveis. Nenhuma referência será inventada. Tente ampliar ou ajustar o tema, ou revise as fontes manualmente.');
  }

  return fontesFinal;
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

  const dados = [autoresFormatados, fonte.titulo, fonte.revista, fonte.anoReferencia || (fonte.ano ? String(fonte.ano) : null)];
  if (fonte.volume) dados.push('v. ' + fonte.volume);
  if (fonte.numero) dados.push('n. ' + fonte.numero);
  if (fonte.paginaInicial) dados.push('p. ' + fonte.paginaInicial + (fonte.paginaFinal ? '-' + fonte.paginaFinal : ''));
  if (fonte.doi) dados.push('DOI: ' + normalizarDoi(fonte.doi));
  const linkArtigo = fonte.urlPaginaArtigo || fonte.link;
  if (linkArtigo) {
    dados.push('Disponível em: ' + linkArtigo);
    const partesData = new Intl.DateTimeFormat('pt-BR', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      timeZone: 'America/Sao_Paulo'
    }).formatToParts(new Date());
    const dataAcesso = Object.fromEntries(partesData.map(parte => [parte.type, parte.value]));
    dados.push('Acesso em: ' + dataAcesso.day + ' ' + dataAcesso.month + ' ' + dataAcesso.year);
  }
  if (fonte.pdfUrlVerificado || fonte.pdfUrl) {
    dados.push('PDF em acesso aberto: ' + (fonte.pdfUrlVerificado || fonte.pdfUrl));
  }
  return dados.filter(Boolean).join('. ') + '.';
}

module.exports = {
  pesquisarTrabalhos,
  formatarReferenciaABNT,
  extrairResumo,
  pontuarRelevancia,
  mapearTrabalho,
  verificarNoCrossref,
  urlHttpsPublica,
  tipoPublicacaoAcademicaAceito,
  fetchPdfComRedirecionamentosSeguros
};
