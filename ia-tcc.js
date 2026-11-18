
require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');
const { pesquisarTrabalhos } = require('./pesquisa-academica');

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

async function gerarTextoTCC({ tema, objetivo, fontes }) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY nÃ£o configurada no arquivo .env');
  }

  if (!tema || !tema.trim()) {
    throw new Error('Informe o tema do TCC.');
  }

  const listaFontes = Array.isArray(fontes) && fontes.length
    ? fontes.map((fonte, i) =>
        `${i + 1}. ${fonte.titulo || fonte.title || 'TÃ­tulo nÃ£o informado'}
Autor(es): ${Array.isArray(fonte.autores) ? fonte.autores.join(', ') : fonte.autores || fonte.authors || 'NÃ£o informado'}
Ano: ${fonte.ano || fonte.year || 'NÃ£o informado'}
PeriÃ³dico: ${fonte.revista || 'NÃ£o informado'}
Resumo ou conteÃºdo fornecido: ${fonte.resumo || fonte.abstract || 'NÃ£o fornecido'}
DOI ou link: ${fonte.link || fonte.doi || 'NÃ£o informado'}`
      ).join('\n\n')
    : 'Nenhuma fonte acadÃªmica foi fornecida. NÃ£o invente citaÃ§Ãµes ou referÃªncias.';

  const prompt = `
VocÃª Ã© um assistente acadÃªmico que auxilia na elaboraÃ§Ã£o de TCCs
em portuguÃªs brasileiro.

Tema: ${tema}
Objetivo: ${objetivo || 'A definir com o estudante.'}

FONTES LOCALIZADAS:
${listaFontes}



REGRAS DE CONFIABILIDADE ACADÃŠMICA:

1. Utilize somente as informaÃ§Ãµes efetivamente presentes nos metadados e resumos fornecidos.
2. Nunca invente autores, tÃ­tulos, datas, resultados, mÃ©todos, estatÃ­sticas, citaÃ§Ãµes ou referÃªncias.
3. SÃ³ atribua uma afirmaÃ§Ã£o a um autor quando o resumo fornecido sustentar claramente essa afirmaÃ§Ã£o.
4. Se o resumo nÃ£o confirmar uma informaÃ§Ã£o, nÃ£o use o artigo como evidÃªncia dessa informaÃ§Ã£o.
5. NÃ£o interprete o tÃ­tulo de um artigo como prova de seus resultados ou conclusÃµes.
6. NÃ£o crie citaÃ§Ãµes autor-data, como (SILVA, 2024), sem evidÃªncia suficiente para justificar a atribuiÃ§Ã£o.
7. NÃ£o invente pÃ¡ginas para citaÃ§Ãµes diretas. Sem acesso ao texto original e Ã  pÃ¡gina correspondente, nÃ£o produza citaÃ§Ãµes diretas.
8. Diferencie informaÃ§Ãµes confirmadas pelas fontes de contextualizaÃ§Ãµes gerais que ainda precisam ser verificadas.
9. Quando nÃ£o houver resumo disponÃ­vel, informe que os metadados permitem identificar o trabalho, mas nÃ£o confirmar seu conteÃºdo.
10. Se as fontes forem insuficientes, explique essa limitaÃ§Ã£o em vez de preencher as lacunas com informaÃ§Ãµes presumidas.
11. NÃ£o afirme que um artigo foi lido integralmente quando somente seu resumo ou seus metadados foram consultados.
12. Ao final, apresente uma lista de afirmaÃ§Ãµes que precisam ser verificadas nos artigos originais.
13. NÃ£o declare que o texto estÃ¡ integralmente conforme a ABNT sem revisÃ£o.
14. Trate o resultado como um rascunho acadÃªmico que exige revisÃ£o do estudante e do orientador.

PRODUZA:
1. Uma sugestÃ£o de estrutura para o capÃ­tulo.
2. Um rascunho acadÃªmico inicial baseado nas evidÃªncias disponÃ­veis.
3. Uma lista de afirmaÃ§Ãµes que precisam de verificaÃ§Ã£o.
4. Uma indicaÃ§Ã£o explÃ­cita das limitaÃ§Ãµes das fontes utilizadas.

NÃ£o crie a lista de referÃªncias bibliogrÃ¡ficas no texto gerado.
As referÃªncias serÃ£o acrescentadas pelo programa com base nos metadados recuperados pela OpenAlex.

Produza:
1. Uma sugestÃ£o de estrutura para o capÃ­tulo.
2. Um rascunho acadÃªmico inicial, sem inventar evidÃªncias.
3. Uma lista do que precisa ser lido ou verificado.

NÃ£o produza uma seÃ§Ã£o de referÃªncias bibliogrÃ¡ficas.
A lista final de referÃªncias serÃ¡ acrescentada pelo programa usando
os metadados retornados pela OpenAlex.
`;

  const response = await ai.models.generateContent({
    model: 'gemini-3.5-flash-lite',
    contents: prompt
  });

  return response.text;
}


