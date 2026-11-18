# Atualização: salvar projetos e gerar modelo Word

Esta atualização adiciona ao comando `/iniciar_tcc`:
- criação automática da tabela `tcc_projects` no PostgreSQL;
- salvamento dos dados do formulário;
- geração de um arquivo Word `.docx` inicial;
- envio do documento como anexo na resposta privada do Discord;
- registro do evento `document_generated` nas estatísticas.

## Como aplicar sem perder o `.env`

1. Faça uma cópia de segurança da pasta `Bot` atual.
2. Substitua `bot.js` e `package.json` pelos arquivos desta atualização.
3. Copie `tcc-projects.js` para a mesma pasta onde ficam `bot.js` e `database.js`.
4. **Não substitua nem apague seu arquivo `.env`**: ele contém o token do Discord e a conexão do banco.
5. Abra o CMD dentro da pasta `Bot` e execute:

   ```cmd
   npm install
   ```

6. Quando terminar, execute:

   ```cmd
   node bot.js
   ```

7. Espere no terminal as mensagens de tabelas de estatísticas e de projetos de TCC verificadas.
8. No Discord, execute `/iniciar_tcc` e preencha o formulário. A resposta deverá trazer o resumo e o arquivo `TCC_modelo_ID.docx`.

## Limites desta etapa

O Word gerado é um **modelo inicial**: inclui capa, folha de rosto e seções estruturais com instruções. Ele não pesquisa fontes nem escreve um TCC completo com IA. Revise a formatação com o manual da instituição e as normas vigentes antes de entregar um trabalho acadêmico.

Se a instalação ou o teste falhar, copie a mensagem de erro do terminal, ocultando tokens, senhas e a `DATABASE_URL`.
