const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extrairResumo,
  pontuarRelevancia,
  formatarReferenciaABNT,
  mapearTrabalho
} = require('../pesquisa-academica');
const {
  formatarCitacao,
  ordenarFontesBibliografia
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
    'Pesquisa A',
    'Pesquisa B',
    'Pesquisa Z'
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