async function gerarRascunhoComPesquisa({ tema, objetivo, limite = 5 }) {
  const fontes = await pesquisarTrabalhos(tema, limite);
console.log('\n===== RESUMOS DAS FONTES ACADÃŠMICAS =====');

for (const [i, fonte] of fontes.entries()) {
  console.log(`\nFonte ${i + 1}: ${fonte.titulo}`);
  console.log(`Resumo disponÃ­vel: ${fonte.resumo ? 'Sim' : 'NÃ£o'}`);

  if (fonte.resumo) {
    console.log(`Trecho do resumo: ${fonte.resumo.slice(0, 300)}...`);
  }
}

console.log('\n===== FIM DOS RESUMOS =====\n');

  if (fontes.length === 0) {
    throw new Error(
      'Nenhuma fonte acadÃªmica foi encontrada para esse tema. Tente outros termos.'
    );
  }

  const texto = await gerarTextoTCC({
    tema,
    objetivo,
    fontes
  });

  const totalFontes = fontes.length;

  const fontesComResumo = fontes.filter(
    fonte => fonte.resumo && fonte.resumo.trim().length > 0
  ).length;

  const fontesSemResumo = totalFontes - fontesComResumo;

  const fontesComDOI = fontes.filter(
    fonte => fonte.doi
  ).length;

  const fontesComLink = fontes.filter(
    fonte => fonte.link
  ).length;

  const maisRelevantes = fontes.filter(
    fonte => fonte.relevancia === 'Mais relevante'
  ).length;

  const precisamAnalise = fontes.filter(
    fonte => fonte.relevancia === 'Precisa de anÃ¡lise'
  ).length;

  const relevanciaIncerta = fontes.filter(
    fonte => fonte.relevancia === 'RelevÃ¢ncia incerta'
  ).length;


  const relatorioPesquisa = [
    'RELATÃ“RIO DA PESQUISA ACADÃŠMICA',
    '================================',
    `Tema pesquisado: ${tema}`,
    `Total de fontes encontradas: ${totalFontes}`,
    `Fontes com resumo disponÃ­vel: ${fontesComResumo}`,
    `Fontes sem resumo: ${fontesSemResumo}`,
    `Fontes com DOI: ${fontesComDOI}`,
    `Fontes com link para consulta: ${fontesComLink}`,

    `Mais relevantes: ${maisRelevantes}`,
    `Precisam de anÃ¡lise: ${precisamAnalise}`,
    `RelevÃ¢ncia incerta: ${relevanciaIncerta}`,

    '',
    'ATENÃ‡ÃƒO:',
    'A presenÃ§a de um resumo nÃ£o garante que a fonte seja adequada.',
    'Confira o artigo original antes de utilizar suas afirmaÃ§Ãµes.',
    'A ausÃªncia de resumo nÃ£o significa que o artigo nÃ£o tenha texto completo.'
  ].join('\n');


  const listaReferencias = fontes.map((fonte, indice) => {
    const autores = Array.isArray(fonte.autores)
      ? fonte.autores.join('; ')
      : fonte.autores || 'Autoria nÃ£o informada';

    return [
      `${indice + 1}. ${autores}.`,
      `${fonte.titulo || 'TÃ­tulo nÃ£o informado'}.`,
      fonte.revista || null,
      fonte.ano || null,
      fonte.volume ? `v. ${fonte.volume}` : null,
      fonte.numero ? `n. ${fonte.numero}` : null,
      fonte.paginaInicial
        ? `p. ${fonte.paginaInicial}${fonte.paginaFinal ? `-${fonte.paginaFinal}` : ''}`
        : null,
      fonte.doi ? `DOI: ${fonte.doi}` : null,
      !fonte.doi && fonte.link ? `DisponÃ­vel em: ${fonte.link}` : null
    ]
      .filter(Boolean)
      .join('. ');
  }).join('\n\n');


  const textoSemListaDuplicada = texto
    .replace(
      /(?:#{1,6}\s*)?(?:Lista de Fontes Encontradas|ReferÃªncias Encontradas na OpenAlex|ReferÃªncias BibliogrÃ¡ficas)[\s\S]*$/i,
      ''
    )
    .trim();


  const textoFinal =
    `${textoSemListaDuplicada}\n\n` +
    `${relatorioPesquisa}\n\n` +
    `${'='.repeat(55)}\n` +
    'REFERÃŠNCIAS ENCONTRADAS NA OPENALEX\n' +
    `${'='.repeat(55)}\n\n` +
    `${listaReferencias}\n\n` +
    'Nota: referÃªncias preliminares geradas a partir dos metadados ' +
    'da OpenAlex. Confira os dados nos documentos originais e ajuste ' +
    'a formataÃ§Ã£o conforme as normas ABNT exigidas pela sua instituiÃ§Ã£o.';



  return { texto: textoFinal, fontes };
}

module.exports = {
  gerarTextoTCC,
  gerarRascunhoComPesquisa
};
