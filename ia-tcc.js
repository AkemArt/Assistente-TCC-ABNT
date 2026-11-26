require('dotenv').config();

const { GoogleGenAI } = require('@google/genai');
const { pesquisarTrabalhos, formatarReferenciaABNT } = require('./pesquisa-academica');

const aguardarGemini = ms => new Promise(resolve => setTimeout(resolve, ms));

function erroCotaContaGemini(error) {
  const status = String(error?.status || error?.code || '').toUpperCase();
  const mensagem = String(error?.message || '');
  return status === 'RESOURCE_EXHAUSTED' ||
    /You exceeded your current quota|check your plan and billing|quota exceeded|insufficient quota|billing details/i.test(mensagem);
}

function erroGeminiTransitorio(error) {
  if (erroCotaContaGemini(error)) return false;
  const status = String(error?.status || error?.code || '').toUpperCase();
  const mensagem = String(error?.message || '');
  return ['429', '500', '502', '503', '504', 'RESOURCE_EXHAUSTED', 'UNAVAILABLE', 'INTERNAL'].includes(status) ||
    /HTTP\s*(429|500|502|503|504)|RESOURCE_EXHAUSTED|UNAVAILABLE|temporarily unavailable|overloaded/i.test(mensagem);
}

// Prioriza os modelos estáveis mais recentes e mantém dois fallbacks atuais.
// Evita depender de modelos 2.5 com acesso limitado para novos projetos. Defina GEMINI_MODEL no Render
// (aceita vários, separados por vírgula) para escolher o modelo que sua chave realmente enxerga.
const MODELOS_GEMINI_PADRAO = ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.5-flash-lite'];
const MODELOS_GEMINI_SUBSTITUIDOS = new Map([
  // Gemini 3.6 Flash foi encerrado na Gemini Developer API em 19/11/2026.
  ['gemini-3.6-flash', 'gemini-3.7-flash']
]);
let modeloGeminiAtivo = null;

function listarModelosGemini() {
  const configurados = String(process.env.GEMINI_MODEL || '')
    .split(',')
    .map(m => m.trim())
    .filter(Boolean)
    .map(m => MODELOS_GEMINI_SUBSTITUIDOS.get(m) || m);
  const baseOriginal = configurados.length ? configurados : MODELOS_GEMINI_PADRAO;
  const base = [...new Set(baseOriginal)];
  const modeloAtivoNormalizado = MODELOS_GEMINI_SUBSTITUIDOS.get(modeloGeminiAtivo) || modeloGeminiAtivo;
  return modeloAtivoNormalizado && base.includes(modeloAtivoNormalizado)
    ? [modeloAtivoNormalizado, ...base.filter(m => m !== modeloAtivoNormalizado)]
    : base;
}

function erroPermiteFallbackModelo(error) {
  const status = String(error?.status || error?.code || '').toUpperCase();
  const mensagem = String(error?.message || '');
  const modeloNaoDisponivel = status === '404' || status === 'NOT_FOUND' ||
    /\b404\b|NOT_FOUND|no longer available|is not found|not supported for generateContent/i.test(mensagem);
  // RESOURCE_EXHAUSTED/429 pode ser limite específico do modelo. Após esgotar
  // as tentativas com espera, experimenta o próximo modelo configurado.
  // Cota esgotada no projeto/conta não é específica do modelo: trocar de modelo
  // só repete a mesma falha e mantém o Discord preso em "pensando".
  if (erroCotaContaGemini(error)) return false;
  const cotaDoModelo = status === '429' || /HTTP\s*429|rate limit/i.test(mensagem);
  return modeloNaoDisponivel || cotaDoModelo;
}

async function gerarConteudoGeminiComModelo(ai, request, etapa) {
  const esperas = [1500, 4000];
  for (let tentativa = 0; tentativa <= esperas.length; tentativa += 1) {
    try {
      const resposta = await ai.models.generateContent(request);
      if (!resposta || typeof resposta.text !== 'string' || !resposta.text.trim()) {
        throw new Error('Gemini retornou uma resposta vazia na etapa ' + etapa + '.');
      }
      return resposta;
    } catch (error) {
      if (!erroGeminiTransitorio(error) || tentativa === esperas.length) {
        const mensagem = String(error?.message || 'Erro sem detalhes');
        throw new Error('Falha na API Gemini durante ' + etapa + ': ' + mensagem);
      }
      console.warn('⚠️ Gemini temporariamente indisponível em ' + etapa +
        '. Nova tentativa ' + (tentativa + 1) + '/' + esperas.length +
        ' após ' + esperas[tentativa] + ' ms.');
      await aguardarGemini(esperas[tentativa]);
    }
  }
  throw new Error('Não foi possível concluir a etapa ' + etapa + ' com o Gemini.');
}

async function gerarConteudoGeminiComRetry(ai, request, etapa) {
  const { model: _ignorado, ...restante } = request;
  const modelos = listarModelosGemini();
  let ultimoErro;
  for (const modelo of modelos) {
    try {
      const resposta = await gerarConteudoGeminiComModelo(ai, { ...restante, model: modelo }, etapa);
      modeloGeminiAtivo = modelo;
      return resposta;
    } catch (error) {
      ultimoErro = error;
      if (!erroPermiteFallbackModelo(error)) throw error;
      console.warn('⚠️ Modelo Gemini "' + modelo + '" indisponível em ' + etapa + '; tentando o próximo da lista.');
    }
  }
  throw ultimoErro || new Error('Nenhum modelo Gemini disponível na etapa ' + etapa + '.');
}

function ordenarFontesBibliografia(fontes) {
  return [...(fontes || [])].sort((a, b) => {
    const primeiroSobrenome = fonte =>
      normalizarParaComparacao((fonte.autores || [])[0] || '').split(' ').filter(Boolean).pop() || '';
    const sobrenomeA = primeiroSobrenome(a);
    const sobrenomeB = primeiroSobrenome(b);
    const comparacaoSobrenome = sobrenomeA.localeCompare(sobrenomeB, 'pt-BR');
    if (comparacaoSobrenome !== 0) return comparacaoSobrenome;

    const autoresA = normalizarParaComparacao((a.autores || []).join(' '));
    const autoresB = normalizarParaComparacao((b.autores || []).join(' '));
    const comparacaoAutores = autoresA.localeCompare(autoresB, 'pt-BR');
    if (comparacaoAutores !== 0) return comparacaoAutores;

    return String(a.titulo || '').localeCompare(String(b.titulo || ''), 'pt-BR');
  });
}

function chaveAutoriaParaReferencia(fonte) {
  return JSON.stringify((fonte.autores || []).map(nome => normalizarParaComparacao(nome)));
}

