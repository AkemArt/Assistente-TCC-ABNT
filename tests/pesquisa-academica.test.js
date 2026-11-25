const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extrairResumo,
  pontuarRelevancia,
  formatarReferenciaABNT,
  mapearTrabalho,
  verificarNoCrossref,
  urlHttpsPublica,
  tipoPublicacaoAcademicaAceito,
  fetchPdfComRedirecionamentosSeguros
} = require('../pesquisa-academica');
const {
  formatarCitacao,
  ordenarFontesBibliografia,
  aplicarSufixosAno,
  validarVinculoDeEvidencias,
  validarEvidenciasTextuais,
  validarSecoes,
  contarPalavrasSecoes,
  substituirMarcadores
} = require('../ia-tcc');

test('reconstrói resumo a partir do índice invertido do OpenAlex', () => {
  const resumo = extrairResumo({
    'A': [0],
    'pesquisa': [1, 3],
    'é': [2]
  });
  assert.equal(resumo, 'A pesquisa é pesquisa');
});

test('retorna null quando não há resumo recuperável', () => {
  assert.equal(extrairResumo(null), null);
  assert.equal(extrairResumo({}), null);
});

test('pontua correspondência no título e no resumo sem ultrapassar 100', () => {
  const alta = pontuarRelevancia(
    ['machine', 'learning'],
    'Machine learning in education',
    'A study about learning systems'
  );
  const baixa = pontuarRelevancia(
    ['machine', 'learning'],
    'Other subject',
    'Unrelated content'
  );
  assert.equal(alta, 83);
  assert.equal(baixa, 0);
  assert.ok(alta <= 100);
});

test('formata referência com DOI e links recuperados sem inventar dados', () => {
  const referencia = formatarReferenciaABNT({
    autores: ['Ada Lovelace'],
    titulo: 'Estudo demonstrativo',
    revista: 'Revista de Exemplo',
    ano: 2024,
    anoReferencia: '2024a',
    volume: '2',
    numero: '1',
    paginaInicial: '10',
    paginaFinal: '20',
    doi: 'https://doi.org/10.1234/exemplo',
    urlPaginaArtigo: 'https://example.org/article',
    pdfUrl: 'https://example.org/article.pdf'
  });

  assert.match(referencia, /LOVELACE, ADA/);
  assert.match(referencia, /Estudo demonstrativo/);
  assert.match(referencia, /2024a/);
  assert.match(referencia, /DOI: 10\.1234\/exemplo/);
  assert.match(referencia, /https:\/\/example\.org\/article/);
  assert.match(referencia, /https:\/\/example\.org\/article\.pdf/);
});

test('formata citações autor-data segundo NBR 10520:2023', () => {
  assert.equal(
    formatarCitacao({ autores: ['Ada Lovelace'], ano: 2024 }),
    '(Lovelace, 2024)'
  );
  assert.equal(
    formatarCitacao({ autores: ['Ada Lovelace', 'Grace Hopper'], ano: 2024 }),
    '(Lovelace; Hopper, 2024)'
  );
  assert.equal(
    formatarCitacao({ autores: ['Ada Lovelace', 'Grace Hopper', 'Alan Turing'], ano: 2024 }),
    '(Lovelace; Hopper; Turing, 2024)'
  );
  assert.equal(
    formatarCitacao({ autores: ['Ada Lovelace', 'Grace Hopper', 'Alan Turing', 'Katherine Johnson'], ano: 2024 }),
    '(Lovelace et al., 2024)'
  );
});

test('distingue publicações do mesmo autor no mesmo ano com letras', () => {
  const fontes = [
    { openAlexId: 'W2', titulo: 'Título B', autores: ['Ada Lovelace'], ano: 2024 },
    { openAlexId: 'W1', titulo: 'Título A', autores: ['Ada Lovelace'], ano: 2024 }
  ];
  assert.equal(formatarCitacao(fontes[1], fontes), '(Lovelace, 2024a)');
  assert.equal(formatarCitacao(fontes[0], fontes), '(Lovelace, 2024b)');
});

