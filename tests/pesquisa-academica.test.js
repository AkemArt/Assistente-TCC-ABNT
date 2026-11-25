const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extrairResumo,
  pontuarRelevancia,
  formatarReferenciaABNT
} = require('../pesquisa-academica');
const { formatarCitacao } = require('../ia-tcc');

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