function aplicarSufixosAno(fontes) {
  const ordenadas = ordenarFontesBibliografia(fontes);
  const grupos = new Map();
  for (const fonte of ordenadas) {
    const chaveAutores = chaveAutoriaParaReferencia(fonte);
    const chave = chaveAutores + '::' + String(fonte.ano || '');
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(fonte);
  }

  return ordenadas.map(fonte => {
    const chaveAutores = chaveAutoriaParaReferencia(fonte);
    const chave = chaveAutores + '::' + String(fonte.ano || '');
    const grupo = grupos.get(chave) || [];
    const indice = grupo.findIndex(item =>
      (item.openAlexId && fonte.openAlexId && item.openAlexId === fonte.openAlexId) ||
      (item.titulo && fonte.titulo && item.titulo === fonte.titulo)
    );
    const sufixo = grupo.length > 1 && indice >= 0
      ? String.fromCharCode(97 + indice)
      : '';
    return { ...fonte, anoReferencia: String(fonte.ano || 's.d.') + sufixo };
  });
}

function normalizarAutorParaCitacao(nome) {
  const partes = String(nome || '').trim().split(/\s+/).filter(Boolean);
  if (!partes.length) return '';
  const sobrenomeOriginal = partes[partes.length - 1];
  const sobrenome = sobrenomeOriginal === sobrenomeOriginal.toLocaleUpperCase('pt-BR')
    ? sobrenomeOriginal.charAt(0).toLocaleUpperCase('pt-BR') + sobrenomeOriginal.slice(1).toLocaleLowerCase('pt-BR')
    : sobrenomeOriginal.charAt(0).toLocaleUpperCase('pt-BR') + sobrenomeOriginal.slice(1);
  return sobrenome;
}

function formatarCitacao(fonte, todasFontes = []) {
  const autores = Array.isArray(fonte.autores) ? fonte.autores : [];
  if (!autores.length) return '(Autoria não identificada, ' + (fonte.ano || 's.d.') + ')';

  const sobrenomes = autores.map(normalizarAutorParaCitacao).filter(Boolean);
  if (!sobrenomes.length) return '(Autoria não identificada, ' + (fonte.ano || 's.d.') + ')';

  const mesmoAutorEAno = (todasFontes || []).filter(item =>
    String(item.ano || '') === String(fonte.ano || '') &&
    chaveAutoriaParaReferencia(item) === chaveAutoriaParaReferencia(fonte)
  );
  const ordenadas = mesmoAutorEAno.slice().sort((a, b) =>
    String(a.titulo || '').localeCompare(String(b.titulo || ''), 'pt-BR')
  );
  const indice = ordenadas.findIndex(item =>
    (item.openAlexId && fonte.openAlexId && item.openAlexId === fonte.openAlexId) ||
    (item.titulo && fonte.titulo && item.titulo === fonte.titulo)
  );
  const sufixoAno = ordenadas.length > 1 && indice >= 0
    ? String.fromCharCode(97 + indice)
    : '';

  const autor = sobrenomes.length >= 4
    ? sobrenomes[0] + ' et al.'
    : sobrenomes.join('; ');
  return '(' + autor + ', ' + (fonte.ano || 's.d.') + sufixoAno + ')';
}

function substituirMarcadores(texto, fontes) {
  return String(texto || '').replace(/\[F(\d+)\]/g, (marcador, numero) => {
    const idFonte = 'F' + Number(numero);
    const fonte = fontes.find(item => item.idFonte === idFonte);
    return fonte ? formatarCitacao(fonte, fontes) : '[MARCADOR DE FONTE INVÁLIDO]';
  });
}

function limparJson(texto) {
  return String(texto || '')
    .trim()
    .replace(/^\x60{3}(?:json)?\s*/i, '')
    .replace(/\s*\x60{3}$/i, '')
    .trim();
}

function validarVinculoDeEvidencias(dados, fontes) {
  const idsValidos = new Set(fontes.map(f => f.idFonte));
  const marcadoresEncontrados = new Set();
  const secoesTextuais = [
    'introducao', 'problemaPesquisa', 'objetivos',
    'fundamentacaoTeorica', 'metodologia', 'discussao', 'conclusao'
  ];
  const secoesQueExigemCitacao = new Set([
    'introducao', 'fundamentacaoTeorica', 'discussao', 'conclusao'
  ]);

  for (const secao of secoesTextuais) {
    const paragrafos = Array.isArray(dados[secao]) ? dados[secao] : [];
    for (const paragrafo of paragrafos) {
      const texto = String(paragrafo || '');
      const marcadores = texto.match(/\[F\d+\]/g) || [];
      const contemCitacaoAutorData = /\([^)]{1,100}\b(?:19|20)\d{2}[a-z]?\s*\)/i.test(texto);

      if (secoesQueExigemCitacao.has(secao) && marcadores.length === 0) {
        throw new Error('O parágrafo da seção ' + secao + ' não possui marcador de fonte. Toda afirmação acadêmica nessa seção precisa estar vinculada a um estudo recuperado.');
      }

      if (contemCitacaoAutorData) {
        throw new Error(
          'A IA escreveu uma citação autor-data diretamente, em vez de usar somente os marcadores [F#]. ' +
          'A citação foi bloqueada para impedir autores ou anos não vinculados ao catálogo de fontes.'
        );
      }

      for (const marcador of marcadores) {
        const numero = Number(marcador.match(/\d+/)[0]);
        const id = 'F' + numero;
        if (!idsValidos.has(id)) {
          throw new Error('A IA citou uma fonte inexistente (' + marcador + '). O texto foi bloqueado.');
        }
        marcadoresEncontrados.add(id);
      }
    }
  }

  if (marcadoresEncontrados.size === 0) {
    throw new Error('A IA não vinculou nenhuma afirmação acadêmica às fontes recuperadas. A geração foi bloqueada para não produzir fundamentação sem evidências.');
  }

  return marcadoresEncontrados;
}