test('ordena a bibliografia por sobrenome do primeiro autor e título', () => {
  const ordenadas = ordenarFontesBibliografia([
    { autores: ['Zelda Costa'], titulo: 'Pesquisa Z' },
    { autores: ['Ada Lovelace'], titulo: 'Pesquisa B' },
    { autores: ['Ada Lovelace'], titulo: 'Pesquisa A' }
  ]);
  assert.deepEqual(ordenadas.map(item => item.titulo), [
    'Pesquisa Z',
    'Pesquisa A',
    'Pesquisa B'
  ]);
});

test('gera DOCX e PPTX com referência e links sem acessar banco de dados', async () => {
  const { generateTccDocx, generateTccPptx } = require('../tcc-projects');
  const fonte = {
    idFonte: 'F1',
    openAlexId: 'https://openalex.org/W123',
    titulo: 'Estudo demonstrativo',
    autores: ['Ada Lovelace'],
    ano: 2024,
    revista: 'Revista de Exemplo',
    doi: '10.1234/exemplo',
    link: 'https://example.org/article',
    urlPaginaArtigo: 'https://example.org/article',
    pdfUrl: 'https://example.org/article.pdf',
    pdfUrlVerificado: 'https://example.org/article.pdf',
    textoCompleto: 'Texto de teste extraído do PDF.',
    statusTextoCompleto: 'Texto extraído de PDF em acesso aberto',
    verificacaoCrossref: 'Confirmado no Crossref'
  };
  const pesquisa = {
    secoes: {
      introducao: ['Introdução fundamentada para o teste.'],
      problemaPesquisa: ['Problema de pesquisa do teste.'],
      objetivos: ['Objetivo geral do teste.'],
      fundamentacaoTeorica: ['Fundamentação teórica do teste.'],
      metodologia: ['Metodologia proposta para o teste.'],
      discussao: ['Discussão acadêmica do teste.'],
      conclusao: ['Conclusão coerente com o objetivo do teste.'],
      limitacoes: ['Limitação do teste.'],
      verificacoes: ['Conferir o artigo original.']
    },
    fontes: [fonte],
    fontesCitadas: [fonte],
    referencias: ['LOVELACE, Ada. Estudo demonstrativo. Revista de Exemplo. 2024.'],
    relatorioPesquisa: 'Relatório de pesquisa de teste.'
  };
  const projeto = {
    studentName: 'Estudante de Teste',
    advisorName: 'Orientador de Teste',
    courseAndInstitution: 'ADS - Instituição de Teste',
    title: 'Projeto de teste acadêmico',
    objective: 'Avaliar a geração dos documentos.',
    pageCount: 10,
    city: 'Caraguatatuba',
    year: 2026
  };

  const docx = await generateTccDocx(projeto, pesquisa);
  const pptx = await generateTccPptx(projeto, pesquisa);
  assert.ok(Buffer.isBuffer(docx));
  assert.ok(docx.length > 1000);
  assert.ok(Buffer.isBuffer(pptx));
  assert.ok(pptx.length > 1000);
});

test('considera tema e objetivo ao pontuar a relevância dos artigos', () => {
  const base = {
    authorships: [{ author: { display_name: 'Ada Lovelace' } }],
    abstract_inverted_index: {
      machine: [0],
      learning: [1]
    },
    doi: 'https://doi.org/10.1234/example',
    best_oa_location: {
      landing_page_url: 'https://example.org/article',
      pdf_url: 'https://example.org/article.pdf'
    },
    primary_location: { source: { display_name: 'Journal of Examples' } },
    publication_year: 2024,
    biblio: {}
  };
  const apenasTema = mapearTrabalho({
    ...base,
    id: 'https://openalex.org/W1',
    title: 'Machine learning'
  }, ['machine', 'learning'], ['health']);
  const temaEObjetivo = mapearTrabalho({
    ...base,
    id: 'https://openalex.org/W2',
    title: 'Machine learning for health'
  }, ['machine', 'learning'], ['health']);

  assert.equal(apenasTema.pontuacaoTema, 100);
  assert.equal(apenasTema.pontuacaoObjetivo, 0);
  assert.ok(temaEObjetivo.pontuacaoRelevancia > apenasTema.pontuacaoRelevancia);
});

