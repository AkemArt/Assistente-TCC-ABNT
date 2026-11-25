require('dotenv').config();

const { GoogleGenAI } = require('@google/genai');
const { pesquisarTrabalhos, formatarReferenciaABNT } = require('./pesquisa-academica');

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
    const fonte = fontes[Number(numero) - 1];
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

  for (const secao of secoesTextuais) {
    const paragrafos = Array.isArray(dados[secao]) ? dados[secao] : [];
    for (const paragrafo of paragrafos) {
      const texto = String(paragrafo || '');
      const marcadores = texto.match(/\[F\d+\]/g) || [];
      const contemCitacaoAutorData = /\([^)]{1,100}\b(?:19|20)\d{2}[a-z]?\s*\)/i.test(texto);

      if (contemCitacaoAutorData && marcadores.length === 0) {
        throw new Error('Foi encontrada uma citação autor-data sem vínculo com uma fonte recuperada. O texto foi bloqueado para evitar referência inventada.');
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
    if (trechoNormalizado.length < 35 || !textoNormalizado.includes(trechoNormalizado)) {
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

  const response = await ai.models.generateContent({
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      temperature: 0
    }
  });

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

  const porIndice = new Map(resultado.avaliacoes.map(item => [item.indice, item]));
  for (let i = 0; i < evidencias.length; i += 1) {
    const avaliacao = porIndice.get(i);
    if (!avaliacao || avaliacao.status !== 'sustentada') {
      const status = avaliacao && avaliacao.status || 'sem avaliação';
      throw new Error('Afirmação não comprovada pela fonte ' + evidencias[i].fonteId +
        ' (resultado da auditoria: ' + status + '). Revise a afirmação ou encontre um estudo que a sustente. Nenhum texto será apresentado como fundamentado sem essa confirmação.');
    }
  }
  return resultado.avaliacoes;
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

async function gerarTextoTCC({ tema, objetivo, fontes, pageCount = 10 }) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY ou GOOGLE_API_KEY não configurada. A geração acadêmica foi interrompida para não produzir texto genérico sem IA.');
  }
  if (!tema || !String(tema).trim()) throw new Error('Informe o tema do TCC.');
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
      'DOI/link: ' + (fonte.doi || fonte.link || 'Não informado'),
      'Página do artigo: ' + (fonte.urlPaginaArtigo || fonte.link || 'Não informada'),
      'PDF em acesso aberto: ' + (fonte.pdfUrlVerificado || fonte.pdfUrl || 'Não localizado'),
      'Situação do texto completo: ' + (fonte.statusTextoCompleto || 'Não verificada'),
      'Conferência dos metadados: ' + (fonte.verificacaoCrossref || 'Não verificada'),
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
    'FONTES REAIS RECUPERADAS NA OPENALEX:',
    fontesText,
    '',
    'REGRAS INEGOCIÁVEIS DE EVIDÊNCIA:',
    '1. Use exclusivamente as fontes listadas para citações e afirmações atribuídas a estudos.',
    '2. Quando uma afirmação for sustentada por uma fonte, inclua o marcador exato [F1], [F2] etc. no fim da frase. O programa converterá esses marcadores em citações autor-data.',
    '2A. A extensão é requisito: distribua o volume entre as seções principais e aproxime-se da meta de palavras informada. Aprofunde definições, delimitações, relações entre conceitos, comparação crítica e justificativas metodológicas, sem repetir ideias.',
    '3. Nunca escreva nomes de pesquisadores famosos, teorias, estatísticas, resultados ou citações textuais que não estejam comprovados nos dados das fontes fornecidas.',
    '4. Não cite uma fonte sem resumo ou texto integral como evidência de conteúdo. Ela pode aparecer somente como referência localizada, sinalizando que o conteúdo precisa ser consultado.',
    '5. Não atribua ao artigo resultados que não estejam descritos no material efetivamente disponibilizado. Quando só houver resumo, limite as afirmações ao resumo e não diga que leu o texto completo.',
    '6. Não invente citações diretas, páginas, DOI, autores, datas ou títulos.',
    '7. Faça síntese crítica: aproxime e contraste achados quando o texto integral ou os resumos efetivamente disponibilizados permitirem; não faça uma lista mecânica de artigos.',
    '8. Desenvolva o raciocínio a partir do recorte real do tema. Explique conceitos específicos e relações entre variáveis somente quando houver base nas fontes.',
    '9. Não invente metodologia já executada. Apresente uma proposta metodológica compatível com o objetivo e sinalize o que o estudante precisa decidir.',
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
    ' "evidencias": [{"paragrafo":"copie exatamente um parágrafo citado, incluindo seu marcador [F1]","fonteId":"F1","trecho":"copie literalmente um trecho contínuo do texto integral disponibilizado ou, se indisponível, do resumo da fonte, sem alterar palavras"}]',
    '}',
    '12A. Para CADA parágrafo que contenha [F#], inclua um objeto em evidencias para CADA fonte citada nele. O campo paragrafo deve ser a cópia integral e exata do parágrafo; fonteId deve ser o identificador citado; trecho deve ser uma passagem contínua, copiada literalmente do texto integral disponibilizado ou, se ele não existir, do resumo.',
    '12B. O trecho literal precisa apoiar diretamente a afirmação do parágrafo. Não escolha uma frase apenas por conter palavras parecidas. Se não houver trecho que sustente a afirmação, reescreva-a como limitação/pergunta em aberto, sem citação afirmativa.',
    '12C. Não use uma fonte para sustentar afirmação sobre população, método, efeito, resultado ou contexto diferente daquele descrito no texto recuperado.',
    '12D. Dê preferência ao texto integral extraído de PDF aberto. Quando só houver resumo, limite a afirmação ao que o resumo efetivamente informa e nunca sugira que o artigo completo foi lido.'
  ].join('\n');

  const response = await ai.models.generateContent({
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      temperature: 0.35,
      maxOutputTokens: 32768
    }
  });

  const parsed = JSON.parse(limparJson(response && response.text));
  if (!validarSecoes(parsed)) {
    throw new Error('A IA retornou uma estrutura incompleta. Tente novamente; nenhum texto genérico será usado como substituto.');
  }

  const evidencias = validarEvidenciasTextuais(parsed, fontes);
  const fontesCitadas = validarVinculoDeEvidencias(parsed, fontes);
  const auditoriaEvidencias = await verificarSustentacaoSemantica(ai, evidencias);

  const palavrasGeradas = contarPalavrasSecoes(parsed);
  const palavrasEsperadas = Number(pageCount) * 250;
  const minimoAceitavel = Math.ceil(palavrasEsperadas * 0.8);
  if (palavrasGeradas < minimoAceitavel) {
    throw new Error(
      'O texto gerado ficou abaixo da extensão mínima: ' +
      palavrasGeradas + ' palavras; mínimo esperado para ' + pageCount +
      ' páginas: ' + minimoAceitavel +
      '. Nenhum documento será apresentado como completo. Tente novamente ou reduza a extensão.'
    );
  }

  const secoes = {};
  for (const chave of Object.keys(parsed)) {
    if (chave === 'evidencias') continue;
    secoes[chave] = parsed[chave].map(paragrafo => substituirMarcadores(paragrafo, fontes));
  }

  const marcadores = JSON.stringify(parsed).match(/\[F\d+\]/g) || [];
  const fontesCadastradas = new Set(fontes.map(f => f.idFonte));
  for (const marcador of marcadores) {
    const numero = Number(marcador.match(/\d+/)[0]);
    if (!fontesCadastradas.has('F' + numero)) {
      throw new Error('A IA produziu uma citação sem fonte correspondente (' + marcador + '). Gere novamente após revisar as fontes.');
    }
  }

  const fontesCitadasOrdenadas = aplicarSufixosAno(
    fontes.filter(fonte => fontesCitadas.has(fonte.idFonte))
  );
  const referencias = fontesCitadasOrdenadas.map(formatarReferenciaABNT);

  if (!referencias.length) {
    throw new Error('Nenhuma referência pôde ser vinculada às citações do texto. A geração foi interrompida.');
  }

  const relatorio = [
    'RELATÓRIO DE PESQUISA ACADÊMICA',
    'Tema pesquisado: ' + tema,
    'Fontes recuperadas: ' + fontes.length,
    'Fontes com resumo disponível: ' + fontesComResumo.length,
    'Fontes sem resumo: ' + (fontes.length - fontesComResumo.length),
    'Fontes efetivamente citadas no rascunho: ' + fontesCitadas.size,
    'Relações afirmação-fonte submetidas à auditoria semântica automatizada: ' + auditoriaEvidencias.length,
    'Extensão solicitada: aproximadamente ' + pageCount + ' páginas de conteúdo principal.',
    'Palavras nas seções principais: ' + palavrasGeradas + ' (meta aproximada: ' + palavrasEsperadas + ').',
    'Base consultada: OpenAlex (metadados, resumos e textos completos em PDF aberto quando localizados).',
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

async function gerarRascunhoComPesquisa({ tema, objetivo, limite = 8, pageCount = 10 }) {
  const fontes = await pesquisarTrabalhos(tema, limite, objetivo);
  return gerarTextoTCC({ tema, objetivo, fontes, pageCount });
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
  verificarSustentacaoSemantica
};
