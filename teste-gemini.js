
require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');

async function main() {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY não encontrada no arquivo .env');
  }

  const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY
  });

  const response = await ai.models.generateContent({
    model: 'gemini-3.5-flash-lite',
    contents: 'Responda em português: diga em uma frase como você pode ajudar um estudante a planejar um TCC.'
  });

  console.log('\nResposta do Gemini:\n');
  console.log(response.text);
}

main().catch(error => {
  console.error('\nNão foi possível testar o Gemini.');
  console.error(error.message);
});