test('aplica sufixos de ano também nas referências bibliográficas', () => {
  const fontes = aplicarSufixosAno([
    { openAlexId: 'W2', autores: ['Ada Lovelace'], titulo: 'Título B', ano: 2024 },
    { openAlexId: 'W1', autores: ['Ada Lovelace'], titulo: 'Título A', ano: 2024 }
  ]);
  assert.deepEqual(fontes.map(item => item.anoReferencia), ['2024a', '2024b']);
});

test('bloqueia parágrafo com citação sem fonte existente', () => {
  const dados = {
    introducao: ['Uma afirmação acadêmica [F2] que precisa de fonte.'],
    problemaPesquisa: [], objetivos: [], fundamentacaoTeorica: [],
    metodologia: [], discussao: [], conclusao: []
  };
  assert.throws(
    () => validarVinculoDeEvidencias(dados, [{ idFonte: 'F1' }]),
    /fonte inexistente/
  );
});

test('exige evidência literal para cada fonte citada no parágrafo', () => {
  const fonte = {
    idFonte: 'F1',
    titulo: 'Estudo sobre aprendizagem',
    resumo: 'This study examines machine learning in education and reports improved student outcomes in the observed sample.',
    statusTextoCompleto: 'Somente resumo disponível'
  };
  const paragrafo = 'O estudo relata melhora nos resultados dos estudantes observados [F1].';
  const paragrafoTeoria = 'O resumo informa resultados de aprendizagem na amostra observada [F1].';
  const paragrafoDiscussao = 'A interpretação dos achados deve respeitar os limites da amostra descrita [F1].';
  const paragrafoConclusao = 'A evidência permite concluir apenas sobre os resultados relatados no estudo [F1].';
  const trecho = 'reports improved student outcomes in the observed sample';
  const dados = {
    introducao: [paragrafo],
    problemaPesquisa: ['Problema de pesquisa suficientemente descrito.'],
    objetivos: ['Objetivo geral suficientemente descrito.'],
    fundamentacaoTeorica: [paragrafoTeoria],
    metodologia: ['Metodologia proposta suficientemente descrita.'],
    discussao: [paragrafoDiscussao],
    conclusao: [paragrafoConclusao],
    limitacoes: ['Limitação suficientemente descrita.'],
    verificacoes: ['Verificação suficientemente descrita.'],
    evidencias: [paragrafo, paragrafoTeoria, paragrafoDiscussao, paragrafoConclusao].map(texto => ({
      paragrafo: texto,
      fonteId: 'F1',
      trecho
    }))
  };
  assert.deepEqual(validarVinculoDeEvidencias(dados, [fonte]), new Set(['F1']));
  const evidencias = validarEvidenciasTextuais(dados, [fonte]);
  assert.equal(evidencias.length, 4);
  assert.ok(evidencias.every(item => item.fonteId === 'F1'));
});

test('rejeita trecho de evidência que não existe no texto recuperado', () => {
  const fonte = {
    idFonte: 'F1',
    titulo: 'Estudo',
    resumo: 'The study examines a small sample and reports descriptive observations.'
  };
  const paragrafo = 'A pesquisa comprova um efeito específico [F1].';
  const dados = {
    introducao: [paragrafo],
    problemaPesquisa: [], objetivos: [], fundamentacaoTeorica: [],
    metodologia: [], discussao: [], conclusao: [],
    evidencias: [{
      paragrafo,
      fonteId: 'F1',
      trecho: 'The intervention caused a significant improvement across all populations'
    }]
  };
  assert.throws(
    () => validarEvidenciasTextuais(dados, [fonte]),
    /não foi localizado/
  );
});

test('valida a estrutura acadêmica e calcula a extensão das seções principais', () => {
  const dados = {
    introducao: ['Introdução suficientemente detalhada para teste.'],
    problemaPesquisa: ['Problema de pesquisa suficientemente detalhado.'],
    objetivos: ['Objetivo geral suficientemente detalhado.'],
    fundamentacaoTeorica: ['Fundamentação suficientemente detalhada.'],
    metodologia: ['Metodologia suficientemente detalhada.'],
    discussao: ['Discussão suficientemente detalhada.'],
    conclusao: ['Conclusão suficientemente detalhada.'],
    limitacoes: ['Limitação suficientemente detalhada.'],
    verificacoes: ['Verificação suficientemente detalhada.'],
    evidencias: [{ paragrafo: 'Parágrafo', fonteId: 'F1', trecho: 'Trecho' }]
  };
  assert.equal(validarSecoes(dados), true);
  assert.equal(validarSecoes({ ...dados, secaoExtra: ['Campo não permitido.'] }), false);
  assert.equal(contarPalavrasSecoes({
    introducao: ['um dois três'],
    fundamentacaoTeorica: ['quatro cinco']
  }), 5);
});

