require('dotenv').config();
const { gerarTextoTCC } = require('./ia-tcc');

async function main() {
  const texto = await gerarTextoTCC({
    tema: 'Uso da inteligência artificial na educação',
    objetivo: 'Analisar oportunidades e desafios do uso de IA na aprendizagem',
    fontes: []
  });

  console.log('\n--- RASCUNHO GERADO ---\n');
  console.log(texto);
}

main().catch(error => {
  console.error('Erro no teste:', error.message);
});