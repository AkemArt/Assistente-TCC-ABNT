
const { pesquisarTrabalhos } = require('./pesquisa-academica');

async function testar() {
  try {
    const tema = 'Impacto do ChatGPT na aprendizagem de estudantes do ensino superior';

    console.log('\nPESQUISANDO:', tema);
    console.log('='.repeat(60));

    const trabalhos = await pesquisarTrabalhos(tema, 5);

    if (trabalhos.length === 0) {
      console.log('Nenhum trabalho encontrado.');
      return;
    }

    for (const [i, trabalho] of trabalhos.entries()) {
      console.log(`\n${i + 1}. ${trabalho.titulo}`);
      console.log(`Ano: ${trabalho.ano || 'Não informado'}`);
      console.log(
        `Relevância: ${trabalho.relevancia || 'Não calculada'}`
      );
      console.log(
        `Pontuação: ${trabalho.pontuacaoRelevancia ?? 'Não disponível'}/100`
      );
      console.log(
        `Motivo: ${trabalho.motivoRelevancia || 'Não informado'}`
      );
      console.log(
        `Resumo disponível: ${trabalho.resumo ? 'Sim' : 'Não'}`
      );
      console.log(`DOI: ${trabalho.doi || 'Não informado'}`);
      console.log(`Link: ${trabalho.link || 'Não informado'}`);
      console.log('-'.repeat(60));
    }
  } catch (erro) {
    console.error('Erro no teste:', erro.message);
  }
}

testar();