test('bloqueia citação autor-data escrita diretamente mesmo quando há marcador de fonte', () => {
  const dados = {
    introducao: ['A pesquisa demonstrou um resultado (Autor Inventado, 2024) [F1].'],
    problemaPesquisa: [], objetivos: [], fundamentacaoTeorica: [],
    metodologia: [], discussao: [], conclusao: []
  };
  assert.throws(
    () => validarVinculoDeEvidencias(dados, [{ idFonte: 'F1' }]),
    /citação autor-data diretamente/
  );
});

test('a auditoria semântica só aprova evidência classificada como sustentada', async () => {
  const { verificarSustentacaoSemantica } = require('../ia-tcc');
  const evidencias = [{
    paragrafo: 'O estudo relata um resultado observado [F1].',
    fonteId: 'F1',
    titulo: 'Estudo demonstrativo',
    trecho: 'the observed outcome improved',
    textoFonte: 'the observed outcome improved in the sample',
    statusTextoCompleto: 'Texto integral extraído'
  }];
  const aiSustenta = {
    models: {
      generateContent: async () => ({
        text: JSON.stringify({
          avaliacoes: [{ indice: 0, status: 'sustentada', justificativa: 'O texto descreve o resultado.' }]
        })
      })
    }
  };
  const aiNaoSustenta = {
    models: {
      generateContent: async () => ({
        text: JSON.stringify({
          avaliacoes: [{ indice: 0, status: 'parcial', justificativa: 'O trecho não comprova toda a afirmação.' }]
        })
      })
    }
  };
  const aprovada = await verificarSustentacaoSemantica(aiSustenta, evidencias);
  assert.equal(aprovada[0].status, 'sustentada');
  await assert.rejects(
    verificarSustentacaoSemantica(aiNaoSustenta, evidencias),
    /não comprovada/
  );
});

test('confirma metadados Crossref somente quando título, autoria e ano coincidem', async () => {
  const fetchOriginal = globalThis.fetch;
  const fonte = {
    doi: '10.1234/teste',
    titulo: 'A study about machine learning',
    autores: ['Ada Lovelace', 'Grace Hopper'],
    ano: 2024
  };
  try {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        message: {
          title: ['A study about machine learning'],
          author: [{ family: 'Lovelace' }, { family: 'Hopper' }],
          published: { 'date-parts': [[2024]] },
          URL: 'https://doi.org/10.1234/teste'
        }
      })
    });
    const confirmado = await verificarNoCrossref(fonte);
    assert.equal(confirmado.verificacaoCrossref, 'Confirmado no Crossref');

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        message: {
          title: ['A study about machine learning'],
          author: [{ family: 'Hopper' }, { family: 'Lovelace' }],
          published: { 'date-parts': [[2024]] }
        }
      })
    });
    // DOI diferente: o Crossref guarda cache por DOI e reaproveitaria o cenário anterior.
    const divergente = await verificarNoCrossref({ ...fonte, doi: '10.1234/teste-divergente' });
    assert.equal(divergente.verificacaoCrossref, 'Divergência de autoria no Crossref');
  } finally {
    globalThis.fetch = fetchOriginal;
  }
});

test('permite HTTPS público e bloqueia endereços locais, reservados e esquemas inseguros', () => {
  assert.equal(urlHttpsPublica('https://example.org/paper.pdf'), true);
  assert.equal(urlHttpsPublica('http://example.org/paper.pdf'), false);
  assert.equal(urlHttpsPublica('https://127.0.0.1/paper.pdf'), false);
  assert.equal(urlHttpsPublica('https://10.0.0.5/paper.pdf'), false);
  assert.equal(urlHttpsPublica('https://172.20.0.1/paper.pdf'), false);
  assert.equal(urlHttpsPublica('https://192.168.1.1/paper.pdf'), false);
  assert.equal(urlHttpsPublica('https://100.64.0.1/paper.pdf'), false);
  assert.equal(urlHttpsPublica('https://[::1]/paper.pdf'), false);
  assert.equal(urlHttpsPublica('https://metadata.internal/latest'), false);
  assert.equal(urlHttpsPublica('https://user:pass@example.org/paper.pdf'), false);
});