function normalizarParaComparacao(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function selecionarTrechosRelevantes(texto, tema, objetivo, limite = 12000) {
  const conteudo = String(texto || '');
  if (conteudo.length <= limite) return conteudo;
  const termos = [...new Set(
    (normalizarParaComparacao(String(tema || '') + ' ' + String(objetivo || '')).match(/[\p{L}\p{N}]{4,}/gu) || [])
  )];
  const janela = 1800;
  const passo = 1200;
  const blocos = [];
  for (let inicio = 0; inicio < conteudo.length; inicio += passo) {
    const trecho = conteudo.slice(inicio, inicio + janela);
    const normalizado = normalizarParaComparacao(trecho);
    const pontuacao = termos.reduce((total, termo) => total + (normalizado.includes(termo) ? 1 : 0), 0);
    blocos.push({ inicio, trecho, pontuacao });
  }
  const selecionados = [];
  let tamanho = 0;
  for (const bloco of blocos.sort((a, b) => b.pontuacao - a.pontuacao || a.inicio - b.inicio)) {
    if (selecionados.some(item => Math.abs(item.inicio - bloco.inicio) < janela)) continue;
    if (tamanho + bloco.trecho.length > limite) continue;
    selecionados.push(bloco);
    tamanho += bloco.trecho.length;
    if (tamanho >= limite - janela) break;
  }
  if (!selecionados.length) return conteudo.slice(0, limite);
  return selecionados.sort((a, b) => a.inicio - b.inicio)
    .map(item => '[Trecho do artigo, posição aproximada ' + item.inicio + ']\n' + item.trecho)
    .join('\n\n');
}

function validarEvidenciasTextuais(dados, fontes) {
  if (!Array.isArray(dados.evidencias) || !dados.evidencias.length) {
    throw new Error('A IA não forneceu trechos de evidência rastreáveis. Nenhuma afirmação acadêmica será tratada como comprovada.');
  }

  const paragrafosComCitacao = new Map();
  const secoes = [
    'introducao', 'problemaPesquisa', 'objetivos',
    'fundamentacaoTeorica', 'metodologia', 'discussao', 'conclusao'
  ];
  for (const secao of secoes) {
    for (const paragrafo of (dados[secao] || [])) {
      const marcadores = String(paragrafo).match(/\[F\d+\]/g) || [];
      for (const marcador of marcadores) {
        const fonteId = 'F' + Number(marcador.match(/\d+/)[0]);
        const chave = String(paragrafo) + '::' + fonteId;
        paragrafosComCitacao.set(chave, { paragrafo: String(paragrafo), fonteId });
      }
    }
  }

  const evidenciasValidadas = new Map();
  for (const evidencia of dados.evidencias) {
    if (!evidencia || typeof evidencia.paragrafo !== 'string' ||
        typeof evidencia.fonteId !== 'string' || typeof evidencia.trecho !== 'string') {
      throw new Error('A estrutura de evidências retornada pela IA está incompleta.');
    }
    const chave = evidencia.paragrafo + '::' + evidencia.fonteId;
    if (!paragrafosComCitacao.has(chave)) {
      throw new Error('Foi apresentada evidência sem correspondência exata com um parágrafo e sua citação.');
    }
    const fonte = fontes.find(item => item.idFonte === evidencia.fonteId);
    const textoBase = fonte && (fonte.textoCompleto || fonte.resumo);
    if (!fonte || !textoBase) {
      throw new Error('A fonte ' + evidencia.fonteId + ' não possui texto completo nem resumo verificável. Ela não pode sustentar afirmações.');
    }
    const trechoNormalizado = normalizarParaComparacao(evidencia.trecho);
    const textoNormalizado = normalizarParaComparacao(textoBase);
    const quantidadePalavrasTrecho = (String(evidencia.trecho).trim().match(/[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*/gu) || []).length;
    if (quantidadePalavrasTrecho > 25) {
      throw new Error('O trecho literal da fonte excede o limite de 25 palavras. Solicite um excerto mais curto e mantenha o link do artigo para conferência.');
    }
    if (quantidadePalavrasTrecho < 3 || trechoNormalizado.length < 15) {
      throw new Error('O trecho literal é curto demais para identificar a evidência. Use uma passagem contínua de 3 a 25 palavras.');
    }
    if (!textoNormalizado.includes(trechoNormalizado)) {
      throw new Error('O trecho atribuído à fonte ' + evidencia.fonteId + ' não foi localizado no texto recuperado. A afirmação foi bloqueada.');
    }
    if (evidenciasValidadas.has(chave)) {
      throw new Error('Há evidências duplicadas para a mesma afirmação e fonte.');
    }
    const indiceTrecho = textoBase.toLowerCase().indexOf(evidencia.trecho.toLowerCase());
    const inicioContexto = indiceTrecho >= 0 ? Math.max(0, indiceTrecho - 3500) : 0;
    const fimContexto = indiceTrecho >= 0
      ? Math.min(textoBase.length, indiceTrecho + evidencia.trecho.length + 4500)
      : Math.min(textoBase.length, 18000);
    evidenciasValidadas.set(chave, {
      paragrafo: evidencia.paragrafo,
      fonteId: evidencia.fonteId,
      trecho: evidencia.trecho,
      textoFonte: textoBase.slice(inicioContexto, fimContexto),
      statusTextoCompleto: fonte.statusTextoCompleto || 'Somente resumo disponível',
      titulo: fonte.titulo
    });
  }

  for (const [chave] of paragrafosComCitacao) {
    if (!evidenciasValidadas.has(chave)) {
      throw new Error('Uma afirmação citada não possui trecho literal de apoio correspondente. A geração foi bloqueada.');
    }
  }
  return [...evidenciasValidadas.values()];
}

async function verificarSustentacaoSemantica(ai, evidencias) {
  const lote = evidencias.map((item, indice) => ({
    indice,
    afirmacao: item.paragrafo.replace(/\[F\d+\]/g, '').trim(),
    tituloDaFonte: item.titulo,
    trechoLiteralDaFonte: item.trecho,
    textoDisponivelParaConferencia: item.textoFonte,
    situacaoDoTexto: item.statusTextoCompleto
  }));

  const prompt = [
    'Você é um avaliador metodológico rigoroso. Verifique se o trecho literal e o texto acadêmico disponibilizado realmente sustentam a afirmação. O material pode ser artigo integral de PDF aberto ou apenas resumo; considere a situação informada.',
    'Não considere mera coincidência de palavras como sustentação. Avalie sujeito, população/contexto, variável, direção do resultado, modalidade e limites do que foi observado.',
    'Classifique como "sustentada" somente quando o trecho e o conteúdo efetivamente disponibilizado (texto integral ou resumo, conforme indicado) apoiarem diretamente a afirmação sem extrapolação.',
    'Use "parcial" se apoiar apenas parte da afirmação, ou "nao_sustentada" se não apoiar, contradizer ou não permitir concluir.',
    'Não complete lacunas com conhecimento externo. Na dúvida, use "parcial". Não confunda confirmação de DOI/metadados com prova de sustentação científica.',
    'Retorne somente JSON válido no formato: {"avaliacoes":[{"indice":0,"status":"sustentada|parcial|nao_sustentada","justificativa":"explicação curta baseada no texto"}]}.',
    'EVIDÊNCIAS PARA AUDITORIA:',
    JSON.stringify(lote)
  ].join('\n');

  const response = await gerarConteudoGeminiComRetry(ai, {
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      temperature: 0
    }
  }, 'auditoria semântica das evidências');

  let resultado;
  try {
    resultado = JSON.parse(limparJson(response && response.text));
  } catch {
    throw new Error('Não foi possível validar semanticamente a relação entre as afirmações e os estudos. A geração foi interrompida por segurança.');
  }
  if (!resultado || !Array.isArray(resultado.avaliacoes) ||
      resultado.avaliacoes.length !== evidencias.length) {
    throw new Error('A auditoria de evidências retornou uma avaliação incompleta. Nenhum documento será liberado.');
  }

  const indicesRecebidos = new Set();
  const porIndice = new Map();
  for (const item of resultado.avaliacoes) {
    if (!item || !Number.isInteger(item.indice) ||
        item.indice < 0 || item.indice >= evidencias.length ||
        indicesRecebidos.has(item.indice)) {
      throw new Error('A auditoria de evidências retornou índices inválidos ou repetidos. Nenhum documento será liberado.');
    }
    if (!['sustentada', 'parcial', 'nao_sustentada'].includes(item.status) ||
        typeof item.justificativa !== 'string' ||
        item.justificativa.trim().length < 12) {
      throw new Error('A auditoria de evidências retornou uma classificação ou justificativa inválida. Nenhum documento será liberado.');
    }
    indicesRecebidos.add(item.indice);
    porIndice.set(item.indice, item);
  }

  for (let i = 0; i < evidencias.length; i += 1) {
    const avaliacao = porIndice.get(i);
    if (!avaliacao || avaliacao.status !== 'sustentada') {
      const status = avaliacao && avaliacao.status || 'sem avaliação';
      throw new Error('Afirmação não comprovada pela fonte ' + evidencias[i].fonteId +
        ' (resultado da auditoria: ' + status + '). Revise a afirmação ou encontre um estudo que a sustente. Nenhum texto será apresentado como fundamentado sem essa confirmação.');
    }
  }
  return evidencias.map((_, indice) => porIndice.get(indice));
}

function validarSecoes(dados) {
  const obrigatorias = [
    'introducao',
    'problemaPesquisa',
    'objetivos',
    'fundamentacaoTeorica',
    'metodologia',
    'discussao',
    'conclusao',
    'limitacoes',
    'verificacoes',
    'evidencias'
  ];
  if (!dados || typeof dados !== 'object' || Array.isArray(dados)) return false;
  const chaves = Object.keys(dados);
  if (chaves.length !== obrigatorias.length || !obrigatorias.every(chave => chaves.includes(chave))) return false;
  return obrigatorias.every(chave => {
    if (!Array.isArray(dados[chave]) || !dados[chave].length) return false;
    if (chave === 'evidencias') {
      return dados[chave].every(item =>
        item && typeof item.paragrafo === 'string' &&
        typeof item.fonteId === 'string' && typeof item.trecho === 'string'
      );
    }
    return dados[chave].every(paragrafo =>
      typeof paragrafo === 'string' && paragrafo.trim().length >= 20
    );
  });
}

function contarPalavrasSecoes(secoes) {
  const principais = [
    'introducao',
    'problemaPesquisa',
    'objetivos',
    'fundamentacaoTeorica',
    'metodologia',
    'discussao',
    'conclusao'
  ];
  return principais.reduce((total, chave) => {
    const texto = (secoes[chave] || []).join(' ');
    const palavras = texto.trim().match(/[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*/gu) || [];
    return total + palavras.length;
  }, 0);
}

function contarPalavrasTexto(texto) {
  return (String(texto || '').trim().match(/[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*/gu) || []).length;
}

function extrairArrayJson(texto) {
  const limpo = limparJson(texto);
  const inicio = limpo.indexOf('[');
  const fim = limpo.lastIndexOf(']');
  if (inicio < 0 || fim <= inicio) throw new Error('Resposta sem lista JSON.');
  return limpo.slice(inicio, fim + 1);
}

// Passo 1: a IA transforma o tema em consultas curtas e específicas (PT e EN), que são
// o que as bases científicas entendem. Em caso de falha, a busca segue com o tema original.
async function gerarConsultasBusca(ai, tema, objetivo) {
  const prompt = [
    'Você é bibliotecário acadêmico especialista em estratégias de busca em bases científicas (OpenAlex, Crossref, SciELO).',
    'TEMA DO TCC: ' + tema,
    'OBJETIVO: ' + (objetivo || 'não informado'),
    'Gere 4 consultas de busca, curtas (2 a 5 palavras-chave cada), ESPECÍFICAS para este tema e objetivo, usando a terminologia técnica que os artigos realmente utilizam. Alterne inglês e português, começando pelo inglês (inglês, português, inglês, português).',
    'Sem aspas, operadores booleanos ou pontuação. Nada genérico que serviria para qualquer assunto.',
    'Responda somente JSON: {"consultas":["...","...","...","..."]}'
  ].join('\n');
  try {
    const resposta = await gerarConteudoGeminiComRetry(ai, {
      contents: prompt,
      config: { responseMimeType: 'application/json', temperature: 0.2 }
    }, 'palavras-chave de busca');
    const dados = JSON.parse(limparJson(resposta && resposta.text));
    const consultas = (Array.isArray(dados.consultas) ? dados.consultas : [])
      .map(c => String(c || '').replace(/[^\p{L}\p{N}\s-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80))
      .filter(c => c.length >= 3);
    return [...new Set(consultas)].slice(0, 4);
  } catch (error) {
    console.warn('⚠️ Não foi possível gerar palavras-chave com a IA; usando o tema original:', String(error?.message || error).slice(0, 200));
    return [];
  }
}

// Citações de autores consagrados: só entram as que a IA confirmou por busca na web e que
// passam nesta validação. Mesmo assim ficam em seção própria, marcadas para conferência na obra.
function validarCitacoesConsagradas(lista, urlsGroundingPermitidas = null) {
  const anoAtual = new Date().getFullYear();
  const permitidas = Array.isArray(urlsGroundingPermitidas)
    ? new Map(urlsGroundingPermitidas.map(fonte => {
        if (fonte && typeof fonte === 'object') {
          return [String(fonte.url || '').trim(), String(fonte.titulo || '').trim()];
        }
        return [String(fonte || '').trim(), ''];
      }).filter(([url]) => Boolean(url)))
    : null;
  const vistas = new Set();
  const validas = [];
  for (const item of Array.isArray(lista) ? lista : []) {
    if (!item || typeof item !== 'object') continue;
    const autor = String(item.autor || '').trim();
    const sobrenome = String(item.sobrenome || '').trim();
    const citacao = String(item.citacao || '').replace(/^[“"']+|[”"']+$/g, '').trim();
    const obra = String(item.obra || '').trim();
    const relacao = String(item.relacao || '').trim();
    const tituloFonte = String(item.tituloFonte || '').trim();
    const urlFonte = String(item.urlFonte || '').trim();
    const ano = Number(item.ano);
    const palavras = contarPalavrasTexto(citacao);
    let urlSegura = false;
    try {
      const parsed = new URL(urlFonte);
      urlSegura = parsed.protocol === 'https:' && Boolean(parsed.hostname) &&
        !parsed.username && !parsed.password;
    } catch { /* URL inválida */ }
    if (!autor || !sobrenome || !obra || relacao.length < 15 || !tituloFonte) continue;
    if (!urlSegura || (permitidas && (
      !permitidas.has(urlFonte) ||
      (permitidas.get(urlFonte) && permitidas.get(urlFonte) !== tituloFonte)
    ))) continue;
    if (palavras < 4 || palavras > 40) continue;
    if (!Number.isInteger(ano) || ano < 1500 || ano > anoAtual) continue;
    if (item.confirmadaNaBusca !== true) continue;
    const chave = normalizarParaComparacao(autor + ' ' + citacao);
    if (vistas.has(chave)) continue;
    vistas.add(chave);
    validas.push({
      autor, sobrenome, citacao, obra, ano, relacao, tituloFonte, urlFonte,
      traducaoLivre: item.traducaoLivre === true
    });
  }
  return validas.slice(0, 5);
}

function formatarCitacaoConsagrada(c) {
  const sufixo = c.traducaoLivre ? ', tradução nossa' : '';
  return [
    '“' + c.citacao + '” (' + c.sobrenome.toLocaleUpperCase('pt-BR') + ', ' + c.ano + sufixo + ').',
    'Obra de referência: ' + c.autor + ', ' + c.obra + ' (' + c.ano + '). ' + c.relacao,
    'Fonte de verificação: ' + c.tituloFonte + ' — ' + c.urlFonte
  ];
}

async function gerarCitacoesConsagradas(ai, { tema, objetivo }) {
  const prompt = [
    'Você é pesquisador de citações acadêmicas.',
    'TEMA DO TCC: ' + tema,
    'OBJETIVO: ' + (objetivo || 'não informado'),
    '',
    'Usando a busca na web, localize de 3 a 5 citações curtas de pessoas amplamente reconhecidas (cientistas, economistas, filósofos, escritores, educadores, líderes) que dialoguem diretamente com este tema e com a área do conhecimento dele. Escolha autores da área do tema (ex.: finanças e economia → pensadores da economia; meio ambiente → cientistas e pensadores da ecologia; educação → educadores).',
    'REGRAS:',
    '1. Inclua somente citações cuja autoria e origem (obra, discurso ou entrevista) você CONFIRMOU em fontes encontradas na busca. Descarte "frases famosas" sem origem comprovada: muitas são apócrifas.',
    '2. Máximo de 35 palavras por citação. Se o original não for em português, traduza e marque traducaoLivre como true.',
    '3. "ano" é o ano da obra ou discurso de origem (número inteiro).',
    '4. Não invente. Se não confirmar 3, devolva menos; lista vazia é aceitável.',
    '5. "relacao" é uma frase explicando como a ideia se liga a este tema.',
    'Para CADA citação, associe uma fonte de verificação que esteja entre os resultados da busca. Informe exatamente o título e a URL HTTPS da fonte retornada. Se não houver uma fonte que confirme a frase e a obra, descarte a citação. Responda SOMENTE com um array JSON, sem markdown: [{"autor":"Nome completo","sobrenome":"Sobrenome para a citação ABNT","citacao":"...","traducaoLivre":false,"obra":"título da obra ou discurso","ano":1962,"relacao":"...","tituloFonte":"Título exato do resultado que confirma a frase","urlFonte":"https://...","confirmadaNaBusca":true}]'
  ].join('\n');

  const resposta = await gerarConteudoGeminiComRetry(ai, {
    contents: prompt,
    config: { tools: [{ googleSearch: {} }], temperature: 0.2 }
  }, 'citações de autores consagrados');

  const trechos = resposta?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  if (!trechos.length) {
    console.warn('⚠️ Citações de autores descartadas: a busca na web não retornou fontes para confirmá-las.');
    return { citacoes: [], fontesBusca: [] };
  }
  let lista;
  try {
    lista = JSON.parse(extrairArrayJson(resposta.text));
  } catch {
    console.warn('⚠️ Citações de autores descartadas: resposta fora do formato esperado.');
    return { citacoes: [], fontesBusca: [] };
  }
  const fontesGrounding = trechos.map(t => ({
    titulo: String(t?.web?.title || '').trim(),
    url: String(t?.web?.uri || '').trim()
  })).filter(fonte => {
    if (!fonte.titulo || !fonte.url) return false;
    try {
      const url = new URL(fonte.url);
      return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password;
    } catch { return false; }
  });
  const fontesPermitidas = [...new Map(
    fontesGrounding.map(fonte => [fonte.url, fonte])
  ).values()];
  const citacoes = validarCitacoesConsagradas(lista, fontesPermitidas);
  const fontesBusca = [...new Set(fontesGrounding.map(fonte => fonte.titulo + ' — ' + fonte.url))].slice(0, 8);
  if (lista.length && !citacoes.length) {
    console.warn('⚠️ Citações de autores descartadas: nenhuma associou a frase a uma URL HTTPS efetivamente retornada pela busca.');
  }
  return { citacoes, fontesBusca };
}

async function gerarTextoTCC({ tema, objetivo, fontes, pageCount = 10, citacoesConsagradas = [], fontesBuscaCitacoes = [], onProgress = async () => {} }) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY ou GOOGLE_API_KEY não configurada. A geração acadêmica foi interrompida para não produzir texto genérico sem IA.');
  }
  if (!tema || !String(tema).trim()) throw new Error('Informe o tema do TCC.');
  const paginasPermitidas = new Set([10, 15, 20, 25, 30, 40, 50, 60]);
  if (!paginasPermitidas.has(Number(pageCount))) {
    throw new Error('A quantidade de páginas deve ser uma das opções disponíveis: 10, 15, 20, 25, 30, 40, 50 ou 60.');
  }
  if (!Array.isArray(fontes) || !fontes.length) {
    throw new Error('Nenhuma fonte acadêmica foi localizada. Não será gerada uma redação com referências presumidas.');
  }

  const ai = new GoogleGenAI({ apiKey });
  const fontesComResumo = fontes.filter(f => f.resumo && f.resumo.trim());
  const fontesText = fontes.map(fonte => {
    return [
      '[' + fonte.idFonte + ']',
      'Título: ' + fonte.titulo,
      'Autores: ' + (fonte.autores.join('; ') || 'Autoria não identificada'),
      'Ano: ' + (fonte.ano || 'Não informado'),
      'Periódico/fonte: ' + (fonte.revista || 'Não informado'),
      'Tipo de publicação informado por ' + (fonte.fonteDados || 'base não identificada') + ': ' + (fonte.tipo || 'Não classificado'),
      'DOI/link: ' + (fonte.doi || fonte.link || 'Não informado'),
      'Página do artigo: ' + (fonte.urlPaginaArtigo || fonte.link || 'Não informada'),
      'PDF em acesso aberto: ' + (fonte.pdfUrlVerificado || fonte.pdfUrl || 'Não localizado'),
      'Situação do texto completo: ' + (fonte.statusTextoCompleto || 'Não verificada'),
      'Conferência dos metadados: ' + (fonte.verificacaoCrossref || 'Não verificada'),
      'Limite da conferência: Crossref confirma correspondência de metadados, não qualidade científica, revisão por pares nem sustentação de afirmações.',
      'Trechos relevantes do texto integral: ' + (fonte.textoCompleto ? selecionarTrechosRelevantes(fonte.textoCompleto, tema, objetivo) : 'Texto completo não disponível. Resumo recuperado: ' + (fonte.resumo || 'Resumo indisponível; não utilizar para sustentar afirmações.'))
    ].join('\n');
  }).join('\n\n');

  const prompt = [
    'Você é pesquisador e redator acadêmico experiente, escrevendo em português brasileiro formal.',
    'Produza um rascunho acadêmico ORIGINAL, aprofundado e específico para o tema abaixo. Não use uma estrutura de frases pronta que serviria para qualquer assunto.',
    '',
    'TEMA: ' + tema,
    'OBJETIVO INFORMADO: ' + (objetivo || 'Ainda não informado; não invente objetivo específico.'),
    'EXTENSÃO SOLICITADA: aproximadamente ' + pageCount + ' páginas de conteúdo principal. Produza como meta cerca de ' + (pageCount * 250) + ' palavras nas seções principais. A paginação real varia com a diagramação, elementos pré-textuais e referências; não prometa número exato de páginas.',
    '',
    'FONTES REAIS RECUPERADAS NAS BASES ACADÊMICAS INDICADAS EM CADA REGISTRO (OPENALEX OU CROSSREF):',
    fontesText,
    '',
    'REGRAS INEGOCIÁVEIS DE EVIDÊNCIA:',
    '1. Use exclusivamente as fontes listadas para citações e afirmações atribuídas a estudos.',
    '2. Quando uma afirmação for sustentada por uma fonte, inclua o marcador exato [F1], [F2] etc. no fim da frase. O programa converterá esses marcadores em citações autor-data.',
    '2A. A extensão é requisito: distribua o volume entre as seções principais e aproxime-se da meta de palavras informada. Aprofunde definições, delimitações, relações entre conceitos, comparação crítica e justificativas metodológicas, sem repetir ideias.',
    '2B. Cada parágrafo de introdução, fundamentação teórica, discussão e conclusão deve conter pelo menos um marcador [F#] ligado a uma fonte que sustente suas afirmações. Não deixe afirmações factuais dessas seções sem referência.',
    '3. Nunca escreva nomes de pesquisadores famosos, teorias, estatísticas, resultados ou citações textuais que não estejam comprovados nos dados das fontes fornecidas. Citações de autores consagrados são tratadas em uma seção própria, fora deste JSON; não as inclua nos parágrafos.',
    '4. Não cite uma fonte sem resumo ou texto integral como evidência de conteúdo. Ela pode aparecer somente como referência localizada, sinalizando que o conteúdo precisa ser consultado.',
    '5. Não atribua ao artigo resultados que não estejam descritos no material efetivamente disponibilizado. Quando só houver resumo, limite as afirmações ao resumo e não diga que leu o texto completo.',
    '6. Não invente citações diretas, páginas, DOI, autores, datas ou títulos. Não classifique uma fonte como revisada por pares sem comprovação específica.',
    '7. Faça síntese crítica: aproxime e contraste achados quando o texto integral ou os resumos efetivamente disponibilizados permitirem; não faça uma lista mecânica de artigos.',
    '8. Desenvolva o raciocínio a partir do recorte real do tema. Explique conceitos específicos e relações entre variáveis somente quando houver base nas fontes.',
    '9. Não invente metodologia já executada. Apresente uma proposta metodológica compatível com o objetivo e sinalize o que o estudante precisa decidir.',
    '9A. O estudante informou o objetivo, mas não forneceu um problema de pesquisa separado. Apresente a pergunta de pesquisa como proposta preliminar derivada do tema e do objetivo, identificando-a expressamente como sugestão a ser validada com o orientador.',
    '10. Não use parágrafos genéricos sobre a importância da tecnologia, sociedade ou atualidade se não forem pertinentes ao tema.',
    '11. Se as fontes não forem suficientes para determinada seção, escreva isso explicitamente em limitacoes e verificacoes.',
    '12. Não crie a lista de referências. Ela será montada pelo programa com os metadados recuperados.',
    '',
    'FORMATO DE SAÍDA: responda somente com JSON válido, sem markdown, com exatamente estas chaves:',
    '{',
    ' "introducao": ["parágrafos analíticos suficientes para a extensão solicitada"],',
    ' "problemaPesquisa": ["delimitação e pergunta de pesquisa"],',
    ' "objetivos": ["objetivo geral", "objetivos específicos"],',
    ' "fundamentacaoTeorica": ["parágrafos aprofundados, organizados por conceitos e citações [F#]"],',
    ' "metodologia": ["parágrafos detalhados com proposta metodológica, justificativas e ressalvas"],',
    ' "discussao": ["parágrafos de síntese crítica e comparação das fontes"],',
    ' "conclusao": ["parágrafos coerentes com o objetivo, as fontes e as limitações, sem inventar resultados"],',
    ' "limitacoes": ["limitações concretas das fontes recuperadas"],',
    ' "verificacoes": ["itens que o estudante deve conferir nos textos originais"],',
    ' "evidencias": [{"paragrafo":"copie exatamente um parágrafo citado, incluindo seu marcador [F1]","fonteId":"F1","trecho":"copie literalmente um trecho contínuo de 3 a 25 palavras do texto integral disponibilizado ou, se indisponível, do resumo da fonte, sem alterar palavras"}]',
    '}',
    '12A. Para CADA parágrafo que contenha [F#], inclua um objeto em evidencias para CADA fonte citada nele. O campo paragrafo deve ser a cópia integral e exata do parágrafo; fonteId deve ser o identificador citado; trecho deve ser uma passagem contínua de 3 a 25 palavras, copiada literalmente do texto integral disponibilizado ou, se ele não existir, do resumo.',
    '12B. O trecho literal precisa apoiar diretamente a afirmação do parágrafo. Não escolha uma frase apenas por conter palavras parecidas. Se não houver trecho que sustente a afirmação, reescreva-a como limitação/pergunta em aberto, sem citação afirmativa.',
    '12C. Não use uma fonte para sustentar afirmação sobre população, método, efeito, resultado ou contexto diferente daquele descrito no texto recuperado.',
    '12D. Dê preferência ao texto integral extraído de PDF aberto. Quando só houver resumo, limite a afirmação ao que o resumo efetivamente informa e nunca sugira que o artigo completo foi lido.'
  ].join('\n');

  const response = await gerarConteudoGeminiComRetry(ai, {
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      temperature: 0.35,
      maxOutputTokens: 32768
    }
  }, 'redação acadêmica do TCC');

  const parsed = JSON.parse(limparJson(response && response.text));
  if (!validarSecoes(parsed)) {
    throw new Error('A IA retornou uma estrutura incompleta. Tente novamente; nenhum texto genérico será usado como substituto.');
  }

  await onProgress(72, 'Redação acadêmica produzida. Conferindo citações e evidências nos artigos selecionados...');
  const evidencias = validarEvidenciasTextuais(parsed, fontes);
  const fontesCitadas = validarVinculoDeEvidencias(parsed, fontes);
  await onProgress(82, 'Executando auditoria científica para verificar se os estudos realmente sustentam cada afirmação...');
  const auditoriaEvidencias = await verificarSustentacaoSemantica(ai, evidencias);

  const palavrasGeradas = contarPalavrasSecoes(parsed);
  const palavrasEsperadas = Number(pageCount) * 250;
  const minimoAceitavel = Math.ceil(palavrasEsperadas * 0.8);
  const maximoAceitavel = Math.ceil(palavrasEsperadas * 1.25);
  if (palavrasGeradas < minimoAceitavel || palavrasGeradas > maximoAceitavel) {
    const motivo = palavrasGeradas < minimoAceitavel
      ? 'abaixo da extensão mínima'
      : 'acima da extensão máxima';
    throw new Error(
      'O texto gerado ficou ' + motivo + ': ' +
      palavrasGeradas + ' palavras; faixa esperada para ' + pageCount +
      ' páginas: ' + minimoAceitavel + ' a ' + maximoAceitavel +
      '. Nenhum documento será apresentado como completo. Tente novamente ou ajuste a extensão.'
    );
  }

  const fontesCitadasOrdenadas = aplicarSufixosAno(
    fontes.filter(fonte => fontesCitadas.has(fonte.idFonte))
  );

  const secoes = {};
  for (const chave of Object.keys(parsed)) {
    if (chave === 'evidencias') continue;
    secoes[chave] = parsed[chave].map(paragrafo => substituirMarcadores(paragrafo, fontesCitadasOrdenadas));
  }

  const marcadores = JSON.stringify(parsed).match(/\[F\d+\]/g) || [];
  const fontesCadastradas = new Set(fontes.map(f => f.idFonte));
  for (const marcador of marcadores) {
    const numero = Number(marcador.match(/\d+/)[0]);
    if (!fontesCadastradas.has('F' + numero)) {
      throw new Error('A IA produziu uma citação sem fonte correspondente (' + marcador + '). Gere novamente após revisar as fontes.');
    }
  }

  const citacoesValidas = Array.isArray(citacoesConsagradas) ? citacoesConsagradas : [];
  if (citacoesValidas.length) {
    secoes.citacoesConsagradas = citacoesValidas.flatMap(formatarCitacaoConsagrada);
    secoes.verificacoes = [
      ...secoes.verificacoes,
      'Citações de autores consagrados (seção 4.1): localize cada obra ou discurso original e confirme a frase, a edição e a página. A ABNT NBR 10520:2023 exige a página nas citações diretas, e esses dados não foram recuperados. Complete a referência da obra (local, editora, edição) na lista de referências e confira as traduções.'
    ];
  }

  const referencias = fontesCitadasOrdenadas.map(formatarReferenciaABNT);

  if (!referencias.length) {
    throw new Error('Nenhuma referência pôde ser vinculada às citações do texto. A geração foi interrompida.');
  }

  const matrizRastreabilidade = evidencias.map((evidencia, indice) => {
    const fonte = fontes.find(item => item.idFonte === evidencia.fonteId);
    const auditoria = auditoriaEvidencias.find(item => item.indice === indice);
    return [
      'AFIRMAÇÃO ' + (indice + 1),
      'Trecho do TCC: ' + substituirMarcadores(evidencia.paragrafo, fontesCitadasOrdenadas),
      'Artigo: ' + (fonte && fonte.titulo || evidencia.titulo || 'Título não identificado'),
      'Referência autor-data: ' + (fonte ? formatarCitacao(fonte, fontesCitadasOrdenadas) : 'Não identificada'),
      'Trecho literal localizado na fonte: “' + evidencia.trecho + '”',
      'Material analisado: ' + String(evidencia.statusTextoCompleto || 'Situação não informada'),
      'Resultado da auditoria semântica: ' + String(auditoria && auditoria.status || 'Sem resultado'),
      'Justificativa da auditoria: ' + String(auditoria && auditoria.justificativa || 'Não informada'),
      'Link do artigo: ' + String(fonte && (fonte.urlPaginaArtigo || fonte.link) || 'Não localizado'),
      'Link do PDF: ' + String(fonte && (fonte.pdfUrlVerificado || fonte.pdfUrl) || 'Não localizado')
    ].join('\n');
  }).join('\n\n');

  const relatorio = [
    'RELATÓRIO DE PESQUISA ACADÊMICA',
    'Tema pesquisado: ' + tema,
    'Fontes recuperadas: ' + fontes.length,
    ...(citacoesValidas.length ? [
      'Citações de autores consagrados incluídas: ' + citacoesValidas.length + ' (localizadas e confirmadas por busca na web' +
        (fontesBuscaCitacoes.length ? ': ' + fontesBuscaCitacoes.join(', ') : '') +
        '; a conferência na obra original, com página, continua pendente).'
    ] : []),
    'Fontes com resumo disponível: ' + fontesComResumo.length,
    'Fontes sem resumo: ' + (fontes.length - fontesComResumo.length),
    'Fontes efetivamente citadas no rascunho: ' + fontesCitadas.size,
    'Relações afirmação-fonte submetidas à auditoria semântica automatizada: ' + auditoriaEvidencias.length,
    'A matriz de rastreabilidade abaixo registra o parágrafo, o trecho literal localizado, o artigo consultado, o status da auditoria e os links para conferência pelo orientador.',
    'MATRIZ DE RASTREABILIDADE DAS AFIRMAÇÕES',
    matrizRastreabilidade,
    'Extensão solicitada: aproximadamente ' + pageCount + ' páginas de conteúdo principal.',
    'Palavras nas seções principais: ' + palavrasGeradas + ' (meta aproximada: ' + palavrasEsperadas + ').',
    'Base(s) de recuperação: ' + [...new Set(fontes.map(f => f.fonteDados).filter(Boolean))].join(', ') + ' (metadados e resumos; texto integral somente quando PDF aberto foi efetivamente extraído).',
    'Verificação Crossref: conferência de DOI, título, autoria e ano; não certifica qualidade científica nem revisão por pares.',
    'Textos completos extraídos e analisados: ' + fontes.filter(f => f.textoCompleto).length + ' de ' + fontes.length + '.',
    'Fontes analisadas somente pelo resumo: ' + fontes.filter(f => !f.textoCompleto && f.resumo).length + '.',
    'Situação individual das fontes: ' + fontes.map(f => f.idFonte + ' — ' + (f.textoCompleto ? 'texto integral extraído' : f.resumo ? 'somente resumo disponível' : 'sem conteúdo para análise') + ' (' + (f.statusTextoCompleto || 'PDF não consultado') + ')').join('; '),
    '',
    'ATENÇÃO: a auditoria semântica é uma triagem automatizada, não uma certificação científica. Quando o texto integral não foi obtido, a análise se limita ao resumo e não equivale à leitura completa do artigo. Consulte o link da fonte e confirme cada argumento antes da entrega acadêmica.',
    'NORMALIZAÇÃO: as referências são preliminares e utilizam somente metadados recuperados. Conferir os elementos ausentes e ajustar a apresentação conforme a ABNT NBR 6023:2025, a ABNT NBR 10520:2023 e o manual vigente da instituição.'
  ].join('\n');

  const titulos = [
    ['INTRODUÇÃO', secoes.introducao],
    ['PROBLEMA DE PESQUISA', secoes.problemaPesquisa],
    ['OBJETIVOS', secoes.objetivos],
    ['FUNDAMENTAÇÃO TEÓRICA', secoes.fundamentacaoTeorica],
    ...(secoes.citacoesConsagradas ? [['CITAÇÕES DE AUTORES CONSAGRADOS', secoes.citacoesConsagradas]] : []),
    ['METODOLOGIA', secoes.metodologia],
    ['DISCUSSÃO', secoes.discussao],
    ['CONCLUSÃO', secoes.conclusao],
    ['LIMITAÇÕES DAS FONTES', secoes.limitacoes],
    ['PONTOS PARA VERIFICAÇÃO', secoes.verificacoes]
  ];
  const partes = [];
  for (const [titulo, paragrafos] of titulos) {
    partes.push(titulo);
    partes.push(paragrafos.join('\n\n'));
  }
  partes.push('REFERÊNCIAS PRELIMINARES');
  partes.push(referencias.join('\n\n') || 'Nenhuma fonte foi citada no texto. Revise a fundamentação antes de utilizar este rascunho.');
  partes.push(relatorio);

  return {
    texto: partes.join('\n\n'),
    secoes,
    fontes,
    fontesCitadas: fontesCitadasOrdenadas,
    referencias,
    relatorioPesquisa: relatorio
  };
}

async function gerarRascunhoComPesquisa({ tema, objetivo, limite = 8, pageCount = 10, onProgress = async () => {} }) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY ou GOOGLE_API_KEY não configurada. A geração acadêmica foi interrompida para não produzir texto genérico sem IA.');
  }
  if (!tema || !String(tema).trim()) throw new Error('Informe o tema do TCC.');
  const ai = new GoogleGenAI({ apiKey });

  // Economia de cota: as consultas bibliográficas são derivadas deterministicamente
  // do tema/objetivo pelo módulo de pesquisa. Assim, não gastamos uma chamada Gemini
  // apenas para criar palavras-chave. A redação e a auditoria científica continuam com IA.
  const consultas = [];
  await onProgress(25, 'Buscando artigos específicos do tema em OpenAlex/Crossref e verificando DOI, autores e ano...');
  const fontes = await pesquisarTrabalhos(tema, limite, objetivo, { consultas });
  await onProgress(48, fontes.length + ' fontes acadêmicas passaram pela triagem. Preparando a redação baseada nesses estudos...');

  // A busca Grounding para citações de personalidades é opcional, pois consome cota
  // adicional e não é necessária para a fundamentação científica do TCC.
  // Ative somente se desejar esse recurso: ENABLE_CELEBRITY_QUOTES=true no Render.
  let citacoes = [];
  let fontesBusca = [];
  if (String(process.env.ENABLE_CELEBRITY_QUOTES || '').toLowerCase() === 'true') {
    try {
      const resultadoCitacoes = await gerarCitacoesConsagradas(ai, { tema, objetivo });
      citacoes = resultadoCitacoes.citacoes;
      fontesBusca = resultadoCitacoes.fontesBusca;
    } catch (error) {
      console.warn('⚠️ Citações de autores consagrados indisponíveis; seguindo sem elas:', String(error?.message || error).slice(0, 200));
    }
  }
  await onProgress(58, 'Redigindo introdução, fundamentação teórica, metodologia, discussão e conclusão...');
  const resultado = await gerarTextoTCC({
    tema, objetivo, fontes, pageCount, onProgress,
    citacoesConsagradas: citacoes,
    fontesBuscaCitacoes: fontesBusca
  });
  await onProgress(88, 'Auditoria concluída. Preparando os arquivos finais...');
  return resultado;
}

module.exports = {
  gerarTextoTCC,
  gerarRascunhoComPesquisa,
  formatarCitacao,
  ordenarFontesBibliografia,
  aplicarSufixosAno,
  validarVinculoDeEvidencias,
  validarEvidenciasTextuais,
  validarSecoes,
  contarPalavrasSecoes,
  verificarSustentacaoSemantica,
  substituirMarcadores,
  gerarConsultasBusca,
  gerarCitacoesConsagradas,
  validarCitacoesConsagradas,
  formatarCitacaoConsagrada,
  listarModelosGemini,
  erroPermiteFallbackModelo
};
