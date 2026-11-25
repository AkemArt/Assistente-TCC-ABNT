const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extrairResumo,
  pontuarRelevancia,
  formatarReferenciaABNT
} = require('../pesquisa-academica');

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