test('aceita artigos, revisões e trabalhos de congresso e rejeita tipos não artigo', () => {
  assert.equal(tipoPublicacaoAcademicaAceito('article'), true);
  assert.equal(tipoPublicacaoAcademicaAceito('review'), true);
  assert.equal(tipoPublicacaoAcademicaAceito('proceedings-article'), true);
  assert.equal(tipoPublicacaoAcademicaAceito('book-chapter'), false);
  assert.equal(tipoPublicacaoAcademicaAceito('dataset'), false);
  assert.equal(tipoPublicacaoAcademicaAceito('editorial'), false);
  assert.equal(tipoPublicacaoAcademicaAceito('dissertation'), false);
  assert.equal(tipoPublicacaoAcademicaAceito(null), false);
});

test('substitui marcadores pelo ID da fonte e usa somente as obras citadas nos sufixos', () => {
  const fonteCitata = {
    idFonte: 'F2',
    openAlexId: 'W2',
    titulo: 'Título B',
    autores: ['Ada Lovelace'],
    ano: 2024
  };
  assert.equal(
    substituirMarcadores('A afirmação é sustentada [F2].', [fonteCitata]),
    'A afirmação é sustentada (Lovelace, 2024).'
  );
  const fontesCitadas = aplicarSufixosAno([
    { idFonte: 'F1', openAlexId: 'W1', titulo: 'Título A', autores: ['Ada Lovelace'], ano: 2024 },
    fonteCitata
  ]);
  assert.equal(substituirMarcadores('[F2]', fontesCitadas), '(Lovelace, 2024b)');
  assert.equal(substituirMarcadores('[F2]', [fonteCitata]), '(Lovelace, 2024)');
});

test('limita trechos literais de artigos a 25 palavras e mantém o link para leitura integral', () => {
  const trecho = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twentyone twentytwo twentythree twentyfour twentyfive twentysix';
  const fonte = {
    idFonte: 'F1',
    titulo: 'Estudo',
    resumo: 'O resumo contém este trecho: ' + trecho
  };
  const paragrafo = 'A afirmação acadêmica é sustentada pelo estudo [F1].';
  const dados = {
    introducao: [paragrafo],
    problemaPesquisa: [], objetivos: [], fundamentacaoTeorica: [],
    metodologia: [], discussao: [], conclusao: [],
    evidencias: [{ paragrafo, fonteId: 'F1', trecho }]
  };
  assert.throws(
    () => validarEvidenciasTextuais(dados, [fonte]),
    /excede o limite de 25 palavras/
  );
});

test('exige fonte em cada parágrafo de introdução, teoria, discussão e conclusão', () => {
  const dados = {
    introducao: ['Afirmação acadêmica sem fonte vinculada.'],
    problemaPesquisa: ['Pergunta proposta a partir do objetivo informado.'],
    objetivos: ['Objetivo definido pelo estudante.'],
    fundamentacaoTeorica: ['Fundamentação com marcador [F1].'],
    metodologia: ['Proposta metodológica do projeto.'],
    discussao: ['Discussão com marcador [F1].'],
    conclusao: ['Conclusão com marcador [F1].']
  };
  assert.throws(
    () => validarVinculoDeEvidencias(dados, [{ idFonte: 'F1' }]),
    /não possui marcador de fonte/
  );
});

test('rejeita excerto curto demais para identificar uma evidência acadêmica', () => {
  const fonte = {
    idFonte: 'F1',
    titulo: 'Estudo',
    resumo: 'The study reports a positive result in the observed sample.'
  };
  const paragrafo = 'O estudo relata um resultado observado [F1].';
  const dados = {
    introducao: [paragrafo],
    problemaPesquisa: [], objetivos: [], fundamentacaoTeorica: [],
    metodologia: [], discussao: [], conclusao: [],
    evidencias: [{ paragrafo, fonteId: 'F1', trecho: 'positive result' }]
  };
  assert.throws(
    () => validarEvidenciasTextuais(dados, [fonte]),
    /3 a 25 palavras/
  );
});

