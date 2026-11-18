
const BASE_URL = 'https://api.openalex.org/works';



function classificarRelevancia(tema, titulo, resumo) {
  const palavrasIgnoradas = new Set([
    'para', 'como', 'sobre', 'entre', 'mais', 'menos',
    'uma', 'umas', 'uns', 'dos', 'das', 'que', 'com',
    'sem', 'por', 'the', 'and', 'for', 'from', 'with',
    'de', 'da', 'do', 'em', 'no', 'na', 'nos',
    'nas', 'e', 'ou', 'um', 'ao', 'aos', 'as', 'os'
  ]);

  function normalizar(texto) {
    return (texto || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) || [];
  }

  const termos = [...new Set(
    normalizar(tema).filter(
      palavra =>
        palavra.length > 2 &&
        !palavrasIgnoradas.has(palavra)
    )
  )];

  if (termos.length === 0) {
    return {
      nivel: 'RelevÃ¢ncia incerta',
      pontuacao: 0,
      motivo: 'NÃ£o foi possÃ­vel identificar palavras-chave especÃ­ficas no tema.'
    };
  }

  const palavrasTitulo = new Set(normalizar(titulo));
  const palavrasResumo = new Set(normalizar(resumo));

  const termosNoTitulo = termos.filter(
    termo => palavrasTitulo.has(termo)
  );

  const termosNoResumo = termos.filter(
    termo => palavrasResumo.has(termo)
  );

  const coberturaTitulo = termosNoTitulo.length / termos.length;
  const coberturaResumo = termosNoResumo.length / termos.length;

  if (!resumo || !resumo.trim()) {
    const pontuacao = Math.round(coberturaTitulo * 60);

    return {
      nivel: pontuacao >= 30
        ? 'Precisa de anÃ¡lise'
        : 'RelevÃ¢ncia incerta',
      pontuacao,
      motivo: 'NÃ£o hÃ¡ resumo disponÃ­vel; a avaliaÃ§Ã£o considera apenas o tÃ­tulo.'
    };
  }

  const pontuacao = Math.round(
    coberturaTitulo * 60 +
    coberturaResumo * 40
  );

  if (pontuacao >= 70 && coberturaTitulo >= 0.5) {
    return {
      nivel: 'Mais relevante',
      pontuacao,
      motivo: 'Boa correspondÃªncia das palavras-chave, inclusive no tÃ­tulo.'
    };
  }

  if (pontuacao >= 30) {
    return {
      nivel: 'Precisa de anÃ¡lise',
      pontuacao,
      motivo: 'CorrespondÃªncia parcial; confira o objetivo e o conteÃºdo do artigo.'
    };
  }

  return {
    nivel: 'RelevÃ¢ncia incerta',
    pontuacao,
    motivo: 'Poucas palavras-chave correspondem ao tema informado.'
  };
}




function extrairResumo(invertedIndex) {
  if (!invertedIndex || typeof invertedIndex !== 'object') {
    return null;
  }

  const palavras = [];

  for (const [palavra, posicoes] of Object.entries(invertedIndex)) {
    if (!Array.isArray(posicoes)) continue;

    for (const posicao of posicoes) {
      if (Number.isInteger(posicao) && posicao >= 0) {
        palavras[posicao] = palavra;
      }
    }
  }

  const resumo = palavras.join(' ').trim();
  return resumo || null;
}

async function pesquisarTrabalhos(tema, limite = 5) {
  if (!tema || !tema.trim()) {
    throw new Error('Informe um tema para pesquisar.');
  }

  const quantidade = Math.min(Math.max(Number(limite) || 5, 1), 10);

  const params = new URLSearchParams({
    search: tema.trim(),
    'per-page': String(quantidade),
    sort: 'relevance_score:desc'
  });

  const resposta = await fetch(`${BASE_URL}?${params.toString()}`, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Assistente-TCC-ABNT/1.0'
    },
    signal: AbortSignal.timeout(20000)
  });

  if (!resposta.ok) {
    throw new Error(`Erro na pesquisa acadÃªmica: HTTP ${resposta.status}`);
  }

  const dados = await resposta.json();


return (dados.results || []).map(trabalho => {
    const autores = (trabalho.authorships || [])
      .map(item => item.author?.display_name)
      .filter(Boolean);

    const doi = trabalho.doi || null;

    const link =
      doi ||
      trabalho.primary_location?.landing_page_url ||
      trabalho.id ||
      null;

    const revista =
      trabalho.primary_location?.source?.display_name || null;

    const ano = trabalho.publication_year || null;
    const titulo = trabalho.title || 'TÃ­tulo nÃ£o informado';

    const volume = trabalho.biblio?.volume || null;
    const numero = trabalho.biblio?.issue || null;
    const paginaInicial = trabalho.biblio?.first_page || null;
    const paginaFinal = trabalho.biblio?.last_page || null;

    const resumo = extrairResumo(trabalho.abstract_inverted_index);

    const referencia = [
      autores.length ? autores.join('; ') : '[AUTORIA NÃƒO INFORMADA]',
      titulo,
      revista,
      ano,
      volume ? `v. ${volume}` : null,
      numero ? `n. ${numero}` : null,
      paginaInicial
        ? `p. ${paginaInicial}${paginaFinal ? `-${paginaFinal}` : ''}`
        : null,
      doi ? `DOI: ${doi}` : link ? `DisponÃ­vel em: ${link}` : null
    ]
      .filter(Boolean)
      .join('. ');

    const relevancia = classificarRelevancia(
      tema,
      titulo,
      resumo
    );

    return {
      titulo,
      autores,
      ano,
      revista,
      volume,
      numero,
      paginaInicial,
      paginaFinal,
      doi,
      link,
      resumo,
      citacoes: trabalho.cited_by_count ?? null,
      tipo: trabalho.type || null,
      idioma: trabalho.language || null,
      acessoAberto: trabalho.open_access?.is_oa ?? null,
      referencia,
      relevancia: relevancia.nivel,
      pontuacaoRelevancia: relevancia.pontuacao,
      motivoRelevancia: relevancia.motivo
    };
  });
}


module.exports = { pesquisarTrabalhos };
