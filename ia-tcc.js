require('dotenv').config();

const { GoogleGenAI } = require('@google/genai');
const { pesquisarTrabalhos, formatarReferenciaABNT } = require('./pesquisa-academica');

function formatarCitacao(fonte) {
  const autores = Array.isArray(fonte.autores) ? fonte.autores : [];
  if (!autores.length) return '(AUTORIA NÃO IDENTIFICADA, ' + (fonte.ano || 's.d.') + ')';
  const sobrenomes = autores.map(nome => {
    const partes = String(nome).trim().split(/\s+/);
    return (partes[partes.length - 1] || nome).toUpperCase();
  });
  const autor = sobrenomes.length > 2
    ? sobrenomes[0] + ' et al.'
    : sobrenomes.join(' e ');
  return '(' + autor + ', ' + (fonte.ano || 's.d.') + ')';
}

function substituirMarcadores(texto, fontes) {
  return String(texto || '').replace(/\[F(\d+)\]/g, (marcador, numero) => {
    const fonte = fontes[Number(numero) - 1];
    return fonte ? formatarCitacao(fonte) : '[MARCADOR DE FONTE INVÁLIDO]';
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
    'verificacoes'
  ];
  return obrigatorias.every(chave => Array.isArray(dados[chave]));
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
      'Conferência dos metadados: ' + (fonte.verificacaoCrossref || 'Não verificada'),
      'Resumo: ' + (fonte.resumo || 'Resumo indisponível; não utilizar para sustentar afirmações.')
    ].join('\n');
  }).join('\n\n');

  const prompt = [
    'Você é pesquisador e redator acadêmico experiente, escrevendo em português brasileiro formal.',
    'Produza um rascunho acadêmico ORIGINAL, aprofundado e específico para o tema abaixo. Não use uma estrutura de frases pronta que serviria para qualquer assunto.',
    '',
    'TEMA: ' + tema,
    'OBJETIVO INFORMADO: ' + (objetivo || 'Ainda não informado; não invente objetivo específico.'),
    'EXTENSÃO SOLICITADA: aproximadamente ' + pageCount + ' páginas no documento final. Desenvolva o conteúdo proporcionalmente, com profundidade e sem repetição artificial. Use cerca de 250 palavras por página de texto principal como referência aproximada; a paginação real depende da diagramação, elementos pré-textuais e referências.',
    '',
    'FONTES REAIS RECUPERADAS NA OPENALEX:',
    fontesText,
    '',
    'REGRAS INEGOCIÁVEIS DE EVIDÊNCIA:',
    '1. Use exclusivamente as fontes listadas para citações e afirmações atribuídas a estudos.',
    '2. Quando uma afirmação for sustentada por uma fonte, inclua o marcador exato [F1], [F2] etc. no fim da frase. O programa converterá esses marcadores em citações autor-data.',
    '2A. Atenda à extensão com desenvolvimento substantivo: contextualização específica, conceitos, comparação crítica dos estudos, explicação metodológica e discussão. Não repita ideias nem invente conteúdo para preencher páginas.',
    '3. Nunca escreva nomes de pesquisadores famosos, teorias, estatísticas, resultados ou citações textuais que não estejam comprovados nos dados das fontes fornecidas.',
    '4. Não cite uma fonte sem resumo como evidência de conteúdo. Ela pode aparecer somente como referência localizada, sinalizando que o conteúdo precisa ser consultado.',
    '5. Não atribua ao artigo resultados que não estejam descritos no resumo. Não diga que leu o texto completo.',
    '6. Não invente citações diretas, páginas, DOI, autores, datas ou títulos.',
    '7. Faça síntese crítica: aproxime e contraste achados quando os resumos permitirem; não faça uma lista mecânica de artigos.',
    '8. Desenvolva o raciocínio a partir do recorte real do tema. Explique conceitos específicos e relações entre variáveis somente quando houver base nas fontes.',
    '9. Não invente metodologia já executada. Apresente uma proposta metodológica compatível com o objetivo e sinalize o que o estudante precisa decidir.',
    '10. Não use parágrafos genéricos sobre a importância da tecnologia, sociedade ou atualidade se não forem pertinentes ao tema.',
    '11. Se as fontes não forem suficientes para determinada seção, escreva isso explicitamente em limitacoes e verificacoes.',
    '12. Não crie a lista de referências. Ela será montada pelo programa com os metadados recuperados.',
    '',
    'FORMATO DE SAÍDA: responda somente com JSON válido, sem markdown, com exatamente estas chaves:',
    '{',
    ' "introducao": ["3 a 5 parágrafos analíticos"],',
    ' "problemaPesquisa": ["delimitação e pergunta de pesquisa"],',
    ' "objetivos": ["objetivo geral", "objetivos específicos"],',
    ' "fundamentacaoTeorica": ["4 a 8 parágrafos com conceitos e citações [F#]"],',
    ' "metodologia": ["2 a 4 parágrafos com proposta metodológica e ressalvas"],',
    ' "discussao": ["2 a 4 parágrafos de síntese crítica das fontes"],',
    ' "conclusao": ["2 a 3 parágrafos coerentes com as evidências e sem inventar resultados"],',
    ' "limitacoes": ["limitações concretas das fontes recuperadas"],',
    ' "verificacoes": ["itens que o estudante deve conferir nos textos originais"]',
    '}'
  ].join('\n');

  const response = await ai.models.generateContent({
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      temperature: 0.35
    }
  });

  const parsed = JSON.parse(limparJson(response && response.text));
  if (!validarSecoes(parsed)) {
    throw new Error('A IA retornou uma estrutura incompleta. Tente novamente; nenhum texto genérico será usado como substituto.');
  }

  const fontesCitadas = validarVinculoDeEvidencias(parsed, fontes);

  const secoes = {};
  for (const chave of Object.keys(parsed)) {
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

  const referencias = fontes
    .filter((fonte, indice) => fontesCitadas.has(indice + 1))
    .map(formatarReferenciaABNT);

  const relatorio = [
    'RELATÓRIO DE PESQUISA ACADÊMICA',
    'Tema pesquisado: ' + tema,
    'Fontes recuperadas: ' + fontes.length,
    'Fontes com resumo disponível: ' + fontesComResumo.length,
    'Fontes sem resumo: ' + (fontes.length - fontesComResumo.length),
    'Fontes efetivamente citadas no rascunho: ' + fontesCitadas.size,
    'Base consultada: OpenAlex (metadados e resumos disponíveis).',
    '',
    'ATENÇÃO: os resumos não equivalem à leitura integral dos artigos. Consulte os textos originais antes de validar cada argumento e referência.'
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
  gerarRascunhoComPesquisa
};