test('retorna a URL final após validar cada redirecionamento HTTPS do PDF', async () => {
  const fetchOriginal = globalThis.fetch;
  const chamadas = [];
  try {
    globalThis.fetch = async url => {
      chamadas.push(String(url));
      if (chamadas.length === 1) {
        return {
          status: 302,
          headers: { get: nome => nome.toLowerCase() === 'location' ? 'https://cdn.example.org/final.pdf' : null }
        };
      }
      return {
        status: 200,
        ok: true,
        headers: { get: () => null }
      };
    };
    const resultado = await fetchPdfComRedirecionamentosSeguros('https://example.org/start.pdf');
    assert.equal(resultado.resposta.status, 200);
    assert.equal(resultado.urlFinal, 'https://cdn.example.org/final.pdf');
    assert.deepEqual(chamadas, [
      'https://example.org/start.pdf',
      'https://cdn.example.org/final.pdf'
    ]);
  } finally {
    globalThis.fetch = fetchOriginal;
  }
});

test('bloqueia redirecionamento de PDF para endereço local', async () => {
  const fetchOriginal = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({
      status: 302,
      headers: { get: () => 'https://127.0.0.1/private.pdf' }
    });
    await assert.rejects(
      fetchPdfComRedirecionamentosSeguros('https://example.org/start.pdf'),
      /Endereço de PDF ou redirecionamento não permitido/
    );
  } finally {
    globalThis.fetch = fetchOriginal;
  }
});

test('não mantém PDF HTTP ou privado na referência bibliográfica', () => {
  const fonte = mapearTrabalho({
    id: 'https://openalex.org/W999',
    title: 'A study about secure research links',
    authorships: [{ author: { display_name: 'Ada Lovelace' } }],
    abstract_inverted_index: { secure: [0], research: [1], links: [2] },
    doi: 'https://doi.org/10.1234/secure',
    best_oa_location: {
      landing_page_url: 'https://example.org/article',
      pdf_url: 'http://192.168.1.10/private.pdf'
    },
    primary_location: { source: { display_name: 'Journal of Examples' } },
    publication_year: 2024,
    biblio: {}
  }, ['secure', 'research', 'links']);
  assert.equal(fonte.pdfUrl, null);
});

// ---------------------------------------------------------------------------
// Busca de artigos: chave OpenAlex, resiliência do Crossref e termos da IA
// ---------------------------------------------------------------------------
const {
  montarCabecalhosOpenAlex,
  montarParametrosCrossref,
  limparConsultaCrossref,
  pontuarMelhorGrupo,
  pesquisarTrabalhos
} = require('../pesquisa-academica');
const {
  validarCitacoesConsagradas,
  formatarCitacaoConsagrada,
  listarModelosGemini,
  erroModeloIndisponivel
} = require('../ia-tcc');

test('OpenAlex envia a chave no cabeçalho Authorization, nunca na URL', () => {
  assert.equal(montarCabecalhosOpenAlex('abc123').Authorization, 'Bearer abc123');
  assert.equal(montarCabecalhosOpenAlex('').Authorization, undefined);
});

test('consulta do Crossref remove pontuação e operadores e limita o tamanho', () => {
  assert.equal(limparConsultaCrossref('finanças: "educação" AND (risco)!'), 'finanças educação AND risco');
  assert.ok(limparConsultaCrossref('palavra '.repeat(100)).length <= 200);
  const params = montarParametrosCrossref('educação financeira', 8);
  assert.equal(params.get('rows'), '32');
  assert.match(params.get('filter'), /journal-article/);
  assert.ok(params.get('select'));
  const simples = montarParametrosCrossref('x y', 5, { comSelect: false, comFiltro: false });
  assert.equal(simples.get('select'), null);
  assert.equal(simples.get('filter'), null);
});

test('artigo em inglês é pontuado pelas palavras-chave geradas pela IA', () => {
  const termosPt = ['educacao', 'financeira'];
  const ingles = ['financial', 'literacy'];
  const titulo = 'Financial literacy and household savings';
  assert.equal(pontuarMelhorGrupo(termosPt, [], titulo, ''), 0);
  assert.ok(pontuarMelhorGrupo(termosPt, [ingles], titulo, '') >= 60);
});

test('sem chave OpenAlex vai direto ao Crossref e se recupera de HTTP 400', async () => {
  const fetchOriginal = globalThis.fetch;
  const chaveOriginal = process.env.OPENALEX_API_KEY;
  delete process.env.OPENALEX_API_KEY;
  const urls = [];
  const item = {
    DOI: '10.1111/exemplo',
    title: ['Educação financeira e decisões de poupança'],
    author: [{ given: 'Ana', family: 'Silva' }],
    published: { 'date-parts': [[2022]] },
    type: 'journal-article',
    'container-title': ['Revista de Finanças'],
    abstract: 'Estudo sobre educação financeira e decisões de poupança de famílias brasileiras em diferentes faixas de renda.',
    URL: 'https://doi.org/10.1111/exemplo'
  };
  try {
    globalThis.fetch = async (url) => {
      urls.push(String(url));
      if (String(url).includes('api.openalex.org')) throw new Error('OpenAlex não deveria ser chamada sem chave');
      if (String(url).includes('select=')) {
        return { status: 400, ok: false, text: async () => 'Select qualifier specified with invalid fields', headers: { get: () => null } };
      }
      return { status: 200, ok: true, json: async () => ({ message: { items: [item] } }), headers: { get: () => null } };
    };
    const fontes = await pesquisarTrabalhos('educação financeira', 3, '', { consultas: ['financial literacy savings', 'educação financeira poupança'] });
    assert.equal(fontes.length, 1);
    assert.equal(fontes[0].fonteDados, 'Crossref');
    assert.ok(urls.every(u => !u.includes('openalex')));
    assert.ok(urls.some(u => u.includes('select=')) && urls.some(u => !u.includes('select=')));
  } finally {
    globalThis.fetch = fetchOriginal;
    if (chaveOriginal !== undefined) process.env.OPENALEX_API_KEY = chaveOriginal;
  }
});

test('citações de autores só passam com origem confirmada, tamanho e ano válidos', () => {
  const base = {
    autor: 'Rachel Carson', sobrenome: 'Carson',
    citacao: 'Quanto mais claramente pudermos focalizar nossa atenção nas maravilhas e realidades do universo, menos gosto teremos pela destruição.',
    obra: 'Silent Spring', ano: 1962,
    relacao: 'Relaciona a atenção à natureza com a preservação ambiental.',
    confirmadaNaBusca: true, traducaoLivre: true
  };
  const validas = validarCitacoesConsagradas([
    base,
    { ...base, autor: 'Outro', citacao: 'Frase sem confirmação na busca web feita', confirmadaNaBusca: false },
    { ...base, autor: 'Sem Ano', citacao: 'Frase longa o suficiente para passar no teste', ano: 'desconhecido' },
    { ...base, autor: 'Curta', citacao: 'Muito curta' },
    { ...base },
    null
  ]);
  assert.equal(validas.length, 1);
  const [citacao, obra] = formatarCitacaoConsagrada(validas[0]);
  assert.match(citacao, /\(CARSON, 1962, tradução nossa\)\.$/);
  assert.match(obra, /Silent Spring/);
});

test('troca de modelo Gemini: reconhece 404 e respeita GEMINI_MODEL com vários modelos', () => {
  assert.equal(erroModeloIndisponivel({ status: 404 }), true);
  assert.equal(erroModeloIndisponivel(new Error('models/x is no longer available')), true);
  assert.equal(erroModeloIndisponivel(new Error('HTTP 429 RESOURCE_EXHAUSTED')), false);
  const original = process.env.GEMINI_MODEL;
  process.env.GEMINI_MODEL = 'modelo-a, modelo-b';
  try {
    assert.deepEqual(listarModelosGemini(), ['modelo-a', 'modelo-b']);
  } finally {
    if (original === undefined) delete process.env.GEMINI_MODEL; else process.env.GEMINI_MODEL = original;
  }
});
